import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AmlScreeningParams,
  KYC_PROVIDER_PORT,
  KycProviderPort,
  KycPurpose,
} from '../../ports/kyc/kyc-provider.port';
import { AmlStatus } from '../../generated/prisma/client';
import { amlOutcomeToStatus } from './kyc-gates';
import { VerificationService } from './verification.service';

export interface StartBusinessParams {
  legalName: string;
  registrationNumber?: string;
  country?: string;
}

/**
 * Legacy `/kyc` and `/kyb` compatibility surface. It keeps the old routes and payloads
 * working while the verification domain owns every decision: status, session creation,
 * webhook handling and eligibility all delegate here. Only standalone AML screening
 * (a compliance tool, not an eligibility source) is implemented locally.
 */
@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    @Inject(KYC_PROVIDER_PORT) private readonly provider: KycProviderPort,
    private readonly prisma: PrismaService,
    private readonly verification: VerificationService,
  ) {}

  status(userId: string) {
    return this.verification.legacyStatus(userId);
  }

  startSession(userId: string, purpose: KycPurpose) {
    return this.verification.startSession(userId, { purpose });
  }

  handleWebhook(rawBody: string, headers: Record<string, string | undefined>) {
    return this.verification.handleWebhook(rawBody, headers);
  }

  // Legacy shape kept deliberately: `reasons` is the new `blockers` list under the old
  // name, and the legacy status pair still ships alongside the verification verdict.
  async eligibility(userId: string, purpose: KycPurpose) {
    const [result, legacy] = await Promise.all([
      this.verification.eligibility(userId, purpose),
      this.verification.legacyStatus(userId),
    ]);
    return {
      ...result,
      amlStatus: legacy.amlStatus,
      kycStatus: legacy.kycStatus,
      reasons: result.blockers,
    };
  }

  assertFundsEligible(userId: string): Promise<void> {
    return this.verification.assertFundsEligible(userId);
  }

  // Retained for callers that have not moved to the reservation endpoint. It checks the
  // threshold exactly as FR-104 requires but does not reserve headroom; the contribution
  // path must use `authorizeContribution` so concurrent pledges cannot both pass.
  async assertBackerFundingAllowed(
    userId: string,
    cumulativeUsd: number,
    nextAmountUsd: number,
  ): Promise<void> {
    const threshold = await this.verification.backerThresholdUsd();
    if (cumulativeUsd + nextAmountUsd <= threshold) return;
    await this.assertFundsEligible(userId);
  }

  screenAml(userId: string, params: AmlScreeningParams) {
    return this.runAmlScreen({ businessId: null, params, source: 'STANDALONE', userId });
  }

  listScreenings(userId: string) {
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

  // ── Business (KYB) compatibility ───────────────────────────────────────────────

  startBusinessSession(userId: string, params: StartBusinessParams) {
    return this.verification.startBusinessSession(userId, params);
  }

  businessStatus(userId: string) {
    return this.verification.businessStatus(userId).then((status) =>
      status.registered
        ? {
            ...status,
            kybStatus: this.projectBusinessKyb(
              status.kybStatus,
              status.verification.business,
            ),
          }
        : status,
    );
  }

  async businessEligibility(userId: string) {
    const business = await this.prisma.businessProfile.findUnique({ where: { userId } });
    const verification = await this.verification.state(userId);
    if (!business) {
      return {
        eligible: false,
        reasons: ['No business registered — start business verification'],
        registered: false as const,
        verification,
      };
    }
    return {
      amlStatus: business.amlStatus,
      eligible: verification.fundsCleared,
      kybStatus: this.projectBusinessKyb(
        business.kybStatus,
        verification.business,
      ),
      reasons: verification.blockers,
      registered: true as const,
      verification,
    };
  }

  async assertBusinessFundsEligible(userId: string): Promise<void> {
    const gate = await this.verification.campaignGate(userId);
    if (!gate.eligible) {
      throw new ForbiddenException({
        blockers: gate.blockers,
        code: gate.code,
        message: 'Business verification (KYB) and AML screening are required',
      });
    }
  }

  async assertBusinessBackerFundingAllowed(
    userId: string,
    cumulativeUsd: number,
    nextAmountUsd: number,
  ): Promise<void> {
    const threshold = await this.verification.backerThresholdUsd();
    if (cumulativeUsd + nextAmountUsd <= threshold) return;
    await this.assertBusinessFundsEligible(userId);
  }

  async screenBusinessAml(userId: string, params: AmlScreeningParams) {
    const business = await this.prisma.businessProfile.findUniqueOrThrow({
      where: { userId },
    });
    return this.runAmlScreen({
      businessId: business.id,
      params: { ...params, entityType: 'company' },
      source: 'STANDALONE',
      userId,
    });
  }

  async listBusinessScreenings(userId: string) {
    const business = await this.prisma.businessProfile.findUnique({ where: { userId } });
    if (!business) return [];
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
      where: { businessId: business.id },
    });
  }

  /**
   * Standalone screening is a compliance tool: it records what the provider returned
   * (aggregates only) but never by itself approves or declines an account. A non-clear
   * result surfaces through the case risk and the reviewer queue.
   */
  private async runAmlScreen(input: {
    userId: string;
    businessId: string | null;
    params: AmlScreeningParams;
    source: 'KYC_SESSION' | 'STANDALONE';
  }) {
    const result = await this.provider.screenAml(input.params);
    const status = amlOutcomeToStatus(result.status) as AmlStatus;
    const summary = {
      datasets: result.datasets,
      topRiskScore: result.topRiskScore,
      totalHits: result.totalHits,
    };

    await this.prisma.$transaction([
      input.businessId
        ? this.prisma.businessProfile.update({
            where: { id: input.businessId },
            data: { amlScreenedAt: new Date(), amlStatus: status },
          })
        : this.prisma.user.update({
            where: { id: input.userId },
            data: { amlScreenedAt: new Date(), amlStatus: status },
          }),
      this.prisma.amlScreening.create({
        data: {
          businessId: input.businessId,
          datasets: summary.datasets,
          providerRef: result.providerRequestId ?? undefined,
          // Never the provider's full response: aggregates only (NFR-12).
          raw: summary,
          source: input.source,
          status,
          topRiskScore: summary.topRiskScore,
          totalHits: summary.totalHits,
          userId: input.userId,
        },
      }),
    ]);

    this.logger.log(
      `Standalone AML screen recorded for ${input.businessId ? 'business' : 'user'} (${status})`,
    );
    return { ...summary, status };
  }

  /**
   * The stored legacy `kybStatus` is only written when a decision lands. While a session
   * is in flight the domain's case is the truth, so the compatibility surface projects it
   * instead of reporting the pre-session value.
   */
  private projectBusinessKyb(
    current: string,
    businessCase: { status: string } | null,
  ): string {
    if (!businessCase) return current;
    if (businessCase.status === 'APPROVED') return 'VERIFIED';
    if (businessCase.status === 'DECLINED') return 'REJECTED';
    return 'PENDING';
  }
}
