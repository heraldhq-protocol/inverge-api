import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { slugify } from '../../common/utils/slug.util';
import {
  CreateIdeaDto,
  FeedbackDto,
  ListIdeasQueryDto,
  PrePledgeDto,
  UpdateIdeaDto,
} from './dto/idea.dto';

@Injectable()
export class IdeasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  create(userId: string, dto: CreateIdeaDto) {
    return this.prisma.idea.create({
      data: {
        creatorId: userId,
        title: dto.title,
        slug: slugify(dto.title),
        problem: dto.problem,
        solution: dto.solution,
        roadmap: dto.roadmap,
        askAmount: dto.askAmount,
        creatorPrePledgeTarget: dto.creatorPrePledgeTarget ?? null,
        status: 'DRAFT',
      },
    });
  }

  async update(userId: string, id: string, dto: UpdateIdeaDto) {
    const idea = await this.owned(userId, id);
    if (idea.status !== 'DRAFT') {
      throw new BadRequestException('Only draft ideas can be edited');
    }
    return this.prisma.idea.update({ where: { id }, data: { ...dto } });
  }

  async publish(userId: string, id: string) {
    const idea = await this.owned(userId, id);
    if (idea.status !== 'DRAFT') {
      throw new BadRequestException('Idea is not in draft');
    }
    // FR-204a: stamp the start of the validation window at publish.
    return this.prisma.idea.update({
      where: { id },
      data: { status: 'VALIDATING', validatingSince: new Date() },
    });
  }

  // Public browse. Boosted ideas surface first in DISCOVERY ONLY (FR-206a); the
  // validation metrics returned are the idea's own columns — boosts are not merged in.
  async list(query: ListIdeasQueryDto) {
    const now = new Date();
    const ideas = await this.prisma.idea.findMany({
      where: { status: { in: ['VALIDATING', 'THRESHOLD_MET'] } },
      include: {
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
      .map(({ boosts, ...idea }) => ({
        ...idea,
        promoted: boosts.length > 0,
        boostTier: boosts[0]?.tier ?? null,
      }))
      .sort((a, b) => Number(b.promoted) - Number(a.promoted));
  }

  async get(id: string) {
    const idea = await this.prisma.idea.findUnique({ where: { id } });
    if (!idea) throw new NotFoundException('Idea not found');
    return idea;
  }

  // FR-202: support signal, idempotent per (idea, user).
  async support(userId: string, id: string) {
    await this.assertSignalable(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.ideaSignal.upsert({
        where: { ideaId_userId_type: { ideaId: id, userId, type: 'SUPPORT' } },
        update: {},
        create: { ideaId: id, userId, type: 'SUPPORT' },
      });
      return this.metrics.recompute(tx, id);
    });
  }

  async unsupport(userId: string, id: string) {
    await this.assertSignalable(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.ideaSignal.deleteMany({
        where: { ideaId: id, userId, type: 'SUPPORT' },
      });
      return this.metrics.recompute(tx, id);
    });
  }

  // FR-202: pre-pledge intent — NO funds move. FR-210: normalize to USD; the weighted
  // figure (not this raw amount) is what the graduation gate reads.
  async prePledge(userId: string, id: string, dto: PrePledgeDto) {
    await this.assertSignalable(id);
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
  async withdrawPrePledge(userId: string, id: string) {
    await this.assertSignalable(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.ideaSignal.deleteMany({
        where: { ideaId: id, userId, type: 'PRE_PLEDGE' },
      });
      return this.metrics.recompute(tx, id);
    });
  }

  // FR-202/203: structured feedback, one per user.
  async feedback(userId: string, id: string, dto: FeedbackDto) {
    await this.assertSignalable(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.ideaFeedback.upsert({
        where: { ideaId_userId: { ideaId: id, userId } },
        update: { rating: dto.rating, body: dto.body },
        create: { ideaId: id, userId, rating: dto.rating, body: dto.body },
      });
      return this.metrics.recompute(tx, id);
    });
  }

  // Validation signals may only target a PUBLISHED, still-validating idea. This stops a
  // backer who knows the id from inflating metrics on an unpublished DRAFT, or mutating a
  // CONVERTED/ARCHIVED idea's frozen figures.
  private async assertSignalable(id: string) {
    const idea = await this.prisma.idea.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!idea) throw new NotFoundException('Idea not found');
    if (idea.status !== 'VALIDATING' && idea.status !== 'THRESHOLD_MET') {
      throw new BadRequestException('Idea is not open for validation signals');
    }
  }

  private async owned(userId: string, id: string) {
    const idea = await this.prisma.idea.findUnique({ where: { id } });
    if (!idea) throw new NotFoundException('Idea not found');
    if (idea.creatorId !== userId) throw new ForbiddenException('Not your idea');
    return idea;
  }
}
