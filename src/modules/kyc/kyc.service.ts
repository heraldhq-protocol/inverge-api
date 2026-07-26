import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { Env } from '../../config/env.validation';
import {
  AmlScreeningParams,
  AmlSummary,
  KYC_PROVIDER_PORT,
  KycOutcome,
  KycProviderPort,
  KycPurpose,
} from '../../ports/kyc/kyc-provider.port';
import { AmlStatus, KycStatus } from '../../generated/prisma/client';
import {
  amlOutcomeToStatus,
  backerFundingRequiresKyc,
  isFundsEligible,
  kycOutcomeToStatus,
  purposeEligible,
  purposeReasons,
} from './kyc-gates';

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    @Inject(KYC_PROVIDER_PORT) private readonly provider: KycProviderPort,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async status(userId: string) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { kycStatus: true, amlStatus: true, amlScreenedAt: true },
    });
    return {
      kycStatus: u?.kycStatus ?? 'NOT_REQUIRED',
      amlStatus: u?.amlStatus ?? 'NOT_SCREENED',
      amlScreenedAt: u?.amlScreenedAt ?? null,
    };
  }

  // Start a hosted verification. Purpose picks the workflow: identity-only for idea-validation
  // credibility, identity + AML for funds handlers (FR-103 creators / FR-104 threshold backers).
  async startSession(userId: string, purpose: KycPurpose) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const res = await this.provider.startVerification({
      userId,
      purpose,
      callbackUrl: this.config.get('DIDIT_CALLBACK_URL', { infer: true }),
      email: user.email ?? undefined,
    });
    // Moving into a fresh verification resets a prior REJECTED/PENDING back to PENDING.
    if (user.kycStatus !== 'VERIFIED') {
      await this.transition(userId, 'PENDING', res.providerRef);
    } else {
      await this.prisma.user.update({
        where: { id: userId },
        data: { kycProviderRef: res.providerRef },
      });
    }
    return { ...res, purpose };
  }

  // Webhook entrypoint. parseWebhook verifies the signature; we then re-fetch the decision
  // from the provider so the outcome is authoritative (never trust the callback body alone).
  async handleWebhook(rawBody: string, headers: Record<string, string | undefined>) {
    const evt = this.provider.parseWebhook(rawBody, headers);
    if (!evt) throw new BadRequestException('Invalid or unverifiable webhook');

    const user = await this.resolveUser(evt.vendorData, evt.providerRef);
    if (!user) {
      this.logger.warn(`Webhook for unknown session ${evt.providerRef} — ignored`);
      return { ignored: true };
    }

    const decision = await this.provider
      .getDecision(evt.providerRef)
      .catch((e) => {
        this.logger.warn(`getDecision(${evt.providerRef}) failed: ${e?.message}`);
        return null;
      });

    const kycOutcome: KycOutcome = decision?.status ?? evt.status;
    await this.transition(user.id, kycOutcomeToStatus(kycOutcome), evt.providerRef);

    const amlOutcome = decision?.aml ?? evt.aml;
    if (amlOutcome) {
      await this.recordAml(
        user.id,
        'KYC_SESSION',
        amlOutcome,
        decision?.amlSummary ?? null,
        evt.providerRef,
        decision?.raw ?? { fromWebhook: true },
      );
    }
    return { ok: true, kyc: kycOutcome, aml: amlOutcome ?? null };
  }

  // Eligibility for the frontend to decide what to show/allow before a gated action.
  async eligibility(userId: string, purpose: KycPurpose) {
    const u = await this.requireVerification(userId);
    return {
      purpose,
      eligible: purposeEligible(purpose, u),
      kycStatus: u.kycStatus,
      amlStatus: u.amlStatus,
      reasons: purposeReasons(purpose, u),
    };
  }

  // FR-103 (creator) / FR-104 (threshold backer): hard gate for money-handling actions.
  // Callable from campaign-submission / contribution flows when they ship.
  async assertFundsEligible(userId: string): Promise<void> {
    const u = await this.requireVerification(userId);
    if (!isFundsEligible(u)) {
      throw new ForbiddenException({
        message: 'Identity verification and AML screening are required',
        reasons: purposeReasons('CAMPAIGN_CREATOR', u),
      });
    }
  }

  // FR-104: enforce the cumulative backer threshold. Below it, funding needs no KYC; the
  // pledge that would cross it (and all subsequent) requires funds-eligibility.
  async assertBackerFundingAllowed(
    userId: string,
    cumulativeUsd: number,
    nextAmountUsd: number,
  ): Promise<void> {
    const threshold = await this.backerThresholdUsd();
    if (backerFundingRequiresKyc(cumulativeUsd, nextAmountUsd, threshold)) {
      await this.assertFundsEligible(userId);
    }
  }

  // Standalone AML screen (admin / ongoing monitoring), independent of a KYC session.
  async screenAml(userId: string, params: AmlScreeningParams) {
    await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const result = await this.provider.screenAml(params);
    await this.recordAml(
      userId,
      'STANDALONE',
      result.status,
      {
        totalHits: result.totalHits,
        topRiskScore: result.topRiskScore,
        datasets: result.datasets,
      },
      undefined,
      result.raw,
    );
    return {
      status: result.status,
      totalHits: result.totalHits,
      topRiskScore: result.topRiskScore,
      datasets: result.datasets,
    };
  }

  // NFR-19: AML screening history (retained). Admin-facing, newest first.
  listScreenings(userId: string) {
    return this.prisma.amlScreening.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        source: true,
        status: true,
        totalHits: true,
        topRiskScore: true,
        datasets: true,
        createdAt: true,
      },
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────────────

  private async resolveUser(vendorData: string | null, providerRef: string) {
    if (vendorData) {
      const byVendor = await this.prisma.user.findUnique({ where: { id: vendorData } });
      if (byVendor) return byVendor;
    }
    return this.prisma.user.findFirst({ where: { kycProviderRef: providerRef } });
  }

  private async requireVerification(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { kycStatus: true, amlStatus: true },
    });
    return u;
  }

  private async backerThresholdUsd(): Promise<number> {
    const row = await this.prisma.platformParam.findUnique({
      where: { key: 'kyc.backerThresholdUSD' },
    });
    const v = row?.value;
    return typeof v === 'number' ? v : 200;
  }

  // FR-105: record KYC status transitions with timestamps. NFR-12: reference only.
  private async transition(userId: string, to: KycStatus, providerRef?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.kycStatus === to && user.kycProviderRef === (providerRef ?? user.kycProviderRef)) {
      return;
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { kycStatus: to, kycProviderRef: providerRef ?? user.kycProviderRef },
      }),
      ...(user.kycStatus !== to
        ? [
            this.prisma.kycStatusEvent.create({
              data: { userId, fromStatus: user.kycStatus, toStatus: to, providerRef },
            }),
          ]
        : []),
    ]);
  }

  // Persist an AML outcome: update the user's live status + append a retained record.
  private async recordAml(
    userId: string,
    source: 'KYC_SESSION' | 'STANDALONE',
    outcome: 'CLEAR' | 'IN_REVIEW' | 'FLAGGED',
    summary: AmlSummary | null,
    providerRef: string | undefined,
    raw: unknown,
  ) {
    const status = amlOutcomeToStatus(outcome) as AmlStatus;
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { amlStatus: status, amlScreenedAt: new Date() },
      }),
      this.prisma.amlScreening.create({
        data: {
          userId,
          source,
          status,
          providerRef,
          totalHits: summary?.totalHits ?? 0,
          topRiskScore: summary?.topRiskScore ?? null,
          datasets: summary?.datasets ?? [],
          raw: raw as object,
        },
      }),
    ]);
  }
}
