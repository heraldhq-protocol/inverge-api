import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { QualityService } from '../quality/quality.service';
import { ModerationService } from '../moderation/moderation.service';
import { PlatformParamsService } from '../platform-params/platform-params.service';
import { slugify } from '../../common/utils/slug.util';
import { DEFAULT_SURVEY } from '../survey/survey-validation';
import {
  CreateIdeaDto,
  ListIdeasQueryDto,
  PrePledgeDto,
  UpdateIdeaDto,
} from './dto/idea.dto';

import { toPublicCreator } from '../../common/projections/creator-profile.projection';
import { buildGateProgress } from '../metrics/insights-compute';

@Injectable()
export class IdeasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly quality: QualityService,
    private readonly moderation: ModerationService,
    private readonly params: PlatformParamsService,
  ) {}

  private async findIdea(idOrSlug: string) {
    const idea = await this.prisma.idea.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    });
    if (!idea) throw new NotFoundException('Idea not found');
    return idea;
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
    return this.get(idea.id);
  }

  async update(userId: string, idOrSlug: string, dto: UpdateIdeaDto) {
    const idea = await this.owned(userId, idOrSlug);
    if (idea.status !== 'DRAFT') {
      throw new BadRequestException('Only draft ideas can be edited');
    }
    const id = idea.id;
    await this.prisma.idea.update({ where: { id }, data: { ...dto } as object });
    await this.quality.evaluate(id, false); // FR-271: re-score on edit
    return this.get(id);
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
    const fresh = await this.get(id);
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
  async getQuality(idOrSlug: string) {
    const idea = await this.findIdea(idOrSlug);
    return this.quality.latestReport(idea.id);
  }

  // Public browse (FR-272/273) or creator dashboard (mine=true).
  async list(query: ListIdeasQueryDto, currentUserId?: string) {
    const now = new Date();

    let whereClause: object;
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

    const ideas = await this.prisma.idea.findMany({
      where: whereClause,
      include: {
        creator: {
          include: { creatorProfile: true, _count: { select: { ideas: true } } },
        },
        boosts: {
          where: {
            startsAt: { lte: now },
            OR: [{ endsAt: null }, { endsAt: { gt: now } }],
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: query.skip ?? 0,
      take: query.take ?? 50,
    });

    return ideas
      .map(({ boosts, creator, ...idea }) => ({
        ...idea,
        creator: toPublicCreator(creator),
        promoted: boosts.length > 0,
        boostTier: boosts[0]?.tier ?? null,
      }))
      .sort((a, b) => {
        const feat = Number(b.discoverabilityTier === 'FEATURED') - Number(a.discoverabilityTier === 'FEATURED');
        return feat !== 0 ? feat : Number(b.promoted) - Number(a.promoted);
      });
  }

  async get(idOrSlug: string) {
    const idea = await this.prisma.idea.findFirst({
      where: {
        OR: [{ id: idOrSlug }, { slug: idOrSlug }],
      },
      include: {
        creator: {
          include: { creatorProfile: true, _count: { select: { ideas: true } } },
        },
      },
    });
    if (!idea) throw new NotFoundException('Idea not found');

    const [minSupporters, minWeightedUSD, minPct, minFeedbackCount, minAvgFeedbackRating] = await Promise.all([
      this.params.getNumber('validation.minSupporters', 50),
      this.params.getNumber('validation.minWeightedUSD', 2000),
      this.params.getNumber('validation.minPrePledgePctOfAsk', 0.1),
      this.params.getNumber('validation.minFeedbackCount', 10),
      this.params.getNumber('validation.minAvgFeedbackRating', 3),
    ]);

    const gateProgress = buildGateProgress({
      supporterCount: idea.supporterCount ?? 0,
      weighted: Number(idea.weightedPrePledgeTotal ?? 0),
      feedbackCount: idea.feedbackCount ?? 0,
      feedbackScore: Number(idea.feedbackScore ?? 0),
      askAmount: Number(idea.askAmount ?? 0),
      creatorTarget: idea.creatorPrePledgeTarget ? Number(idea.creatorPrePledgeTarget) : 0,
      minSupporters,
      minWeightedUSD,
      minPct,
      minFeedbackCount,
      minAvgFeedbackRating,
    });

    const { creator, ...rest } = idea;
    return {
      ...rest,
      creator: toPublicCreator(creator),
      gateProgress,
    };
  }

  // FR-202: support signal, idempotent per (idea, user).
  async support(userId: string, idOrSlug: string) {
    const idea = await this.assertSignalable(idOrSlug);
    const id = idea.id;
    return this.prisma.$transaction(async (tx) => {
      await tx.ideaSignal.upsert({
        where: { ideaId_userId_type: { ideaId: id, userId, type: 'SUPPORT' } },
        update: {},
        create: { ideaId: id, userId, type: 'SUPPORT' },
      });
      return this.metrics.recompute(tx, id);
    });
  }

  async unsupport(userId: string, idOrSlug: string) {
    const idea = await this.assertSignalable(idOrSlug);
    const id = idea.id;
    return this.prisma.$transaction(async (tx) => {
      await tx.ideaSignal.deleteMany({
        where: { ideaId: id, userId, type: 'SUPPORT' },
      });
      return this.metrics.recompute(tx, id);
    });
  }

  // FR-202: pre-pledge intent — NO funds move. FR-210: normalize to USD; the weighted
  // figure (not this raw amount) is what the graduation gate reads.
  async prePledge(userId: string, idOrSlug: string, dto: PrePledgeDto) {
    const idea = await this.assertSignalable(idOrSlug);
    const id = idea.id;
    const currency = dto.currency ?? 'USD';
    const amountUsd = await this.metrics.normalizeToUsd(dto.amount, currency);
    return this.prisma.$transaction(async (tx) => {
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
  }

  // FR-211: withdraw a pre-pledge — a withdrawable signal is a more honest signal.
  async withdrawPrePledge(userId: string, idOrSlug: string) {
    const idea = await this.assertSignalable(idOrSlug);
    const id = idea.id;
    return this.prisma.$transaction(async (tx) => {
      await tx.ideaSignal.deleteMany({
        where: { ideaId: id, userId, type: 'PRE_PLEDGE' },
      });
      return this.metrics.recompute(tx, id);
    });
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
