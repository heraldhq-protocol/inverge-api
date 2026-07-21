import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
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
  constructor(private readonly prisma: PrismaService) {}

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
    return this.prisma.idea.update({
      where: { id },
      data: { status: 'VALIDATING' },
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
    await this.exists(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.ideaSignal.upsert({
        where: { ideaId_userId_type: { ideaId: id, userId, type: 'SUPPORT' } },
        update: {},
        create: { ideaId: id, userId, type: 'SUPPORT' },
      });
      return this.recompute(tx, id);
    });
  }

  async unsupport(userId: string, id: string) {
    await this.exists(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.ideaSignal.deleteMany({
        where: { ideaId: id, userId, type: 'SUPPORT' },
      });
      return this.recompute(tx, id);
    });
  }

  // FR-202: pre-pledge intent — NO funds move.
  async prePledge(userId: string, id: string, dto: PrePledgeDto) {
    await this.exists(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.ideaSignal.upsert({
        where: { ideaId_userId_type: { ideaId: id, userId, type: 'PRE_PLEDGE' } },
        update: { amount: dto.amount },
        create: { ideaId: id, userId, type: 'PRE_PLEDGE', amount: dto.amount },
      });
      return this.recompute(tx, id);
    });
  }

  // FR-202/203: structured feedback, one per user.
  async feedback(userId: string, id: string, dto: FeedbackDto) {
    await this.exists(id);
    return this.prisma.$transaction(async (tx) => {
      await tx.ideaFeedback.upsert({
        where: { ideaId_userId: { ideaId: id, userId } },
        update: { rating: dto.rating, body: dto.body },
        create: { ideaId: id, userId, rating: dto.rating, body: dto.body },
      });
      return this.recompute(tx, id);
    });
  }

  // Recomputes ALL public validation metrics from signals/feedback ONLY.
  // Boost data never participates — this is the structural enforcement of FR-206a.
  private async recompute(tx: Prisma.TransactionClient, ideaId: string) {
    const supporterCount = await tx.ideaSignal.count({
      where: { ideaId, type: 'SUPPORT' },
    });
    const pre = await tx.ideaSignal.aggregate({
      where: { ideaId, type: 'PRE_PLEDGE' },
      _sum: { amount: true },
    });
    const fb = await tx.ideaFeedback.aggregate({
      where: { ideaId },
      _avg: { rating: true },
      _count: true,
    });
    return tx.idea.update({
      where: { id: ideaId },
      data: {
        supporterCount,
        prePledgeTotal: pre._sum.amount ?? 0,
        feedbackScore: fb._avg.rating ?? 0,
        feedbackCount: fb._count,
      },
    });
  }

  private async exists(id: string) {
    const idea = await this.prisma.idea.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!idea) throw new NotFoundException('Idea not found');
  }

  private async owned(userId: string, id: string) {
    const idea = await this.prisma.idea.findUnique({ where: { id } });
    if (!idea) throw new NotFoundException('Idea not found');
    if (idea.creatorId !== userId) throw new ForbiddenException('Not your idea');
    return idea;
  }
}
