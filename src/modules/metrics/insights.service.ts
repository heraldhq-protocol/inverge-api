import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformParamsService } from '../platform-params/platform-params.service';
import { MetricsService } from './metrics.service';
import { contribution, resolveTier, round2 } from './pledge-weighting';
import { buildFeedbackInsights, buildGateProgress, computeVelocity, QuestionLite } from './insights-compute';

// Creator-facing analytics for one idea. Read-only aggregation over data that already
// exists (snapshots, signals, survey, comments) - chart-ready for the dashboard.

/** The chart window for the daily snapshot series. */
const INSIGHTS_WINDOW_DAYS = 180;

@Injectable()
export class InsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly params: PlatformParamsService,
    private readonly metrics: MetricsService,
  ) {}

  async getInsights(userId: string, ideaId: string, now: Date = new Date()) {
    const idea = await this.prisma.idea.findUnique({
      where: { id: ideaId },
      select: {
        id: true, creatorId: true, title: true, status: true, createdAt: true, validatingSince: true,
        askAmount: true, creatorPrePledgeTarget: true, discoverabilityTier: true,
        supporterCount: true, prePledgeTotal: true, weightedPrePledgeTotal: true,
        feedbackScore: true, feedbackCount: true, commentCount: true,
      },
    });
    if (!idea) throw new NotFoundException('Idea not found');
    if (idea.creatorId !== userId) throw new ForbiddenException('Not your idea');

    // Time-series (daily snapshots) - line charts. The chart window is bounded:
    // an idea that validates for years must not make this a full-history read.
    const snaps = await this.prisma.ideaMetricSnapshot.findMany({
      where: {
        ideaId,
        capturedAt: { gte: new Date(now.getTime() - INSIGHTS_WINDOW_DAYS * 86_400_000) },
      },
      orderBy: { capturedAt: 'asc' },
      take: INSIGHTS_WINDOW_DAYS + 30,
      select: { capturedAt: true, weightedTotal: true, supporterCount: true },
    });
    const timeseries = snaps.map((s) => ({
      capturedAt: s.capturedAt,
      weightedTotal: Number(s.weightedTotal),
      supporterCount: s.supporterCount,
    }));

    // Pre-pledge broken down by verification tier + currency.
    const pledges = await this.prisma.ideaSignal.findMany({
      where: { ideaId, type: 'PRE_PLEDGE' },
      select: {
        amount: true, amountUsd: true, currency: true,
        user: { select: { kycStatus: true, oauthSubject: true, emailVerified: true, bannedAt: true, createdAt: true } },
      },
    });
    const wp = await this.metrics.loadWeightingParams();
    const tierMap = new Map<string, { count: number; sumUsd: number; weighted: number }>();
    const curMap = new Map<string, { count: number; sumOriginal: number }>();
    for (const p of pledges) {
      const tier = resolveTier({ ...p.user }, wp, now);
      const tid = tier ? tier.id : 'EXCLUDED';
      const usd = Number(p.amountUsd ?? p.amount ?? 0);
      const t = tierMap.get(tid) ?? { count: 0, sumUsd: 0, weighted: 0 };
      t.count += 1; t.sumUsd += usd; t.weighted += contribution(usd, tier);
      tierMap.set(tid, t);
      const c = curMap.get(p.currency) ?? { count: 0, sumOriginal: 0 };
      c.count += 1; c.sumOriginal += Number(p.amount ?? 0);
      curMap.set(p.currency, c);
    }

    // Feedback (survey) — rating histogram + per-question aggregates.
    const [questions, responses] = await Promise.all([
      this.prisma.surveyQuestion.findMany({ where: { ideaId }, orderBy: { index: 'asc' }, select: { id: true, index: true, prompt: true, type: true } }),
      this.prisma.surveyResponse.findMany({ where: { ideaId }, select: { answers: true } }),
    ]);
    const feedback = buildFeedbackInsights(questions as QuestionLite[], responses);

    // Comment engagement — volume + most-liked.
    const topComments = await this.prisma.ideaComment.findMany({
      where: { ideaId },
      orderBy: [{ likeCount: 'desc' }, { createdAt: 'desc' }],
      take: 5,
      select: { id: true, body: true, likeCount: true, highlighted: true, createdAt: true },
    });

    // Graduation-gate progress.
    const [minSupporters, minWeightedUSD, minPct, minFeedbackCount, minAvgFeedbackRating] = await Promise.all([
      this.params.getNumber('validation.minSupporters', 50),
      this.params.getNumber('validation.minWeightedUSD', 2000),
      this.params.getNumber('validation.minPrePledgePctOfAsk', 0.1),
      this.params.getNumber('validation.minFeedbackCount', 10),
      this.params.getNumber('validation.minAvgFeedbackRating', 3),
    ]);
    const gate = buildGateProgress({
      supporterCount: idea.supporterCount,
      weighted: Number(idea.weightedPrePledgeTotal),
      feedbackCount: idea.feedbackCount,
      feedbackScore: Number(idea.feedbackScore),
      askAmount: Number(idea.askAmount),
      creatorTarget: idea.creatorPrePledgeTarget ? Number(idea.creatorPrePledgeTarget) : 0,
      minSupporters, minWeightedUSD, minPct, minFeedbackCount, minAvgFeedbackRating,
    });

    return {
      idea: {
        id: idea.id, title: idea.title, status: idea.status, discoverabilityTier: idea.discoverabilityTier,
        createdAt: idea.createdAt, validatingSince: idea.validatingSince, askAmount: Number(idea.askAmount),
      },
      summary: {
        supporterCount: idea.supporterCount,
        weightedPrePledgeTotal: Number(idea.weightedPrePledgeTotal),
        rawPrePledgeTotalUsd: Number(idea.prePledgeTotal),
        feedbackScore: Number(idea.feedbackScore),
        feedbackCount: idea.feedbackCount,
        commentCount: idea.commentCount,
      },
      timeseries,
      velocity: computeVelocity(timeseries, now),
      prePledge: {
        byTier: [...tierMap].map(([tier, v]) => ({ tier, count: v.count, sumUsd: round2(v.sumUsd), weighted: round2(v.weighted) })),
        byCurrency: [...curMap].map(([currency, v]) => ({ currency, count: v.count, sumOriginal: round2(v.sumOriginal) })),
      },
      feedback,
      comments: { count: idea.commentCount, top: topComments },
      gate,
    };
  }
}
