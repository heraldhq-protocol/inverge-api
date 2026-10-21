import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformParamsService } from '../platform-params/platform-params.service';
import { jaccard, shingles } from '../../ports/dedup/shingle';
import type { User } from '../../generated/prisma/client';
import {
  computeTrustScore,
  FeedItemSignals,
  FeedRankingParams,
  injectPaid,
  OrganicWeights,
  PersonalizationParams,
  personalizationMultiplier,
  PromotedCandidate,
  rankFeed,
  RankedFeedEntry,
  TrustWeights,
  UserInterests,
} from './ranking';
import { FeedQueryDto } from './dto/feed.dto';

const DAY_MS = 86_400_000;

import { toPublicCreator } from '../../common/projections/creator-profile.projection';

// Candidate record shape pulled in Stage 1 (retrieval).
type PoolIdea = {
  id: string;
  creatorId: string;
  slug: string;
  title: string;
  problem: string;
  solution: string;
  category: string | null;
  region: string | null;
  coverImageUrl: string | null;
  askAmount: unknown;
  status: string;
  discoverabilityTier: string;
  supporterCount: number;
  weightedPrePledgeTotal: unknown;
  feedbackScore: unknown;
  feedbackCount: number;
  commentCount: number;
  qualityScore: unknown;
  feedImpressions: number;
  createdAt: Date;
  creator: {
    id: string;
    kycStatus: string;
    createdAt: Date;
    institutionalCosign: boolean;
    business: { kybStatus: string; amlStatus: string } | null;
    creatorProfile: {
      displayName: string | null;
      avatarUrl: string | null;
      bio: string | null;
      links: unknown;
      tier: 'STARTER' | 'TRUSTED' | 'ESTABLISHED';
      completedCampaigns: number;
      tenureStartedAt: Date;
    } | null;
  };
};

interface FeedParams {
  ranking: FeedRankingParams;
  personalization: PersonalizationParams;
  trustWeights: TrustWeights;
  candidatePoolSize: number;
  velocityWindowDays: number;
  paid: { everyN: number; maxSlots: number };
}

// Discovery feed (three-stage architecture). Stage 1 (retrieval) and paid-injection wiring
// live here; all scoring math is delegated to the pure `ranking` module. Paid placement is
// injected ONLY at the end and never participates in an organic score (FR-206a / NFR-15).
@Injectable()
export class FeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly params: PlatformParamsService,
  ) {}

  async getFeed(
    user: User | undefined,
    query: FeedQueryDto,
    now: Date = new Date(),
  ) {
    const p = await this.loadParams();
    const take = query.take ?? 25;

    // ── Stage 1: candidate generation (retrieval) ──
    const pool = await this.retrieve(query, p.candidatePoolSize);
    if (!pool.length) return { items: [], anonymous: !user };

    // Per-item signals the pure ranker needs.
    const [velocities, dupPenalties, personalization] = await Promise.all([
      this.computeVelocities(
        pool.map((i) => i.id),
        now,
        p.velocityWindowDays,
      ),
      Promise.resolve(this.computeDupPenalties(pool)),
      this.resolvePersonalization(user, pool, p.personalization),
    ]);

    const signals: FeedItemSignals[] = pool.map((idea) => {
      const vel = velocities.get(idea.id) ?? { events: 0, exposureDays: 1 };
      const pers = personalization.get(idea.id) ?? {
        multiplier: 1,
        matchReason: null,
      };
      return {
        objectType: 'idea' as const, // Phase 1+: campaigns assemble their own signals here
        id: idea.id,
        creatorId: idea.creatorId,
        category: idea.category,
        region: idea.region,
        ageHours: Math.max(
          0,
          (now.getTime() - idea.createdAt.getTime()) / 3_600_000,
        ),
        qualityScore: Number(idea.qualityScore ?? 0),
        trustScore: this.trustFor(idea, p.trustWeights),
        weightedPrePledge: Number(idea.weightedPrePledgeTotal ?? 0),
        velocityEvents: vel.events,
        velocityExposureDays: vel.exposureDays,
        feedbackRatingSum: Number(idea.feedbackScore ?? 0) * idea.feedbackCount, // mean × count = Σ
        feedbackRatingCount: idea.feedbackCount,
        duplicatePenalty: dupPenalties.get(idea.id) ?? 0,
        feedImpressions: idea.feedImpressions,
        personalizationMultiplier: pers.multiplier,
        matchReason: pers.matchReason,
      };
    });

    // ── Stage 2 + Stage 3 (organic half): score, then policy re-rank (exploration + diversity) ──
    const organic = rankFeed(signals, p.ranking, take);

    // ── Stage 3 (paid half): inject promoted slots — walled off from the organic score ──
    // (injectPaid dedupes promoted ids already present in `organic`.)
    const promoted = await this.activePromotions(pool, now);
    const ranked = injectPaid(organic, promoted, p.paid);

    // Best-effort exposure accounting for the UCB exploration bonus (never blocks the response).
    void this.recordImpressions(ranked.map((r) => r.id));

    return { items: this.shape(ranked, pool), anonymous: !user };
  }

  // ─────────────────────────── Stage 1: retrieval ───────────────────────────

  // Phase 0 retrieves published ideas. Phase 1+ merges live campaigns into the same
  // candidate pool here (query.type selects idea | campaign | all), each mapped to the
  // shared FeedItemSignals so the ranker treats them uniformly — see FeedObjectType.
  private async retrieve(
    query: FeedQueryDto,
    poolSize: number,
  ): Promise<PoolIdea[]> {
    const rows = await this.prisma.idea.findMany({
      where: {
        // Only surfaces that are open + discoverable. LINK_ONLY stays URL-reachable only.
        status: { in: ['VALIDATING', 'THRESHOLD_MET'] },
        discoverabilityTier: { in: ['DISCOVERABLE', 'FEATURED'] },
        creator: { is: { bannedAt: null } }, // banned creators drop out entirely (FR-216)
        ...(query.category ? { category: query.category } : {}),
        ...(query.excludeIds?.length
          ? { id: { notIn: query.excludeIds } }
          : {}),
      },
      select: {
        id: true,
        creatorId: true,
        slug: true,
        title: true,
        problem: true,
        solution: true,
        category: true,
        region: true,
        askAmount: true,
        status: true,
        discoverabilityTier: true,
        supporterCount: true,
        weightedPrePledgeTotal: true,
        feedbackScore: true,
        feedbackCount: true,
        commentCount: true,
        qualityScore: true,
        feedImpressions: true,
        createdAt: true,
        coverImageUrl: true,
        creator: {
          select: {
            id: true,
            kycStatus: true,
            createdAt: true,
            institutionalCosign: true,
            business: { select: { kybStatus: true, amlStatus: true } },
            creatorProfile: {
              select: {
                displayName: true,
                avatarUrl: true,
                bio: true,
                links: true,
                tier: true,
                completedCampaigns: true,
                tenureStartedAt: true,
              },
            },
          },
        },
        // Latest moderation outcome — exclude items currently held for review.
        moderationCases: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { decision: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: poolSize,
    });

    return rows
      .filter((r) => r.moderationCases[0]?.decision !== 'HELD_FOR_REVIEW')
      .map(
        ({ moderationCases: _drop, ...idea }) => idea as unknown as PoolIdea,
      );
  }

  // ─────────────────────────── Signals ───────────────────────────

  // Supporter-accrual within the trailing window, from the daily snapshot table. Baseline =
  // the earliest snapshot inside the window; exposure is floored at one day so a very fresh
  // item's rate is not inflated (the Bayesian prior in the ranker does the rest).
  private async computeVelocities(
    ideaIds: string[],
    now: Date,
    windowDays: number,
  ): Promise<Map<string, { events: number; exposureDays: number }>> {
    const from = new Date(now.getTime() - windowDays * DAY_MS);
    const [snaps, ideas] = await Promise.all([
      this.prisma.ideaMetricSnapshot.findMany({
        where: { ideaId: { in: ideaIds }, capturedAt: { gte: from } },
        orderBy: { capturedAt: 'asc' },
        select: { ideaId: true, supporterCount: true, capturedAt: true },
      }),
      this.prisma.idea.findMany({
        where: { id: { in: ideaIds } },
        select: { id: true, supporterCount: true, createdAt: true },
      }),
    ]);

    const baseline = new Map<
      string,
      { supporterCount: number; capturedAt: Date }
    >();
    for (const s of snaps)
      if (!baseline.has(s.ideaId))
        baseline.set(s.ideaId, {
          supporterCount: s.supporterCount,
          capturedAt: s.capturedAt,
        });

    const out = new Map<string, { events: number; exposureDays: number }>();
    for (const idea of ideas) {
      const base = baseline.get(idea.id);
      const observedFrom = base ? base.capturedAt : idea.createdAt;
      const baseCount = base ? base.supporterCount : 0;
      const events = Math.max(0, idea.supporterCount - baseCount);
      const exposureDays = Math.max(
        1,
        (now.getTime() - observedFrom.getTime()) / DAY_MS,
      );
      out.set(idea.id, { events, exposureDays });
    }
    return out;
  }

  // Continuous near-duplicate penalty: each item's max text similarity to any OTHER item in
  // the pool. Exact/near clones (>= moderation.dedupThreshold) are already held upstream and
  // filtered in retrieval; this demotes the sub-threshold copies. O(N^2) over the pool —
  // fine at the candidate cap; swap for LSH if the pool grows.
  private computeDupPenalties(pool: PoolIdea[]): Map<string, number> {
    const sets = pool.map((i) =>
      shingles(`${i.title} ${i.problem} ${i.solution}`),
    );
    const out = new Map<string, number>();
    for (let i = 0; i < pool.length; i++) {
      let max = 0;
      for (let j = 0; j < pool.length; j++) {
        if (i === j) continue;
        const sim = jaccard(sets[i], sets[j]);
        if (sim > max) max = sim;
      }
      out.set(pool[i].id, max);
    }
    return out;
  }

  private trustFor(idea: PoolIdea, w: TrustWeights): number {
    const c = idea.creator;
    return computeTrustScore(
      {
        kycVerified: c.kycStatus === 'VERIFIED',
        kybVerifiedClear:
          c.business?.kybStatus === 'VERIFIED' &&
          c.business?.amlStatus === 'CLEAR',
        cosign: c.institutionalCosign,
      },
      w,
    );
  }

  // ─────────────────────────── Personalization ───────────────────────────

  // Resolve the user's interests (explicit prefs, else inferred from engaged ideas) and the
  // engaged-text corpus for content similarity, then compute a bounded multiplier per item.
  // Anonymous users get a neutral 1.0 everywhere (global-popular feed).
  private async resolvePersonalization(
    user: User | undefined,
    pool: PoolIdea[],
    p: PersonalizationParams,
  ): Promise<
    Map<
      string,
      { multiplier: number; matchReason: 'region' | 'category' | null }
    >
  > {
    const out = new Map<
      string,
      { multiplier: number; matchReason: 'region' | 'category' | null }
    >();
    if (!user) {
      for (const idea of pool)
        out.set(idea.id, { multiplier: 1, matchReason: null });
      return out;
    }

    const { interests, engagedTexts } = await this.loadInterests(
      user,
      p.engagedCorpusMax,
    );
    for (const idea of pool) {
      out.set(
        idea.id,
        personalizationMultiplier(
          {
            category: idea.category,
            region: idea.region,
            text: `${idea.title} ${idea.problem} ${idea.solution}`,
          },
          interests,
          engagedTexts,
          p,
        ),
      );
    }
    return out;
  }

  private async loadInterests(
    user: User,
    corpusMax: number,
  ): Promise<{ interests: UserInterests; engagedTexts: string[] }> {
    // Ideas the user has engaged (support / pre-pledge) — the behavioural signal source.
    const engagements = await this.prisma.ideaSignal.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        idea: {
          select: {
            category: true,
            region: true,
            title: true,
            problem: true,
            solution: true,
          },
        },
      },
    });
    const engaged = engagements.map((e) => e.idea);

    const behavCats = new Set<string>();
    const behavRegions = new Set<string>();
    for (const e of engaged) {
      if (e.category) behavCats.add(e.category.toLowerCase());
      if (e.region) behavRegions.add(e.region.toLowerCase());
    }

    const explicitCats = (user.preferredCategories ?? []).map((c) =>
      c.toLowerCase(),
    );
    const explicitRegions = (user.preferredRegions ?? []).map((r) =>
      r.toLowerCase(),
    );

    // Explicit preferences take precedence per-dimension; fall back to behaviour when empty.
    const interests: UserInterests = {
      categories: explicitCats.length ? explicitCats : [...behavCats],
      regions: explicitRegions.length ? explicitRegions : [...behavRegions],
    };
    const engagedTexts = engaged
      .slice(0, corpusMax)
      .map((e) => `${e.title} ${e.problem} ${e.solution}`);
    return { interests, engagedTexts };
  }

  // ─────────────────────────── Stage 3: paid ───────────────────────────

  // Active boosts on eligible ideas → promoted candidates for Stage 3 injection, ordered
  // FEATURED-tier first then most recent. These never touch any organic score.
  private async activePromotions(
    pool: PoolIdea[],
    now: Date,
  ): Promise<PromotedCandidate[]> {
    const eligibleIds = new Set(pool.map((i) => i.id));
    const boosts = await this.prisma.ideaBoost.findMany({
      where: {
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
        idea: {
          discoverabilityTier: { in: ['DISCOVERABLE', 'FEATURED'] },
          status: { in: ['VALIDATING', 'THRESHOLD_MET'] },
        },
      },
      orderBy: [{ tier: 'desc' }, { startsAt: 'desc' }],
      select: { ideaId: true, tier: true },
    });
    const seen = new Set<string>();
    const promoted: PromotedCandidate[] = [];
    for (const b of boosts) {
      if (seen.has(b.ideaId) || !eligibleIds.has(b.ideaId)) continue;
      seen.add(b.ideaId);
      promoted.push({ objectType: 'idea', id: b.ideaId, boostTier: b.tier });
    }
    return promoted;
  }

  private async recordImpressions(ids: string[]): Promise<void> {
    if (!ids.length) return;
    try {
      await this.prisma.idea.updateMany({
        where: { id: { in: ids } },
        data: { feedImpressions: { increment: 1 } },
      });
    } catch {
      // Exposure accounting is best-effort; a failure here must not fail the feed request.
    }
  }

  // ─────────────────────────── Shaping ───────────────────────────

  // Public projection: idea data (raw internal columns withheld) + the feed metadata chip.
  private shape(ranked: RankedFeedEntry[], pool: PoolIdea[]) {
    const byId = new Map(pool.map((i) => [i.id, i]));
    return ranked
      .map((entry) => {
        const idea = byId.get(entry.id);
        if (!idea) return null;
        return {
          objectType: entry.objectType, // 'idea' at Phase 0; 'campaign' from Phase 1+
          id: idea.id,
          slug: idea.slug,
          title: idea.title,
          problem: idea.problem,
          solution: idea.solution,
          category: idea.category,
          region: idea.region,
          coverImageUrl: idea.coverImageUrl ?? null,
          askAmount: idea.askAmount,
          status: idea.status,
          discoverabilityTier: idea.discoverabilityTier,
          supporterCount: idea.supporterCount,
          weightedPrePledgeTotal: idea.weightedPrePledgeTotal, // public "Estimated interest"
          feedbackScore: idea.feedbackScore,
          feedbackCount: idea.feedbackCount,
          commentCount: idea.commentCount,
          qualityScore: idea.qualityScore,
          creatorId: idea.creatorId,
          creator: toPublicCreator(idea.creator),
          // Feed metadata — chip is the honest, surfaced reason (explainability layer).
          promoted: entry.promoted,
          boostTier: entry.boostTier,
          exploration: entry.exploration,
          reason: entry.chip,
        };
      })
      .filter(Boolean);
  }

  // ─────────────────────────── Interests write ───────────────────────────

  async updateInterests(
    userId: string,
    dto: { preferredCategories?: string[]; preferredRegions?: string[] },
  ) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.preferredCategories
          ? { preferredCategories: dto.preferredCategories }
          : {}),
        ...(dto.preferredRegions
          ? { preferredRegions: dto.preferredRegions }
          : {}),
      },
      select: { preferredCategories: true, preferredRegions: true },
    });
    return user;
  }

  // ─────────────────────────── Params ───────────────────────────

  private async loadParams(): Promise<FeedParams> {
    const [
      weights,
      dupW,
      velWindow,
      velC,
      fbC,
      fbPrior,
      gravity,
      personalization,
      trustWeights,
      explShare,
      explBeta,
      explMinQ,
      perCreatorCap,
      catMaxShare,
      poolSize,
      paidEveryN,
      paidMaxSlots,
    ] = await Promise.all([
      this.params.get<OrganicWeights>('feed.weights', {
        prePledge: 0.3,
        velocity: 0.2,
        feedback: 0.15,
        quality: 0.15,
        trust: 0.2,
      }),
      this.params.getNumber('feed.dupPenaltyWeight', 0.3),
      this.params.getNumber('feed.velocity.windowDays', 7),
      this.params.getNumber('feed.velocity.bayesC', 5),
      this.params.getNumber('feed.feedback.bayesC', 5),
      this.params.getNumber('feed.feedback.priorMean', 3),
      this.params.getNumber('feed.gravity', 1.2),
      this.params.get<PersonalizationParams>('feed.personalization', {
        min: 0.8,
        max: 1.5,
        categoryBonus: 0.25,
        regionBonus: 0.2,
        similarityBonus: 0.25,
        engagedCorpusMax: 10,
      }),
      this.params.get<TrustWeights>('feed.trustWeights', {
        kyc: 0.5,
        kyb: 0.3,
        cosign: 0.2,
      }),
      this.params.getNumber('feed.exploration.slotShare', 0.25),
      this.params.getNumber('feed.exploration.beta', 1),
      this.params.getNumber('feed.exploration.minQuality', 0.4),
      this.params.getNumber('feed.perCreatorCap', 2),
      this.params.getNumber('feed.categoryMaxShare', 0.5),
      this.params.getNumber('feed.candidatePoolSize', 300),
      this.params.getNumber('feed.paid.everyN', 4),
      this.params.getNumber('feed.paid.maxSlots', 3),
    ]);

    return {
      ranking: {
        weights: weights!,
        dupPenaltyWeight: dupW,
        velocityBayesC: velC,
        feedbackBayesC: fbC,
        feedbackPriorMean: fbPrior,
        gravity,
        explorationSlotShare: explShare,
        explorationBeta: explBeta,
        explorationMinQuality: explMinQ,
        perCreatorCap: perCreatorCap,
        categoryMaxShare: catMaxShare,
      },
      personalization: personalization!,
      trustWeights: trustWeights!,
      candidatePoolSize: poolSize,
      velocityWindowDays: velWindow,
      paid: { everyN: paidEveryN, maxSlots: paidMaxSlots },
    };
  }
}
