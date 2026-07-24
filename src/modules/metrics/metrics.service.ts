import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { PlatformParamsService } from '../platform-params/platform-params.service';
import {
  DEFAULT_MIN_ACCOUNT_AGE_HOURS,
  DEFAULT_TIERS,
  PledgeWeightingParams,
  normalizeToUsd,
  round2,
  weightedTotal,
} from './pledge-weighting';

// Metrics aggregation service (FR-203/207). Single owner of the idea validation
// figures: supporter count, raw + weighted pre-pledge totals, feedback summary. Also
// owns the daily snapshot + sustainment check backing the FR-204a graduation window.
//
// INVARIANT (FR-206a): this service reads ONLY signals + feedback + pledger identity.
// No boost data participates in any figure it computes.
@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly params: PlatformParamsService,
  ) {}

  async loadWeightingParams(): Promise<PledgeWeightingParams> {
    const tiers = await this.params.get<unknown>('validation.pledgeTiers', DEFAULT_TIERS);
    const minAccountAgeHours = await this.params.getNumber(
      'validation.minAccountAgeHours',
      DEFAULT_MIN_ACCOUNT_AGE_HOURS,
    );
    return {
      tiers: Array.isArray(tiers) && tiers.length ? (tiers as PledgeWeightingParams['tiers']) : DEFAULT_TIERS,
      minAccountAgeHours,
    };
  }

  // FR-210: stated amount → USD using the current fx param.
  async normalizeToUsd(amount: number, currency: string): Promise<number> {
    const fx = await this.params.getNumber('fx.ngnPerUsd', 0);
    return normalizeToUsd(amount, currency, fx);
  }

  // Recompute ALL validation metrics for an idea from signals + feedback only.
  // Weighting is computed live (join to each pledger's current identity) so verifying
  // later raises weight and a ban drops the row out — no stale snapshot on the signal.
  async recompute(tx: Prisma.TransactionClient, ideaId: string, now: Date = new Date()) {
    const supporterCount = await tx.ideaSignal.count({
      where: { ideaId, type: 'SUPPORT' },
    });

    const prePledges = await tx.ideaSignal.findMany({
      where: { ideaId, type: 'PRE_PLEDGE' },
      select: {
        amount: true,
        amountUsd: true,
        user: {
          select: {
            kycStatus: true,
            oauthSubject: true,
            emailVerified: true,
            bannedAt: true,
            createdAt: true,
          },
        },
      },
    });

    const wp = await this.loadWeightingParams();
    const pledges = prePledges.map((s) => ({
      amountUsd: Number(s.amountUsd ?? s.amount ?? 0),
      pledger: {
        kycStatus: s.user.kycStatus as string,
        oauthSubject: s.user.oauthSubject,
        emailVerified: s.user.emailVerified,
        bannedAt: s.user.bannedAt,
        createdAt: s.user.createdAt,
      },
    }));

    const rawTotal = round2(pledges.reduce((a, p) => a + (p.amountUsd || 0), 0));
    const weighted = weightedTotal(pledges, wp, now);

    const fb = await tx.ideaFeedback.aggregate({
      where: { ideaId },
      _avg: { rating: true },
      _count: true,
    });

    return tx.idea.update({
      where: { id: ideaId },
      data: {
        supporterCount,
        prePledgeTotal: rawTotal,
        weightedPrePledgeTotal: weighted,
        feedbackScore: fb._avg.rating ?? 0,
        feedbackCount: fb._count,
      },
    });
  }

  // FR-204a: capture a point-in-time snapshot of every VALIDATING idea's figure.
  // Wire to a daily job (BullMQ repeatable) in production; callable directly for tests.
  async snapshotAllValidating(now: Date = new Date()) {
    const ideas = await this.prisma.idea.findMany({
      where: { status: { in: ['VALIDATING', 'THRESHOLD_MET'] } },
      select: { id: true, weightedPrePledgeTotal: true, supporterCount: true },
    });
    if (!ideas.length) return 0;
    await this.prisma.ideaMetricSnapshot.createMany({
      data: ideas.map((i) => ({
        ideaId: i.id,
        capturedAt: now,
        weightedTotal: i.weightedPrePledgeTotal,
        supporterCount: i.supporterCount,
      })),
    });
    return ideas.length;
  }

  // FR-204a sustainment: the weighted figure must have HELD above `requiredWeighted`,
  // not merely touched it. Satisfied if either (a) the validation window has closed and
  // the current figure still clears the bar (held at close), or (b) there are at least
  // `sustainmentDays` snapshots within the trailing window and none dropped below the
  // bar. `sustainmentDays <= 0` disables the check (used to isolate other gate logic).
  async isSustained(
    ideaId: string,
    requiredWeighted: number,
    currentWeighted: number,
    validatingSince: Date | null,
    now: Date = new Date(),
  ): Promise<boolean> {
    const sustainmentDays = await this.params.getNumber('validation.sustainmentDays', 14);
    if (sustainmentDays <= 0) return true;

    const windowDays = await this.params.getNumber('validation.windowDays', 90);
    if (validatingSince) {
      const windowClose = validatingSince.getTime() + windowDays * 86_400_000;
      if (now.getTime() >= windowClose) return currentWeighted >= requiredWeighted;
    }

    const from = new Date(now.getTime() - sustainmentDays * 86_400_000);
    const snaps = await this.prisma.ideaMetricSnapshot.findMany({
      where: { ideaId, capturedAt: { gte: from } },
      select: { weightedTotal: true },
    });
    if (snaps.length < sustainmentDays) return false; // not enough history to prove hold
    return snaps.every((s) => Number(s.weightedTotal) >= requiredWeighted);
  }
}
