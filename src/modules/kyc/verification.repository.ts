import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type {
  AccountType,
  AmlStatus,
  BusinessProfile,
  ContributionAuthorizationStatus,
  KycStatus,
  RiskOutcome,
  User,
  VerificationCase,
  VerificationEventSource,
  VerificationStatus,
  VerificationType,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AmlSummary } from '../../ports/kyc/kyc-provider.port';
import { type RiskState, type VerificationState } from './verification-status';

// All persistence for the verification domain. The service owns decisions; this class
// owns the rows, the transaction boundaries and the legacy projection, so a provider
// migration never reaches into the policy layer.
//
// Raw documents, selfies and full provider reports are never written here. Only status,
// feature and warning codes, AML aggregates and Inverge's own review decisions.

export type SubjectSnapshot = {
  user: Pick<
    User,
    | 'id'
    | 'email'
    | 'accountType'
    | 'kycStatus'
    | 'amlStatus'
    | 'kycProviderRef'
    | 'role'
    | 'bannedAt'
  >;
  business: BusinessProfile | null;
  individualCase: VerificationCase | null;
  businessCase: VerificationCase | null;
};

export type ApplyDecisionInput = {
  caseId: string;
  state: VerificationState;
  providerStatus: string | null;
  risk: RiskState;
  features: string[];
  reasonCodes: string[];
  amlSummary: AmlSummary | null;
  source: VerificationEventSource;
  eventType: string;
  eventReference: string | null;
  occurredAt: Date;
  nextReconcileAt: Date | null;
  decisionCode?: string | null;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
};

export type ApplyDecisionResult = {
  applied: boolean;
  duplicate: boolean;
  stale: boolean;
  regression: boolean;
  status: VerificationStatus;
  risk: RiskOutcome;
  eventId: string | null;
};

export type CaseListFilters = {
  statuses?: VerificationStatus[];
  risks?: RiskOutcome[];
  type?: VerificationType;
  requiresReview?: boolean;
  overdueReconcileBefore?: Date;
  cursor?: string;
  limit: number;
};

const TERMINAL_STATUSES: readonly VerificationStatus[] = [
  'APPROVED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
];

function legacyKycStatus(state: VerificationState): KycStatus {
  if (state === 'APPROVED') return 'VERIFIED';
  if (state === 'DECLINED') return 'REJECTED';
  return 'PENDING';
}

function legacyAmlStatus(risk: RiskState): AmlStatus | null {
  if (risk === 'CLEAR') return 'CLEAR';
  if (risk === 'REVIEW') return 'IN_REVIEW';
  if (risk === 'FLAGGED') return 'FLAGGED';
  return null;
}

function isTerminal(status: VerificationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function safeMetadata(
  input: ApplyDecisionInput,
): Prisma.InputJsonValue {
  return {
    decisionCode: input.decisionCode ?? null,
    features: input.features,
    reasonCodes: input.reasonCodes,
    source: input.source,
  };
}

@Injectable()
export class VerificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async loadSubject(userId: string): Promise<SubjectSnapshot | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        accountType: true,
        email: true,
        kycStatus: true,
        amlStatus: true,
        kycProviderRef: true,
        role: true,
        bannedAt: true,
        business: true,
      },
    });
    if (!user) return null;

    const [individualCase, businessCase] = await Promise.all([
      this.prisma.verificationCase.findFirst({
        where: { userId, type: 'INDIVIDUAL' },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.verificationCase.findFirst({
        where: { userId, type: 'BUSINESS' },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      user: {
        accountType: user.accountType,
        amlStatus: user.amlStatus,
        bannedAt: user.bannedAt,
        email: user.email,
        kycProviderRef: user.kycProviderRef,
        kycStatus: user.kycStatus,
        role: user.role,
        id: user.id,
      },      business: user.business,
      businessCase,
      individualCase,
    };
  }

  async countAttempts(input: {
    userId: string;
    type: VerificationType;
    since: Date;
  }): Promise<number> {
    return this.prisma.verificationCase.count({
      where: {
        userId: input.userId,
        type: input.type,
        createdAt: { gte: input.since },
      },
    });
  }

  async findCaseByProviderSession(
    providerSessionId: string,
  ): Promise<VerificationCase | null> {
    return this.prisma.verificationCase.findUnique({
      where: { providerSessionId },
    });
  }

  async findCaseById(caseId: string): Promise<VerificationCase | null> {
    return this.prisma.verificationCase.findUnique({ where: { id: caseId } });
  }

  /**
   * A browser redirect and a support lookup both resolve the session id; the case is the
   * only authoritative owner. Legacy sessions created before the case model fall back to
   * the stored user/business reference, so an in-flight account is not orphaned.
   */
  async resolveLegacyOwner(
    providerSessionId: string,
  ): Promise<{
    userId: string;
    type: VerificationType;
    businessId: string | null;
  } | null> {
    const business = await this.prisma.businessProfile.findFirst({
      where: { kybProviderRef: providerSessionId },
      select: { id: true, userId: true },
    });
    if (business) {
      return { businessId: business.id, type: 'BUSINESS', userId: business.userId };
    }
    const user = await this.prisma.user.findFirst({
      where: { kycProviderRef: providerSessionId },
      select: { id: true },
    });
    return user
      ? { businessId: null, type: 'INDIVIDUAL', userId: user.id }
      : null;
  }

  async createCase(input: {
    userId: string;
    businessId: string | null;
    type: VerificationType;
    provider: 'DIDIT' | 'STUB';
    providerSessionId: string;
    providerWorkflowId: string | null;
    providerStatus: string;
    purpose: string;
    attempt: number;
  }): Promise<VerificationCase> {
    return this.prisma.verificationCase.create({
      data: {
        attempt: input.attempt,
        businessId: input.businessId,
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        providerStatus: input.providerStatus,
        providerWorkflowId: input.providerWorkflowId,
        purpose: input.purpose,
        status: 'SESSION_CREATED',
        type: input.type,
        userId: input.userId,
      },
    });
  }

  async cancelActiveCases(input: {
    userId: string;
    type: VerificationType;
    reason: string;
  }): Promise<number> {
    const active: VerificationStatus[] = [
      'SESSION_CREATED',
      'AWAITING_USER',
      'SUBMITTED',
      'IN_REVIEW',
      'ACTION_REQUIRED',
      'ERROR',
    ];
    const result = await this.prisma.verificationCase.updateMany({
      where: {
        userId: input.userId,
        type: input.type,
        status: { in: active },
      },
      data: { lastErrorCode: input.reason, nextReconcileAt: null, status: 'CANCELLED' },
    });
    return result.count;
  }

  async appendCaseEvent(input: {
    caseId: string;
    eventType: string;
    previousStatus: VerificationStatus | null;
    newStatus: VerificationStatus | null;
    source: VerificationEventSource;
    eventReference: string | null;
    occurredAt: Date;
    actorId?: string | null;
    reasonCode?: string | null;
    metadata?: Prisma.InputJsonValue;
  }): Promise<{ id: string } | null> {
    try {
      return await this.prisma.verificationEvent.create({
        data: {
          actorId: input.actorId ?? null,
          caseId: input.caseId,
          eventType: input.eventType,
          metadata: input.metadata,
          newStatus: input.newStatus,
          occurredAt: input.occurredAt,
          previousStatus: input.previousStatus,
          providerEventReference: input.eventReference,
          reasonCode: input.reasonCode ?? null,
          source: input.source,
        },
        select: { id: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return null; // duplicate provider event: idempotent by unique reference
      }
      throw error;
    }
  }

  /**
   * Applies one provider decision. Status and risk are separate axes: a stale status is
   * not allowed to overwrite a newer one, but newer screening evidence still lands.
   */
  async applyDecision(input: ApplyDecisionInput): Promise<ApplyDecisionResult> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.verificationCase.findUnique({
        where: { id: input.caseId },
        include: {
          business: { select: { id: true, kybStatus: true, amlStatus: true } },
          user: { select: { id: true, kycStatus: true, amlStatus: true } },
        },
      });
      if (!current) {
        throw new Error(`Verification case ${input.caseId} not found`);
      }

      const skew = 5_000;
      const stale =
        current.lastProviderSyncAt !== null &&
        input.occurredAt.getTime() <
          current.lastProviderSyncAt.getTime() - skew;
      const regression =
        !stale &&
        current.status === 'APPROVED' &&
        input.state !== 'EXPIRED' &&
        input.state !== 'APPROVED';
      const applyStatus = !stale && !regression;

      const nextStatus: VerificationStatus = applyStatus
        ? (input.state as VerificationStatus)
        : current.status;
      const nextRisk: RiskOutcome = stale
        ? current.riskOutcome
        : input.risk === 'NOT_ASSESSED'
          ? current.riskOutcome
          : (input.risk as RiskOutcome);

      const requiresHumanReview =
        nextRisk === 'REVIEW' || nextRisk === 'FLAGGED' || nextStatus === 'ERROR';
      const statusChanged = nextStatus !== current.status;
      const riskChanged = nextRisk !== current.riskOutcome;

      const now = new Date();
      await tx.verificationCase.update({
        where: { id: current.id },
        data: {
          decidedAt:
            !isTerminal(current.status) && isTerminal(nextStatus) ? now : current.decidedAt,
          features: input.features.length > 0 ? input.features : current.features,
          lastErrorCode: input.lastErrorCode ?? null,
          lastErrorMessage: input.lastErrorMessage ?? null,
          lastProviderSyncAt: now,
          nextReconcileAt: isTerminal(nextStatus) ? null : input.nextReconcileAt,
          providerStatus: input.providerStatus,
          reconcileAttempts: 0,
          requiresHumanReview,
          riskOutcome: nextRisk,
          riskReasonCodes:
            input.reasonCodes.length > 0
              ? [...new Set([...current.riskReasonCodes, ...input.reasonCodes])]
              : current.riskReasonCodes,
          status: nextStatus,
          submittedAt: nextStatus === 'SUBMITTED' ? now : current.submittedAt,
        },
      });

      let eventId: string | null = null;
      if (statusChanged || riskChanged || input.eventReference) {
        const event = await tx.verificationEvent
          .create({
            data: {
              caseId: current.id,
              eventType: input.eventType,
              metadata: safeMetadata(input),
              newStatus: nextStatus,
              occurredAt: input.occurredAt,
              previousStatus: current.status,
              providerEventReference: input.eventReference,
              reasonCode: input.decisionCode ?? null,
              source: input.source,
            },
            select: { id: true },
          })
          .catch((error: unknown) => {
            if (
              error instanceof Prisma.PrismaClientKnownRequestError &&
              error.code === 'P2002'
            ) {
              return null;
            }
            throw error;
          });
        eventId = event?.id ?? null;
      }

      await this.projectLegacy(tx, {
        amlRisk: nextRisk,
        business: current.business,
        businessId: current.businessId,
        status: nextStatus,
        user: current.user,
        userId: current.userId,
        type: current.type,
      });

      if (input.amlSummary && riskChanged) {
        const amlStatus = legacyAmlStatus(input.risk);
        if (amlStatus) {
          await tx.amlScreening.create({
            data: {
              businessId: current.type === 'BUSINESS' ? current.businessId : null,
              datasets: input.amlSummary.datasets,
              providerRef: current.providerSessionId,
              raw: {
                source: input.source,
                totalHits: input.amlSummary.totalHits,
                topRiskScore: input.amlSummary.topRiskScore,
              },
              source: 'KYC_SESSION',
              status: amlStatus,
              topRiskScore: input.amlSummary.topRiskScore,
              totalHits: input.amlSummary.totalHits,
              userId: current.userId,
            },
          });
        }
      }

      return {
        applied: statusChanged || riskChanged,
        duplicate: eventId === null && input.eventReference !== null,
        regression,
        risk: nextRisk,
        stale,
        status: nextStatus,
        eventId,
      };
    });
  }

  /** Records why a provider call failed and schedules the next bounded retry. */
  async recordReconcileFailure(input: {
    caseId: string;
    attempts: number;
    errorCode: string;
    errorMessage: string;
    nextReconcileAt: Date | null;
    exhausted: boolean;
  }): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.verificationCase.update({
        where: { id: input.caseId },
        data: {
          lastErrorCode: input.errorCode,
          lastErrorMessage: input.errorMessage.slice(0, 500),
          nextReconcileAt: input.nextReconcileAt,
          reconcileAttempts: input.attempts,
          requiresHumanReview: input.exhausted ? true : undefined,
        },
      }),
      this.prisma.verificationEvent.create({
        data: {
          caseId: input.caseId,
          eventType: input.exhausted ? 'reconcile.exhausted' : 'reconcile.failed',
          metadata: { attempts: input.attempts, errorCode: input.errorCode },
          occurredAt: new Date(),
          source: 'RECONCILIATION',
        },
      }),
    ]);
  }

  async listReconcileCandidates(input: {
    now: Date;
    staleBefore: Date;
    take: number;
    maxAttempts: number;
  }): Promise<VerificationCase[]> {
    return this.prisma.verificationCase.findMany({
      where: {
        status: {
          in: ['SESSION_CREATED', 'AWAITING_USER', 'SUBMITTED', 'IN_REVIEW', 'ACTION_REQUIRED'],
        },
        reconcileAttempts: { lt: input.maxAttempts },
        OR: [
          { nextReconcileAt: { lte: input.now } },
          {
            nextReconcileAt: null,
            OR: [
              { lastProviderSyncAt: null },
              { lastProviderSyncAt: { lte: input.staleBefore } },
            ],
          },
        ],
      },
      orderBy: [{ nextReconcileAt: 'asc' }, { updatedAt: 'asc' }],
      take: input.take,
    });
  }

  async listCases(filters: CaseListFilters): Promise<{
    items: Array<
      VerificationCase & {
        user: { id: string; email: string | null; accountType: AccountType };
        business: { id: string; legalName: string } | null;
      }
    >;
    nextCursor: string | null;
  }> {
    const items = await this.prisma.verificationCase.findMany({
      where: {
        status: filters.statuses?.length ? { in: filters.statuses } : undefined,
        riskOutcome: filters.risks?.length ? { in: filters.risks } : undefined,
        type: filters.type,
        requiresHumanReview: filters.requiresReview,
      },
      include: {
        business: { select: { id: true, legalName: true } },
        user: { select: { accountType: true, email: true, id: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filters.limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    });
    const hasMore = items.length > filters.limit;
    const page = hasMore ? items.slice(0, filters.limit) : items;
    return {
      items: page,
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  async caseDetail(caseId: string) {
    return this.prisma.verificationCase.findUnique({
      where: { id: caseId },
      include: {
        business: {
          select: {
            country: true,
            id: true,
            legalName: true,
            registrationNumber: true,
          },
        },
        events: { orderBy: { createdAt: 'desc' }, take: 100 },
        user: {
          select: {
            accountType: true,
            amlStatus: true,
            email: true,
            id: true,
            kycStatus: true,
            role: true,
          },
        },
      },
    });
  }

  async queueCounts(input: { maxAttempts: number }) {
    const [byStatus, reviewOpen, escalated, providerErrors] = await Promise.all([
      this.prisma.verificationCase.groupBy({
        by: ['status'],
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.verificationCase.count({
        where: { requiresHumanReview: true },
      }),
      this.prisma.verificationCase.count({
        where: {
          lastErrorCode: 'RECONCILIATION_EXHAUSTED',
        },
      }),
      this.prisma.verificationCase.count({
        where: { status: 'ERROR' },
      }),
    ]);
    return {
      byStatus: byStatus.map((row) => ({
        count: row._count._all,
        status: row.status,
      })),
      escalated,
      providerErrors,
      reviewOpen,
    };
  }

  async sumReservedAuthorizations(input: {
    userId: string;
    now: Date;
  }): Promise<Prisma.Decimal> {
    const result = await this.prisma.contributionAuthorization.aggregate({
      _sum: { amountUsd: true },
      where: {
        expiresAt: { gt: input.now },
        status: 'ALLOWED',
        userId: input.userId,
      },
    });
    return result._sum.amountUsd ?? new Prisma.Decimal(0);
  }

  async sumContributions(userId: string): Promise<Prisma.Decimal> {
    const result = await this.prisma.contribution.aggregate({
      _sum: { amount: true },
      where: { userId },
    });
    return result._sum.amount ?? new Prisma.Decimal(0);
  }

  /**
   * Reserves an amount against the cumulative backer threshold. A transaction-scoped
   * advisory lock serialises concurrent requests for one user, so two requests cannot
   * both observe the same headroom. The lock is scoped by user id, not campaign.
   */
  async reserveContributionAuthorization(input: {
    userId: string;
    campaignId: string;
    amountUsd: number;
    thresholdUsd: number;
    fundsCleared: boolean;
    expiresAt: Date;
  }): Promise<{
    authorization: {
      id: string;
      status: ContributionAuthorizationStatus;
      verificationRequired: boolean;
      cumulativeUsd: string;
    };
    blocked: boolean;
    cumulativeUsd: number;
    verificationRequired: boolean;
  }> {
    return this.prisma.$transaction(async (tx) => {
      // Prisma cannot deserialise the `void` this function returns; the cast keeps the
      // lock and gives the driver a value it can decode.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${input.userId})::bigint)::text`;
      const now = new Date();

      const [contributions, reserved] = await Promise.all([
        tx.contribution.aggregate({
          _sum: { amount: true },
          where: { userId: input.userId },
        }),
        tx.contributionAuthorization.aggregate({
          _sum: { amountUsd: true },
          where: {
            expiresAt: { gt: now },
            status: 'ALLOWED',
            userId: input.userId,
          },
        }),
      ]);

      const cumulative =
        Number(contributions._sum.amount ?? 0) + Number(reserved._sum.amountUsd ?? 0);
      // FR-104: the pledge that crosses the threshold is the one that must be verified.
      const verificationRequired =
        cumulative + input.amountUsd > input.thresholdUsd;
      const blocked = verificationRequired && !input.fundsCleared;

      const authorization = await tx.contributionAuthorization.create({
        data: {
          amountUsd: new Prisma.Decimal(input.amountUsd),
          blockedReason: blocked ? 'CONTRIBUTION_THRESHOLD_EXCEEDED' : null,
          campaignId: input.campaignId,
          cumulativeUsd: new Prisma.Decimal(cumulative),
          expiresAt: input.expiresAt,
          status: blocked ? 'BLOCKED' : 'ALLOWED',
          thresholdUsd: new Prisma.Decimal(input.thresholdUsd),
          userId: input.userId,
          verificationRequired,
        },
        select: {
          cumulativeUsd: true,
          id: true,
          status: true,
          verificationRequired: true,
        },
      });

      return {
        authorization: {
          cumulativeUsd: authorization.cumulativeUsd.toFixed(2),
          id: authorization.id,
          status: authorization.status,
          verificationRequired: authorization.verificationRequired,
        },
        blocked,
        cumulativeUsd: cumulative,
        verificationRequired,
      };
    });
  }

  /**
   * Reviewer resolution. A human alone changes a risk outcome; nothing here flips the
   * identity decision. Every action appends an ADMIN_ACTION event with the reason.
   */
  async resolveRisk(input: {
    caseId: string;
    actorId: string;
    decision: 'CLEAR' | 'CONFIRM_MATCH';
    reasonCode: string;
    reason: string;
    occurredAt: Date;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.verificationCase.findUnique({
        where: { id: input.caseId },
        include: {
          business: { select: { id: true } },
          user: { select: { id: true } },
        },
      });
      if (!current) return null;

      const risk: RiskOutcome = input.decision === 'CLEAR' ? 'CLEAR' : 'FLAGGED';
      await tx.verificationCase.update({
        where: { id: current.id },
        data: {
          requiresHumanReview: false,
          riskOutcome: risk,
          riskReasonCodes: [...new Set([...current.riskReasonCodes, input.reasonCode])],
        },
      });

      if (current.type === 'BUSINESS' && current.businessId) {
        await tx.businessProfile.update({
          where: { id: current.businessId },
          data: {
            amlScreenedAt: input.occurredAt,
            amlStatus: risk === 'CLEAR' ? 'CLEAR' : 'FLAGGED',
          },
        });
      } else {
        await tx.user.update({
          where: { id: current.userId },
          data: {
            amlScreenedAt: input.occurredAt,
            amlStatus: risk === 'CLEAR' ? 'CLEAR' : 'FLAGGED',
          },
        });
      }

      const event = await tx.verificationEvent.create({
        data: {
          actorId: input.actorId,
          caseId: current.id,
          eventType: 'risk.resolved',
          metadata: {
            decision: input.decision,
            reason: input.reason.slice(0, 500),
          },
          newStatus: current.status,
          occurredAt: input.occurredAt,
          previousStatus: current.status,
          reasonCode: input.reasonCode,
          source: 'ADMIN_ACTION',
        },
        select: { id: true },
      });

      return { caseId: current.id, eventId: event.id, risk };
    });
  }

  private async projectLegacy(
    tx: Prisma.TransactionClient,
    input: {
      type: VerificationType;
      status: VerificationStatus;
      amlRisk: RiskOutcome;
      user: { id: string; kycStatus: KycStatus; amlStatus: AmlStatus };
      business: { id: string; kybStatus: KycStatus; amlStatus: AmlStatus } | null;
      businessId: string | null;
      userId: string;
    },
  ): Promise<void> {
    const kycNext = legacyKycStatus(input.status as VerificationState);
    const amlNext = legacyAmlStatus(input.amlRisk as RiskState);

    if (input.type === 'BUSINESS' && input.business) {
      const changed = input.business.kybStatus !== kycNext;
      await tx.businessProfile.update({
        where: { id: input.business.id },
        data: {
          amlStatus: amlNext ?? input.business.amlStatus,
          kybStatus: kycNext,
        },
      });
      if (changed) {
        await tx.kycStatusEvent.create({
          data: {
            businessId: input.business.id,
            fromStatus: input.business.kybStatus,
            toStatus: kycNext,
            userId: input.userId,
          },
        });
      }
      return;
    }

    const changed = input.user.kycStatus !== kycNext;
    await tx.user.update({
      where: { id: input.user.id },
      data: {
        amlStatus: amlNext ?? input.user.amlStatus,
        amlScreenedAt: amlNext ? new Date() : undefined,
        kycStatus: kycNext,
      },
    });
    if (changed) {
      await tx.kycStatusEvent.create({
        data: {
          fromStatus: input.user.kycStatus,
          toStatus: kycNext,
          userId: input.user.id,
        },
      });
    }
  }
}
