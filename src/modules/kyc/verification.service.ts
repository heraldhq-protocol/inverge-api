import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { Env } from '../../config/env.validation';
import { WebhookInboxService } from '../../common/webhooks/webhook-inbox.service';
import {
  KYC_PROVIDER_PORT,
  KycDecision,
  KycProviderPort,
  KycPurpose,
  KycWebhookEvent,
} from '../../ports/kyc/kyc-provider.port';
import type {
  AccountType,
  VerificationCase,
  VerificationStatus,
  VerificationType,
} from '../../generated/prisma/client';
import {
  evaluateIdentityOnly,
  evaluateVerification,
  type CaseFacts,
  type VerificationFacts,
  type VerificationNextAction,
  type VerificationPolicyOptions,
  type VerificationRequirement,
} from './verification-policy';
import {
  buildFacts,
  overallState,
  riskFromDecision,
} from './verification-facts';
import {
  isTerminalState,
  mapDiditStatus,
  riskFromAml,
  type RiskState,
  type VerificationState,
  stateLabel,
} from './verification-status';
import { verificationFailure, type VerificationErrorCode } from './verification-errors';
import {
  isReconcileExhausted,
  reconcileDelayMs,
  RECONCILE_BASE_DELAY_MS,
  RECONCILE_MAX_DELAY_MS,
} from './verification-backoff';
import { JOBS_QUEUE, JOB_NAMES } from '../../common/queue/job-names';
import type { VerificationWebhookJob } from './verification.queue';
import {
  VerificationRepository,
  type SubjectSnapshot,
} from './verification.repository';

// The verification domain. It owns session creation, the authoritative decision sync,
// reconciliation and the campaign/contribution gates. Everything user-facing is decided
// from persisted state; a browser redirect, query parameter or webhook body alone never
// grants eligibility.

export interface StartVerificationInput {
  purpose?: KycPurpose;
  subject?: VerificationType;
}

export interface StartBusinessInput {
  legalName: string;
  registrationNumber?: string;
  country?: string;
  businessType?: string;
  registeredAddress?: string;
  representativeName?: string;
  representativeRole?: string;
}

export interface VerificationCaseView {
  id: string;
  type: VerificationType;
  status: VerificationStatus;
  statusLabel: string;
  providerStatus: string | null;
  risk: RiskState;
  requiresHumanReview: boolean;
  attempt: number;
  submittedAt: Date | null;
  decidedAt: Date | null;
  lastProviderSyncAt: Date | null;
  nextReconcileAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
}

export interface VerificationStateView {
  accountType: AccountType;
  overall: VerificationState;
  overallLabel: string;
  individual: VerificationCaseView | null;
  business: VerificationCaseView | null;
  requirements: VerificationRequirement[];
  blockers: string[];
  nextAction: VerificationNextAction;
  policyVersion: string;
  identityVerified: boolean;
  fundsCleared: boolean;
  complianceHold: boolean;
  businessRegistered: boolean;
  canStartSession: boolean;
  nextSubject: VerificationType | null;
  lastErrorCode: string | null;
}

export interface CampaignVerificationGate {
  eligible: boolean;
  code: VerificationErrorCode | null;
  blockers: string[];
  accountType: AccountType;
  complianceHold: boolean;
  policyVersion: string;
}

function caseView(row: VerificationCase | null): VerificationCaseView | null {
  if (!row) return null;
  return {
    attempt: row.attempt,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    id: row.id,
    lastErrorCode: row.lastErrorCode,
    lastProviderSyncAt: row.lastProviderSyncAt,
    nextReconcileAt: row.nextReconcileAt,
    providerStatus: row.providerStatus,
    requiresHumanReview: row.requiresHumanReview,
    risk: row.riskOutcome as RiskState,
    status: row.status,
    statusLabel: stateLabel(row.status as VerificationState),
    submittedAt: row.submittedAt,
    type: row.type,
  };
}

function stateFromDecision(decision: KycDecision): {
  state: VerificationState;
  providerStatus: string | null;
} {
  if (decision.providerStatus) {
    const mapped = mapDiditStatus(decision.providerStatus);
    if (mapped.providerStatus) return { state: mapped.state, providerStatus: mapped.providerStatus };
  }
  switch (decision.status) {
    case 'VERIFIED':
      return { providerStatus: decision.providerStatus ?? null, state: 'APPROVED' };
    case 'REJECTED':
      return { providerStatus: decision.providerStatus ?? null, state: 'DECLINED' };
    case 'IN_REVIEW':
      return { providerStatus: decision.providerStatus ?? null, state: 'IN_REVIEW' };
    default:
      return { providerStatus: decision.providerStatus ?? null, state: 'AWAITING_USER' };
  }
}

function stateFromWebhook(event: KycWebhookEvent): {
  state: VerificationState;
  providerStatus: string | null;
} {
  if (event.providerStatus) {
    const mapped = mapDiditStatus(event.providerStatus);
    if (mapped.providerStatus) {
      return { providerStatus: mapped.providerStatus, state: mapped.state };
    }
  }
  switch (event.status) {
    case 'VERIFIED':
      return { providerStatus: event.providerStatus, state: 'APPROVED' };
    case 'REJECTED':
      return { providerStatus: event.providerStatus, state: 'DECLINED' };
    case 'IN_REVIEW':
      return { providerStatus: event.providerStatus, state: 'IN_REVIEW' };
    default:
      return { providerStatus: event.providerStatus, state: 'AWAITING_USER' };
  }
}

@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);

  constructor(
    private readonly repo: VerificationRepository,
    private readonly prisma: PrismaService,
    @Inject(KYC_PROVIDER_PORT) private readonly provider: KycProviderPort,
    private readonly config: ConfigService<Env, true>,
    @Optional() private readonly inbox?: WebhookInboxService,
    @Optional()
    @InjectQueue(JOBS_QUEUE)
    private readonly webhookQueue?: Queue<VerificationWebhookJob>,
  ) {}

  // ── reads ──────────────────────────────────────────────────────────────────────

  async state(userId: string): Promise<VerificationStateView> {
    const snapshot = await this.requireSubject(userId);
    return this.stateFromSnapshot(snapshot);
  }

  async eligibility(userId: string, purpose: KycPurpose) {
    const snapshot = await this.requireSubject(userId);
    const facts = this.factsFrom(snapshot);
    const evaluation =
      purpose === 'IDEA_VALIDATION'
        ? evaluateIdentityOnly(facts, this.policyVersion())
        : evaluateVerification(facts, this.policyOptions());
    const complianceHold = this.complianceHold(snapshot);
    const failure = verificationFailure(facts, evaluation, { complianceHold });
    return {
      accountType: facts.accountType,
      blockers: failure?.blockers ?? [],
      code: failure?.code ?? null,
      eligible: failure === null,
      nextAction: evaluation.nextAction,
      policyVersion: evaluation.policyVersion,
      purpose,
      requirements: evaluation.requirements,
      state: overallState(facts),
    };
  }

  async legacyStatus(userId: string) {
    const state = await this.state(userId);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { amlScreenedAt: true, amlStatus: true },
    });
    return {
      accountType: state.accountType,
      amlScreenedAt: user?.amlScreenedAt ?? null,
      amlStatus: user?.amlStatus ?? 'NOT_SCREENED',
      // Kept for pre-verification-domain clients: the legacy pair is a projection only.
      identityVerified: state.identityVerified,
      kycStatus: state.identityVerified
        ? 'VERIFIED'
        : state.overall === 'DECLINED'
          ? 'REJECTED'
          : 'PENDING',
      overall: state.overall,
      overallLabel: state.overallLabel,
      policyVersion: state.policyVersion,
      updatedAt: new Date().toISOString(),
      verification: state,
    };
  }

  // ── session creation ────────────────────────────────────────────────────────────

  async startSession(userId: string, input: StartVerificationInput = {}) {
    const snapshot = await this.requireSubject(userId);
    const subject: VerificationType =
      input.subject ??
      (snapshot.user.accountType === 'BUSINESS' &&
      input.purpose === 'BUSINESS_VERIFICATION'
        ? 'BUSINESS'
        : 'INDIVIDUAL');

    if (subject === 'BUSINESS' && snapshot.user.accountType !== 'BUSINESS') {
      throw new ConflictException({
        blockers: ['Choose a business account before starting business verification'],
        code: 'VERIFICATION_ACCOUNT_TYPE_MISMATCH' satisfies VerificationErrorCode,
        message: 'This account is not a business account',
      });
    }
    if (subject === 'BUSINESS' && !snapshot.business) {
      throw new BadRequestException({
        blockers: ['Add your registered business details first'],
        code: 'VERIFICATION_BUSINESS_PROFILE_REQUIRED' satisfies VerificationErrorCode,
        message: 'Business profile is required before verification',
      });
    }

    const purpose: KycPurpose =
      subject === 'BUSINESS'
        ? 'BUSINESS_VERIFICATION'
        : (input.purpose ?? 'CAMPAIGN_CREATOR');

    const attempts = await this.repo.countAttempts({
      since: this.startOfUtcDay(),
      type: subject,
      userId,
    });
    if (attempts >= this.maxAttemptsPerDay()) {
      throw new ConflictException({
        blockers: ['Too many verification attempts today. Contact support if you are stuck.'],
        code: 'VERIFICATION_ATTEMPTS_EXCEEDED' satisfies VerificationErrorCode,
        message: 'Verification attempt limit reached',
      });
    }

    // A repeated click replaces an unfinished session rather than stacking cases. The
    // replaced case stays auditable and is never treated as an approval.
    await this.repo.cancelActiveCases({
      reason: 'REPLACED_BY_NEW_SESSION',
      type: subject,
      userId,
    });

    const business = subject === 'BUSINESS' ? snapshot.business : null;
    let started;
    try {
      started = await this.provider.startVerification({
        business: business
          ? {
              businessType: business.businessType ?? undefined,
              country: business.country ?? undefined,
              legalName: business.legalName,
              registrationNumber: business.registrationNumber ?? undefined,
            }
          : undefined,
        callbackUrl: this.config.get('DIDIT_CALLBACK_URL', { infer: true }),
        purpose,
        vendorData: business ? business.id : userId,
        email: snapshot.user.email ?? undefined,
      });
    } catch (error) {
      this.logger.error(
        `Provider session creation failed for ${subject}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      throw new ServiceUnavailableException({
        code: 'VERIFICATION_UNAVAILABLE' satisfies VerificationErrorCode,
        message: 'Verification is temporarily unavailable. Try again shortly.',
      });
    }

    const created = await this.repo.createCase({
      attempt: attempts + 1,
      businessId: business?.id ?? null,
      provider: this.providerName(),
      providerSessionId: started.providerRef,
      providerStatus: 'Not Started',
      providerWorkflowId: started.workflowId ?? null,
      purpose,
      type: subject,
      userId,
    });
    await this.repo.appendCaseEvent({
      caseId: created.id,
      eventReference: null,
      eventType: 'case.created',
      newStatus: created.status,
      occurredAt: new Date(),
      previousStatus: null,
      source: 'SYSTEM',
    });

    return {
      accountType: snapshot.user.accountType,
      attempt: created.attempt,
      caseId: created.id,
      providerRef: started.providerRef,
      purpose,
      subject,
      verificationUrl: started.verificationUrl,
    };
  }

  async startBusinessSession(userId: string, input: StartBusinessInput) {
    await this.prisma.businessProfile.upsert({
      where: { userId },
      create: {
        businessType: input.businessType ?? null,
        country: input.country ?? null,
        legalName: input.legalName,
        registeredAddress: input.registeredAddress ?? null,
        registrationNumber: input.registrationNumber ?? null,
        representativeName: input.representativeName ?? null,
        representativeRole: input.representativeRole ?? null,
        userId,
      },
      update: {
        businessType: input.businessType ?? null,
        country: input.country ?? null,
        legalName: input.legalName,
        registeredAddress: input.registeredAddress ?? null,
        registrationNumber: input.registrationNumber ?? null,
        representativeName: input.representativeName ?? null,
        representativeRole: input.representativeRole ?? null,
      },
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: { accountType: 'BUSINESS' },
    });
    const started = await this.startSession(userId, {
      purpose: 'BUSINESS_VERIFICATION',
      subject: 'BUSINESS',
    });
    const business = await this.prisma.businessProfile.findUniqueOrThrow({
      where: { userId },
      select: { id: true },
    });
    return { ...started, businessId: business.id };
  }

  async setAccountType(userId: string, accountType: AccountType) {
    const snapshot = await this.requireSubject(userId);
    if (snapshot.user.accountType === accountType) {
      return this.state(userId);
    }
    // Switching to a business account cannot inherit an individual approval, and
    // switching back cannot inherit a business one. Cases stay attached to their type.
    await this.prisma.user.update({
      where: { id: userId },
      data: { accountType },
    });
    return this.state(userId);
  }

  async businessStatus(userId: string) {
    const business = await this.prisma.businessProfile.findUnique({ where: { userId } });
    const state = await this.state(userId);
    if (!business) return { registered: false as const, verification: state };
    return {
      accountType: state.accountType,
      amlScreenedAt: business.amlScreenedAt,
      amlStatus: business.amlStatus,
      businessType: business.businessType,
      country: business.country,
      kybStatus: business.kybStatus,
      legalName: business.legalName,
      registered: true as const,
      registrationNumber: business.registrationNumber,
      representativeName: business.representativeName,
      representativeRole: business.representativeRole,
      verification: state,
    };
  }

  // ── webhooks ────────────────────────────────────────────────────────────────────

  async handleWebhook(rawBody: string, headers: Record<string, string | undefined>) {
    const event = this.provider.parseWebhook(rawBody, headers);
    if (!event) {
      throw new BadRequestException('Invalid or unverifiable webhook');
    }

    const resolved = await this.resolveCaseForEvent(event);
    if (!resolved) {
      this.logger.warn(`Webhook for unknown session ${event.providerRef} — acknowledged and ignored`);
      return { ignored: true };
    }

    const dedupeKey = event.eventId
      ? `DIDIT:${event.eventId}`
      : `DIDIT:${event.providerRef}:${event.status}:${event.aml ?? 'NONE'}:${
          event.occurredAt?.toISOString() ?? 'unknown'
        }`;

    const apply = async () => {
      if (this.webhookQueue) {
        await this.webhookQueue.add(
          JOB_NAMES.verificationWebhook,
          {
            caseId: resolved.id,
            eventId: event.eventId,
            fallbackAml: event.aml,
            fallbackProviderStatus: event.providerStatus,
            occurredAtIso: (event.occurredAt ?? new Date()).toISOString(),
            payloadAuthenticated: event.payloadAuthenticated,
            providerRef: event.providerRef,
          },
          {
            attempts: 3,
            backoff: { delay: 5_000, type: 'exponential' },
            jobId: event.eventId ? `wh:${event.eventId}` : undefined,
            removeOnComplete: true,
            removeOnFail: 100,
          },
        );
        return { accepted: true, queued: true };
      }
      // No queue on this instance (tests, a web-only replica): apply inline. The inbox
      // still guarantees at-most-once application for a duplicate delivery.
      return this.applyEvent(resolved.id, event);
    };

    if (!this.inbox) return apply();
    return this.inbox.run(
      {
        dedupeKey,
        eventType: event.webhookType ?? event.status,
        provider: 'DIDIT',
        rawBody,
      },
      apply,
    );
  }

  async processWebhookJob(job: VerificationWebhookJob) {
    const decision = await this.provider
      .getDecision(job.providerRef)
      .catch((error: unknown) => {
        this.logger.warn(
          `getDecision(${job.providerRef}) failed during webhook apply: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
        return null;
      });

    if (decision) {
      return this.applyDecision(job.caseId, decision, {
        eventReference: job.eventId,
        eventType: 'status.updated',
        occurredAt: new Date(job.occurredAtIso),
        source: 'PROVIDER_WEBHOOK',
      });
    }

    // The provider-signed body is a weaker but usable fallback; an unauthenticated body
    // is not, and the case is left for reconciliation instead.
    if (!job.payloadAuthenticated) {
      await this.recordWebhookFailure(job, 'WEBHOOK_UNVERIFIED');
      return { applied: false, reason: 'unverified_payload' };
    }
    const state = job.fallbackProviderStatus
      ? mapDiditStatus(job.fallbackProviderStatus)
      : null;
    if (!state?.providerStatus) {
      await this.recordWebhookFailure(job, 'DECISION_UNAVAILABLE');
      return { applied: false, reason: 'decision_unavailable' };
    }
    return this.repo.applyDecision({
      amlSummary: null,
      caseId: job.caseId,
      decisionCode: 'DECISION_FETCH_FAILED',
      eventReference: job.eventId,
      eventType: 'status.updated',
      features: [],
      lastErrorCode: 'DECISION_FETCH_FAILED',
      lastErrorMessage: 'Authoritative decision unavailable; used signed webhook status',
      nextReconcileAt: this.nextReconcileAt(),
      occurredAt: new Date(job.occurredAtIso),
      providerStatus: state.providerStatus,
      reasonCodes: [],
      risk: riskFromAml(job.fallbackAml),
      source: 'PROVIDER_WEBHOOK',
      state: state.state,
    });
  }

  private async applyEvent(caseId: string, event: KycWebhookEvent) {
    const decision = await this.provider
      .getDecision(event.providerRef)
      .catch((error: unknown) => {
        this.logger.warn(
          `getDecision(${event.providerRef}) failed: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
        return null;
      });
    if (decision) {
      return this.applyDecision(caseId, decision, {
        eventReference: event.eventId,
        eventType: event.webhookType ?? 'status.updated',
        occurredAt: event.occurredAt ?? new Date(),
        source: 'PROVIDER_WEBHOOK',
      });
    }
    if (!event.payloadAuthenticated) {
      throw new BadRequestException('Webhook payload could not be authenticated');
    }
    const mapped = stateFromWebhook(event);
    return this.repo.applyDecision({
      amlSummary: null,
      caseId,
      decisionCode: 'DECISION_FETCH_FAILED',
      eventReference: event.eventId,
      eventType: event.webhookType ?? 'status.updated',
      features: [],
      lastErrorCode: 'DECISION_FETCH_FAILED',
      lastErrorMessage: 'Authoritative decision unavailable; used signed webhook status',
      nextReconcileAt: this.nextReconcileAt(),
      occurredAt: event.occurredAt ?? new Date(),
      providerStatus: mapped.providerStatus,
      reasonCodes: [],
      risk: riskFromAml(event.aml),
      source: 'PROVIDER_WEBHOOK',
      state: mapped.state,
    });
  }

  private async applyDecision(
    caseId: string,
    decision: KycDecision,
    meta: {
      eventReference: string | null;
      eventType: string;
      occurredAt: Date;
      source: 'PROVIDER_WEBHOOK' | 'RECONCILIATION';
    },
  ) {
    const mapped = stateFromDecision(decision);
    return this.repo.applyDecision({
      amlSummary: decision.amlSummary,
      caseId,
      decisionCode: decision.warningCodes[0] ?? null,
      eventReference: meta.eventReference,
      eventType: meta.eventType,
      features: decision.features,
      nextReconcileAt: this.nextReconcileAt(),
      occurredAt: meta.occurredAt,
      providerStatus: mapped.providerStatus,
      reasonCodes: decision.warningCodes,
      risk: riskFromDecision(decision.aml),
      source: meta.source,
      state: mapped.state,
    });
  }

  private async resolveCaseForEvent(
    event: KycWebhookEvent,
  ): Promise<VerificationCase | null> {
    const existing = await this.repo.findCaseByProviderSession(event.providerRef);
    if (existing) return existing;

    // Sessions created before the case model are attached now, so an in-flight account is
    // still reconciled. The legacy owner is resolved from the persisted reference only.
    const owner = await this.repo.resolveLegacyOwner(event.providerRef);
    if (!owner) return null;
    const mapped = stateFromWebhook(event);
    const created = await this.repo.createCase({
      attempt: 1,
      businessId: owner.businessId,
      provider: this.providerName(),
      providerSessionId: event.providerRef,
      providerStatus: mapped.providerStatus ?? 'In Progress',
      providerWorkflowId: null,
      purpose: owner.type === 'BUSINESS' ? 'BUSINESS_VERIFICATION' : 'CAMPAIGN_CREATOR',
      type: owner.type,
      userId: owner.userId,
    });
    await this.repo.appendCaseEvent({
      caseId: created.id,
      eventReference: null,
      eventType: 'case.attached_legacy',
      newStatus: created.status,
      occurredAt: new Date(),
      previousStatus: null,
      source: 'SYSTEM',
    });
    return created;
  }

  private async recordWebhookFailure(job: VerificationWebhookJob, code: string) {
    const current = await this.repo.findCaseById(job.caseId);
    if (!current) return;
    await this.repo.recordReconcileFailure({
      attempts: current.reconcileAttempts,
      caseId: job.caseId,
      errorCode: code,
      errorMessage: 'Webhook could not be applied; reconciliation will retry',
      exhausted: false,
      nextReconcileAt: this.nextReconcileAt(),
    });
  }

  // ── reconciliation ──────────────────────────────────────────────────────────────

  /**
   * Sweeps cases whose provider state is not terminal and either missed its webhook or
   * has not synced recently. Bounded batch, bounded attempts, jittered backoff. After
   * the final attempt the case is escalated to a human, not retried forever.
   */
  async reconcileDue(limit?: number) {
    const batch =
      limit ?? this.config.get('VERIFICATION_RECONCILE_BATCH', { infer: true }) ?? 25;
    const maxAttempts = this.maxReconcileAttempts();
    const now = new Date();
    const staleBefore = new Date(
      now.getTime() -
        this.config.get('VERIFICATION_RECONCILE_AFTER_MINUTES', { infer: true }) *
          60_000,
    );

    const candidates = await this.repo.listReconcileCandidates({
      maxAttempts,
      now,
      staleBefore,
      take: batch,
    });

    let applied = 0;
    let failed = 0;
    let escalated = 0;

    for (const candidate of candidates) {
      try {
        const decision = await this.provider.getDecision(candidate.providerSessionId);
        const result = await this.applyDecision(candidate.id, decision, {
          eventReference: null,
          eventType: 'reconciled',
          occurredAt: new Date(),
          source: 'RECONCILIATION',
        });
        if (result.applied) applied += 1;
      } catch (error) {
        failed += 1;
        const attempts = candidate.reconcileAttempts + 1;
        const exhausted = isReconcileExhausted(attempts, maxAttempts);
        if (exhausted) escalated += 1;
        await this.repo.recordReconcileFailure({
          attempts,
          caseId: candidate.id,
          errorCode: exhausted ? 'RECONCILIATION_EXHAUSTED' : 'PROVIDER_UNAVAILABLE',
          errorMessage:
            error instanceof Error ? error.message : 'Provider decision unavailable',
          exhausted,
          nextReconcileAt: exhausted
            ? null
            : new Date(
                Date.now() +
                  reconcileDelayMs({
                    attempts,
                    baseMs: RECONCILE_BASE_DELAY_MS,
                    maxMs: RECONCILE_MAX_DELAY_MS,
                    random: Math.random,
                  }),
              ),
        });
      }
    }

    if (failed > 0 || escalated > 0) {
      this.logger.warn(
        `Verification reconcile: examined=${candidates.length} applied=${applied} failed=${failed} escalated=${escalated}`,
      );
    }
    return { applied, escalated, examined: candidates.length, failed };
  }

  // ── gates ───────────────────────────────────────────────────────────────────────

  async campaignGate(userId: string): Promise<CampaignVerificationGate> {
    const snapshot = await this.requireSubject(userId);
    const facts = this.factsFrom(snapshot);
    const evaluation = evaluateVerification(facts, this.policyOptions());
    const complianceHold = this.complianceHold(snapshot);
    const failure = verificationFailure(facts, evaluation, { complianceHold });
    return {
      accountType: facts.accountType,
      blockers: failure?.blockers ?? [],
      code: failure?.code ?? null,
      complianceHold,
      eligible: failure === null,
      policyVersion: evaluation.policyVersion,
    };
  }

  async assertCampaignCreatorEligible(userId: string): Promise<void> {
    const gate = await this.campaignGate(userId);
    if (!gate.eligible) {
      throw new ForbiddenException({
        blockers: gate.blockers,
        code: gate.code,
        message: 'Campaign submission requires completed verification',
      });
    }
  }

  async assertFundsEligible(userId: string): Promise<void> {
    await this.assertCampaignCreatorEligible(userId);
  }

  /**
   * FR-104. Below the threshold, no verification; the pledge that crosses it must be
   * funds-cleared. The reservation is serialised per user so two concurrent pledges
   * cannot both sit under the limit.
   */
  async authorizeContribution(userId: string, campaignId: string, amountUsd: number) {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 100_000_000) {
      throw new BadRequestException('amountUsd must be a positive amount');
    }
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, status: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.status !== 'ACTIVE') {
      throw new ConflictException({
        code: 'CONTRIBUTION_CAMPAIGN_NOT_FUNDABLE' satisfies VerificationErrorCode,
        message: 'This campaign is not accepting contributions',
      });
    }

    const snapshot = await this.requireSubject(userId);
    const facts = this.factsFrom(snapshot);
    const evaluation = evaluateVerification(facts, this.policyOptions());
    const fundsCleared =
      evaluation.eligible && !this.complianceHold(snapshot);

    const result = await this.repo.reserveContributionAuthorization({
      amountUsd,
      campaignId,
      expiresAt: new Date(
        Date.now() +
          this.config.get('VERIFICATION_AUTHORIZATION_TTL_SECONDS', { infer: true }) *
            1000,
      ),
      fundsCleared,
      thresholdUsd: await this.backerThresholdUsd(),
      userId,
    });

    if (result.blocked) {
      throw new ForbiddenException({
        blockers: [
          'This contribution would exceed the unverified backer limit',
          ...evaluation.blockers,
        ],
        code: 'CONTRIBUTION_THRESHOLD_EXCEEDED' satisfies VerificationErrorCode,
        message: 'Verify your identity to contribute above the threshold',
      });
    }

    return {
      amountUsd,
      authorizationId: result.authorization.id,
      cumulativeUsd: result.cumulativeUsd,
      expiresInSeconds: this.config.get(
        'VERIFICATION_AUTHORIZATION_TTL_SECONDS',
        { infer: true },
      ) ?? 900,
      status: result.authorization.status,
      verificationRequired: result.verificationRequired,
    };
  }

  async backerThresholdUsd(): Promise<number> {
    const row = await this.prisma.platformParam.findUnique({
      where: { key: 'kyc.backerThresholdUSD' },
    });
    const value = row?.value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { value?: unknown }).value === 'number'
    ) {
      return (value as { value: number }).value;
    }
    return 200;
  }

  // ── admin / compliance ──────────────────────────────────────────────────────────

  async adminListCases(input: {
    statuses?: VerificationStatus[];
    risks?: Array<'NOT_ASSESSED' | 'CLEAR' | 'REVIEW' | 'FLAGGED'>;
    type?: VerificationType;
    requiresReview?: boolean;
    cursor?: string;
    limit?: number;
  }) {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const page = await this.repo.listCases({
      cursor: input.cursor,
      limit,
      requiresReview: input.requiresReview,
      risks: input.risks,
      statuses: input.statuses,
      type: input.type,
    });
    return {
      items: page.items.map((row) => ({
        accountType: row.user.accountType,
        businessName: row.business?.legalName ?? null,
        createdAt: row.createdAt,
        id: row.id,
        lastErrorCode: row.lastErrorCode,
        providerStatus: row.providerStatus,
        requiresHumanReview: row.requiresHumanReview,
        risk: row.riskOutcome,
        status: row.status,
        type: row.type,
        updatedAt: row.updatedAt,
        user: { email: row.user.email, id: row.user.id },
      })),
      nextCursor: page.nextCursor,
    };
  }

  async adminCaseDetail(caseId: string) {
    const row = await this.repo.caseDetail(caseId);
    if (!row) throw new NotFoundException('Verification case not found');
    return {
      business: row.business,
      case: {
        attempt: row.attempt,
        createdAt: row.createdAt,
        decidedAt: row.decidedAt,
        features: row.features,
        id: row.id,
        lastErrorCode: row.lastErrorCode,
        lastErrorMessage: row.lastErrorMessage,
        lastProviderSyncAt: row.lastProviderSyncAt,
        nextReconcileAt: row.nextReconcileAt,
        provider: row.provider,
        providerSessionId: row.providerSessionId,
        providerStatus: row.providerStatus,
        purpose: row.purpose,
        reconcileAttempts: row.reconcileAttempts,
        requiresHumanReview: row.requiresHumanReview,
        riskOutcome: row.riskOutcome,
        riskReasonCodes: row.riskReasonCodes,
        status: row.status,
        submittedAt: row.submittedAt,
        type: row.type,
        updatedAt: row.updatedAt,
      },
      events: row.events.map((event) => ({
        actorId: event.actorId,
        createdAt: event.createdAt,
        eventType: event.eventType,
        id: event.id,
        metadata: event.metadata,
        newStatus: event.newStatus,
        occurredAt: event.occurredAt,
        previousStatus: event.previousStatus,
        reasonCode: event.reasonCode,
        source: event.source,
      })),
      user: row.user,
    };
  }

  async adminQueues() {
    const counts = await this.repo.queueCounts({
      maxAttempts: this.maxReconcileAttempts(),
    });
    const [pending, escalated] = await Promise.all([
      this.repo.listCases({
        limit: 10,
        statuses: ['SESSION_CREATED', 'AWAITING_USER', 'SUBMITTED', 'IN_REVIEW'],
      }),
      this.repo.listCases({ limit: 10, requiresReview: true }),
    ]);
    const map = (row: (typeof pending.items)[number]) => ({
      businessName: row.business?.legalName ?? null,
      createdAt: row.createdAt,
      id: row.id,
      lastErrorCode: row.lastErrorCode,
      risk: row.riskOutcome,
      status: row.status,
      type: row.type,
      user: { email: row.user.email, id: row.user.id },
    });
    return {
      counts,
      escalated: escalated.items.map(map),
      pending: pending.items.map(map),
      policyVersion: this.policyVersion(),
    };
  }

  /**
   * A reviewer resolves a screening outcome. This never auto-declines identity and never
   * approves a contributor: it clears or confirms the AML flag, appends an audited event
   * and leaves the identity decision untouched.
   */
  async adminResolveRisk(
    actorId: string,
    caseId: string,
    input: { decision: 'CLEAR' | 'CONFIRM_MATCH'; reasonCode: string; reason: string },
  ) {
    const existing = await this.repo.findCaseById(caseId);
    if (!existing) throw new NotFoundException('Verification case not found');
    if (
      !existing.requiresHumanReview &&
      existing.riskOutcome !== 'REVIEW' &&
      existing.riskOutcome !== 'FLAGGED'
    ) {
      throw new ConflictException(
        'This case has no open risk review to resolve',
      );
    }
    const result = await this.repo.resolveRisk({
      actorId,
      caseId,
      decision: input.decision,
      occurredAt: new Date(),
      reason: input.reason,
      reasonCode: input.reasonCode,
    });
    if (!result) throw new NotFoundException('Verification case not found');
    return result;
  }

  async listScreenings(userId: string) {
    return this.prisma.amlScreening.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        datasets: true,
        id: true,
        source: true,
        status: true,
        topRiskScore: true,
        totalHits: true,
      },
      take: 100,
      where: { userId },
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────────

  private async requireSubject(userId: string): Promise<SubjectSnapshot> {
    const snapshot = await this.repo.loadSubject(userId);
    if (!snapshot) throw new NotFoundException('User not found');
    return snapshot;
  }

  private factsFrom(snapshot: SubjectSnapshot): VerificationFacts {
    return buildFacts({
      accountType: snapshot.user.accountType,
      business: snapshot.business,
      businessCase: snapshot.businessCase,
      individualCase: snapshot.individualCase,
      user: snapshot.user,
    });
  }

  private stateFromSnapshot(snapshot: SubjectSnapshot): VerificationStateView {
    const facts = this.factsFrom(snapshot);
    const evaluation = evaluateVerification(facts, this.policyOptions());
    const complianceHold = this.complianceHold(snapshot);
    const failure = verificationFailure(facts, evaluation, { complianceHold });
    const overall = overallState(facts);
    const relevant: CaseFacts[] = [facts.individual, facts.business].filter(
      (entry): entry is CaseFacts => entry !== null,
    );
    return {
      accountType: facts.accountType,
      blockers: failure?.blockers ?? [],
      business: caseView(snapshot.businessCase),
      businessRegistered: snapshot.business !== null,
      canStartSession:
        failure === null ||
        relevant.every(
          (entry) =>
            isTerminalState(entry.state) ||
            entry.state === 'NOT_STARTED' ||
            entry.state === 'ERROR',
        ),
      complianceHold,
      fundsCleared: evaluation.eligible && !complianceHold,
      identityVerified: relevant.some((entry) => entry.state === 'APPROVED'),
      individual: caseView(snapshot.individualCase),
      lastErrorCode:
        snapshot.individualCase?.lastErrorCode ??
        snapshot.businessCase?.lastErrorCode ??
        null,
      nextAction: evaluation.nextAction,
      nextSubject:
        facts.accountType === 'BUSINESS' &&
        facts.business?.state !== 'APPROVED'
          ? 'BUSINESS'
          : facts.individual?.state !== 'APPROVED'
            ? 'INDIVIDUAL'
            : null,
      overall,
      overallLabel: stateLabel(overall),
      policyVersion: evaluation.policyVersion,
      requirements: evaluation.requirements,
    };
  }

  private complianceHold(snapshot: SubjectSnapshot): boolean {
    if (snapshot.user.bannedAt !== null) return true;
    return (
      snapshot.individualCase?.requiresHumanReview === true ||
      snapshot.businessCase?.requiresHumanReview === true
    );
  }

  private policyVersion(): string {
    return this.config.get('VERIFICATION_POLICY_VERSION', { infer: true });
  }

  private policyOptions(): VerificationPolicyOptions {
    return {
      policyVersion: this.policyVersion(),
      requireKeyPeople: this.config.get('DIDIT_KYB_REQUIRE_KEY_PEOPLE', {
        infer: true,
      }),
    };
  }

  private providerName(): 'DIDIT' | 'STUB' {
    return this.config.get('KYC_PROVIDER', { infer: true }) === 'didit'
      ? 'DIDIT'
      : 'STUB';
  }

  private maxAttemptsPerDay(): number {
    return this.config.get('VERIFICATION_RETRY_MAX_PER_DAY', { infer: true });
  }

  private maxReconcileAttempts(): number {
    return this.config.get('VERIFICATION_RECONCILE_MAX_ATTEMPTS', {
      infer: true,
    });
  }

  private nextReconcileAt(): Date {
    return new Date(
      Date.now() +
        this.config.get('VERIFICATION_RECONCILE_AFTER_MINUTES', { infer: true }) *
          60_000,
    );
  }

  private startOfUtcDay(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }
}
