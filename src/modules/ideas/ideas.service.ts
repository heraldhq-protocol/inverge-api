import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { MetricsService } from '../metrics/metrics.service';
import { QualityService } from '../quality/quality.service';
import { ModerationService } from '../moderation/moderation.service';
import { PlatformParamsService } from '../platform-params/platform-params.service';
import { ProductAnalyticsService } from '../analytics/product-analytics.service';
import {
  resolveTaxonomyPair,
  toTaxonomyProjection,
} from '../taxonomy/taxonomy';
import { slugify } from '../../common/utils/slug.util';
import { DEFAULT_SURVEY } from '../survey/survey-validation';
import {
  CreateIdeaDto,
  ListIdeasQueryDto,
  PrePledgeDto,
  UpdateIdeaDto,
} from './dto/idea.dto';

import { toPublicCreator } from '../../common/projections/creator-profile.projection';
import type { UserRole } from '../../generated/prisma/client';
import { buildGateProgress } from '../metrics/insights-compute';
import {
  asCursorDate,
  buildPage,
  clampPageSize,
  decodeCursor,
  encodeCursor,
  filterFingerprint,
  keysetCondition,
} from '../../common/http/pagination';

type GateThresholds = {
  minSupporters: number;
  minWeightedUSD: number;
  minPct: number;
  minFeedbackCount: number;
  minAvgFeedbackRating: number;
};

type GateSource = {
  supporterCount: number | null;
  weightedPrePledgeTotal: { toString(): string } | null;
  feedbackCount: number | null;
  feedbackScore: { toString(): string } | null;
  askAmount: { toString(): string };
  creatorPrePledgeTarget: { toString(): string } | null;
};

type IdeaViewer = { id: string; role?: UserRole };

@Injectable()
export class IdeasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly quality: QualityService,
    private readonly moderation: ModerationService,
    private readonly params: PlatformParamsService,
    @Optional() private readonly cache?: CacheService,
    @Optional() private readonly analytics?: ProductAnalyticsService,
  ) {}

  private loadGateThresholds(): Promise<GateThresholds> {
    return Promise.all([
      this.params.getNumber('validation.minSupporters', 50),
      this.params.getNumber('validation.minWeightedUSD', 2000),
      this.params.getNumber('validation.minPrePledgePctOfAsk', 0.1),
      this.params.getNumber('validation.minFeedbackCount', 10),
      this.params.getNumber('validation.minAvgFeedbackRating', 3),
    ]).then(
      ([
        minSupporters,
        minWeightedUSD,
        minPct,
        minFeedbackCount,
        minAvgFeedbackRating,
      ]) => ({
        minSupporters,
        minWeightedUSD,
        minPct,
        minFeedbackCount,
        minAvgFeedbackRating,
      }),
    );
  }

  private gateProgressFor(idea: GateSource, thresholds: GateThresholds) {
    return buildGateProgress({
      supporterCount: idea.supporterCount ?? 0,
      weighted: Number(idea.weightedPrePledgeTotal ?? 0),
      feedbackCount: idea.feedbackCount ?? 0,
      feedbackScore: Number(idea.feedbackScore ?? 0),
      askAmount: Number(idea.askAmount ?? 0),
      creatorTarget: idea.creatorPrePledgeTarget
        ? Number(idea.creatorPrePledgeTarget)
        : 0,
      ...thresholds,
    });
  }

  private async findIdea(idOrSlug: string) {
    const idea = await this.prisma.idea.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    });
    if (!idea) throw new NotFoundException('Idea not found');
    return idea;
  }

  /**
   * FR-272 gates distribution, not existence: a published LINK_ONLY idea stays
   * reachable by direct URL. DRAFT is the only state that is not public.
   */
  private isPublicIdea(idea: { status: string }): boolean {
    return idea.status !== 'DRAFT';
  }

  private assertReadable(
    idea: { creatorId: string; status: string },
    viewer?: IdeaViewer,
  ): void {
    if (this.isPublicIdea(idea)) return;
    if (viewer && (viewer.id === idea.creatorId || viewer.role === 'ADMIN')) {
      return;
    }
    // 404, not 403: an anonymous caller must not be able to probe draft ids.
    throw new NotFoundException('Idea not found');
  }

  // FR-201/270: create a structured-pitch DRAFT. FR-275: bounded by the per-creator
  // concurrency cap. Scored immediately for coaching (stays LINK_ONLY until published).
  async create(userId: string, dto: CreateIdeaDto) {
    await this.assertUnderConcurrencyCap(userId);
    const idea = await this.prisma.idea.create({
      data: {
        creatorId: userId,
        title: dto.title,
        slug: slugify(dto.title),
        problem: dto.problem,
        solution: dto.solution,
        targetUser: dto.targetUser,
        currentAlternative: dto.currentAlternative,
        askBreakdown: dto.askBreakdown as object,
        roadmapSteps: dto.roadmapSteps as object,
        category: dto.category,
        ...this.taxonomyFields(dto.taxonomy),
        region: dto.region ?? null,
        coverImageUrl: dto.coverImageUrl ?? null,
        risks: dto.risks ?? null,
        problemDoc: (dto.problemDoc as object) ?? null,
        solutionDoc: (dto.solutionDoc as object) ?? null,
        roadmap: dto.roadmap ?? dto.roadmapSteps.map((s) => `${s.date}: ${s.description}`).join('; '),
        askAmount: dto.askAmount,
        creatorPrePledgeTarget: dto.creatorPrePledgeTarget ?? null,
        status: 'DRAFT',
      },
    });
    // FR-202/203: seed a default survey (rating + open-text) the creator can customise.
    await this.prisma.surveyQuestion.createMany({
      data: DEFAULT_SURVEY.map((q) => ({
        ideaId: idea.id,
        index: q.index,
        prompt: q.prompt,
        type: q.type,
        required: q.required ?? true,
      })),
    });
    await this.quality.evaluate(idea.id, false);
    this.invalidateIdea();
    return this.get(idea.id, { id: userId });
  }

  async update(userId: string, idOrSlug: string, dto: UpdateIdeaDto) {
    const idea = await this.owned(userId, idOrSlug);
    if (idea.status !== 'DRAFT') {
      throw new BadRequestException('Only draft ideas can be edited');
    }
    const id = idea.id;
    // `taxonomy` is a nested DTO, not a column: map it, and leave the stored
    // assignment untouched when the field is absent (undefined). An explicit
    // `null` clears the assignment.
    const { taxonomy, ...fields } = dto;
    const data: Record<string, unknown> = { ...fields };
    if (taxonomy !== undefined) Object.assign(data, this.taxonomyFields(taxonomy));
    await this.prisma.idea.update({ where: { id }, data: data as object });
    await this.quality.evaluate(id, false); // FR-271: re-score on edit
    this.invalidateIdea();
    return this.get(id, { id: userId });
  }

  async publish(userId: string, idOrSlug: string) {
    const idea = await this.owned(userId, idOrSlug);
    if (idea.status !== 'DRAFT') {
      throw new BadRequestException('Idea is not in draft');
    }
    const id = idea.id;
    // FR-204a: stamp the start of the validation window at publish.
    await this.prisma.idea.update({
      where: { id },
      data: { status: 'VALIDATING', validatingSince: new Date() },
    });
    // FR-272: score and set the discoverability tier (auto-promote if it clears the floor).
    await this.quality.evaluate(id, true);
    this.invalidateIdea();
    const fresh = await this.get(id, { id: userId });
    // FR-1004: screen on publish — advisory + non-blocking (records a ModerationCase).
    await this.moderation.screenSafe(
      {
        kind: 'idea',
        title: fresh.title,
        text: [fresh.problem, fresh.solution, fresh.targetUser, fresh.currentAlternative, fresh.roadmap]
          .filter(Boolean)
          .join('\n'),
      },
      { ideaId: id, submittedById: userId },
    );
    return fresh;
  }

  // FR-271a: creator-facing coaching for their idea.
  async getQuality(idOrSlug: string, viewer?: IdeaViewer) {
    const idea = await this.findIdea(idOrSlug);
    this.assertReadable(idea, viewer);
    return this.quality.latestReport(idea.id);
  }

  // Public browse (FR-272/273) or creator dashboard (mine=true).
  async list(query: ListIdeasQueryDto, currentUserId?: string) {
    const now = new Date();

    let whereClause: Record<string, unknown>;
    if (query.mine) {
      if (!currentUserId) {
        throw new ForbiddenException('Must be logged in to view your ideas');
      }
      whereClause = { creatorId: currentUserId };
    } else {
      whereClause = {
        status: { in: ['VALIDATING', 'THRESHOLD_MET'] },
        discoverabilityTier: { in: ['DISCOVERABLE', 'FEATURED'] },
      };
    }

    const taxonomy = resolveTaxonomyPair(
      query.taxonomyCategory,
      query.taxonomySubcategory,
    );
    if (!taxonomy.ok) throw new BadRequestException(taxonomy.reason);
    if (taxonomy.pair) {
      whereClause.taxonomyCategorySlug = taxonomy.pair.category;
      if (taxonomy.pair.subcategory) {
        whereClause.taxonomySubcategorySlug = taxonomy.pair.subcategory;
      }
    }

    const limit = clampPageSize(query.limit);
    const fingerprint = filterFingerprint({
      route: 'ideas.list',
      mine: Boolean(query.mine),
      viewer: query.mine ? (currentUserId ?? null) : null,
      taxonomyCategory: taxonomy.pair?.category ?? null,
      taxonomySubcategory: taxonomy.pair?.subcategory ?? null,
    });
    const cursor = query.cursor
      ? decodeCursor(query.cursor, fingerprint)
      : null;

    const loadPage = async () => {
      const [ideas, gateThresholds] = await Promise.all([
        this.prisma.idea.findMany({
          where: cursor
            ? {
                AND: [
                  whereClause,
                  keysetCondition('createdAt', 'desc', cursor, asCursorDate),
                ],
              }
            : whereClause,
          include: {
            creator: {
              include: { creatorProfile: true },
            },
            boosts: {
              where: {
                startsAt: { lte: now },
                OR: [{ endsAt: null }, { endsAt: { gt: now } }],
              },
            },
          },
          // Newest first with an id tie-breaker: the order must be total, or a page
          // boundary can repeat or skip an idea created in the same millisecond.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
        }),
        this.loadGateThresholds(),
      ]);

      // Prisma's relation `_count` compiles to a grouped aggregate over the whole
      // Idea table, so every page paid for a 50k-row scan. Count only the creators
      // on this page instead; the (creatorId, ...) index serves the IN list.
      const creatorIds = [...new Set(ideas.map((idea) => idea.creatorId))];
      const creatorCounts = creatorIds.length
        ? await this.prisma.idea.groupBy({
            by: ['creatorId'],
            where: { creatorId: { in: creatorIds } },
            _count: { _all: true },
          })
        : [];
      const ideasPublishedByCreator = new Map(
        creatorCounts.map((row) => [row.creatorId, row._count._all]),
      );

      const rows = ideas.map(
        ({
          boosts,
          creator,
          taxonomyCategorySlug,
          taxonomySubcategorySlug,
          ...idea
        }) => ({
          ...idea,
          taxonomy: toTaxonomyProjection(
            taxonomyCategorySlug,
            taxonomySubcategorySlug,
          ),
          creator: creator
            ? toPublicCreator({
                ...creator,
                ideasPublished: ideasPublishedByCreator.get(creator.id) ?? 0,
              })
            : null,
          gateProgress: this.gateProgressFor(idea, gateThresholds),
          promoted: boosts.length > 0,
          boostTier: boosts[0]?.tier ?? null,
        }),
      );

      return buildPage(rows, limit, (idea) =>
        encodeCursor(idea.createdAt.toISOString(), idea.id, fingerprint),
      );
    };

    // A creator's own list is personalised and must never be shared between
    // callers. Public pages are cache-aside for 20 s; the filter fingerprint and
    // cursor are part of the key (see filterFingerprint).
    if (query.mine) return loadPage();
    return this.cache
      ? this.cache.getOrSet(
          'ideas',
          `${fingerprint}:${limit}:${query.cursor ?? 'first'}`,
          20,
          loadPage,
        )
      : loadPage();
  }

  async get(idOrSlug: string, viewer?: IdeaViewer) {
    const loadIdea = async () => {
      const idea = await this.prisma.idea.findFirst({
        where: {
          OR: [{ id: idOrSlug }, { slug: idOrSlug }],
        },
        include: {
          creator: {
            include: { creatorProfile: true },
          },
        },
      });
      if (!idea) throw new NotFoundException('Idea not found');
      this.assertReadable(idea, viewer);

      const [gateThresholds, ideasPublished] = await Promise.all([
        this.loadGateThresholds(),
        // Same reason as the list: avoid Prisma's full-table relation count.
        this.prisma.idea.count({ where: { creatorId: idea.creatorId } }),
      ]);

      const gateProgress = this.gateProgressFor(idea, gateThresholds);

      const {
        creator,
        taxonomyCategorySlug,
        taxonomySubcategorySlug,
        ...rest
      } = idea;
      return {
        ...rest,
        taxonomy: toTaxonomyProjection(
          taxonomyCategorySlug,
          taxonomySubcategorySlug,
        ),
        creator: creator
          ? toPublicCreator({ ...creator, ideasPublished })
          : null,
        gateProgress,
      };
    };

    // A viewer may be allowed to see a DRAFT, and unpublished projections must
    // never enter the public cache, so authenticated reads bypass cache-aside.
    // The key prefix also retires anything cached before the visibility guard.
    if (viewer) return loadIdea();

    return this.cache
      ? this.cache.getOrSet('idea', `public:v2:${idOrSlug}`, 30, loadIdea)
      : loadIdea();
  }

  // FR-202: support signal, idempotent per (idea, user).
  async support(userId: string, idOrSlug: string) {
    const idea = await this.assertSignalable(idOrSlug);
    const id = idea.id;
    // A repeat support is a no-op, so it is not a new signal for analytics either.
    const existing = await this.prisma.ideaSignal.findUnique({
      where: { ideaId_userId_type: { ideaId: id, userId, type: 'SUPPORT' } },
      select: { id: true },
    });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.ideaSignal.upsert({
        where: { ideaId_userId_type: { ideaId: id, userId, type: 'SUPPORT' } },
        update: {},
        create: { ideaId: id, userId, type: 'SUPPORT' },
      });
      return this.metrics.recompute(tx, id);
    });
    this.invalidateIdea();
    // Analytics is written after the domain commit and never fails the action.
    if (!existing) {
      await this.analytics?.record({
        name: 'IDEA_SIGNAL',
        userId,
        ideaId: id,
        signalType: 'SUPPORT',
        occurredAt: new Date(),
      });
    }
    return result;
  }

  async unsupport(userId: string, idOrSlug: string) {
    const idea = await this.assertSignalable(idOrSlug);
    const id = idea.id;
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.ideaSignal.deleteMany({
        where: { ideaId: id, userId, type: 'SUPPORT' },
      });
      return this.metrics.recompute(tx, id);
    });
    this.invalidateIdea();
    return result;
  }

  // FR-202: pre-pledge intent — NO funds move. FR-210: normalize to USD; the weighted
  // figure (not this raw amount) is what the graduation gate reads.
  async prePledge(userId: string, idOrSlug: string, dto: PrePledgeDto) {
    const idea = await this.assertSignalable(idOrSlug);
    const id = idea.id;
    const currency = dto.currency ?? 'USD';
    const amountUsd = await this.metrics.normalizeToUsd(dto.amount, currency);
    const existing = await this.prisma.ideaSignal.findUnique({
      where: { ideaId_userId_type: { ideaId: id, userId, type: 'PRE_PLEDGE' } },
      select: { id: true },
    });
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.ideaSignal.upsert({
        where: { ideaId_userId_type: { ideaId: id, userId, type: 'PRE_PLEDGE' } },
        update: { amount: dto.amount, currency, amountUsd },
        create: {
          ideaId: id,
          userId,
          type: 'PRE_PLEDGE',
          amount: dto.amount,
          currency,
          amountUsd,
        },
      });
      return this.metrics.recompute(tx, id);
    });
    this.invalidateIdea();
    if (!existing) {
      await this.analytics?.record({
        name: 'IDEA_SIGNAL',
        userId,
        ideaId: id,
        signalType: 'PRE_PLEDGE',
        occurredAt: new Date(),
      });
    }
    return result;
  }

  // FR-211: withdraw a pre-pledge - a withdrawable signal is a more honest signal.
  async withdrawPrePledge(userId: string, idOrSlug: string) {
    const idea = await this.assertSignalable(idOrSlug);
    const id = idea.id;
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.ideaSignal.deleteMany({
        where: { ideaId: id, userId, type: 'PRE_PLEDGE' },
      });
      return this.metrics.recompute(tx, id);
    });
    this.invalidateIdea();
    return result;
  }

  /**
   * Map the nested taxonomy DTO onto the two stored slug columns. The pair is
   * validated here rather than in the DTO because the child is only valid under
   * its own parent, which a field-level validator cannot see.
   */
  private taxonomyFields(
    taxonomy?: { category: string; subcategory?: string } | null,
  ): {
    taxonomyCategorySlug: string | null;
    taxonomySubcategorySlug: string | null;
  } {
    const resolved = resolveTaxonomyPair(
      taxonomy?.category,
      taxonomy?.subcategory,
    );
    if (!resolved.ok) throw new BadRequestException(resolved.reason);
    return {
      taxonomyCategorySlug: resolved.pair?.category ?? null,
      taxonomySubcategorySlug: resolved.pair?.subcategory ?? null,
    };
  }

  /**
   * A signal changes supporter count and both pre-pledge totals, which appear on
   * the detail page and on every list card. Bump both generations once the
   * transaction has committed so a racing read cannot cache pre-commit values.
   */
  private invalidateIdea(): void {
    this.cache?.bumpEventually('idea');
    this.cache?.bumpEventually('ideas');
  }

  // Validation signals may only target a PUBLISHED, still-validating idea.
  private async assertSignalable(idOrSlug: string) {
    const idea = await this.findIdea(idOrSlug);
    if (idea.status !== 'VALIDATING' && idea.status !== 'THRESHOLD_MET') {
      throw new BadRequestException('Idea is not open for validation signals');
    }
    return idea;
  }

  private async owned(userId: string, idOrSlug: string) {
    const idea = await this.findIdea(idOrSlug);
    if (idea.creatorId !== userId) throw new ForbiddenException('Not your idea');
    return idea;
  }

  // FR-275: cap concurrent non-archived/non-converted ideas per creator (default 3) to
  // prevent spray-and-pray. Admin-tunable via idea.maxActivePerCreator.
  private async assertUnderConcurrencyCap(userId: string) {
    const max = await this.params.getNumber('idea.maxActivePerCreator', 3);
    const active = await this.prisma.idea.count({
      where: { creatorId: userId, status: { notIn: ['ARCHIVED', 'CONVERTED'] } },
    });
    if (active >= max) {
      throw new BadRequestException(`You can have at most ${max} active ideas at once`);
    }
  }
}
