import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { toPublicCreator } from '../../common/projections/creator-profile.projection';
import { ListCampaignsQueryDto } from './dto/campaign.dto';

@Injectable()
export class CampaignsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListCampaignsQueryDto, currentUserId?: string) {
    let whereClause: Record<string, unknown> = {};

    if (query.mine) {
      if (!currentUserId) {
        throw new ForbiddenException('Must be logged in to view your campaigns');
      }
      whereClause.creatorId = currentUserId;
    } else {
      if (query.status) {
        whereClause.status = query.status;
      } else {
        // INVARIANT (gap item 13): FAILED campaigns are NEVER excluded from default queries.
        whereClause.status = { in: ['ACTIVE', 'FUNDED', 'FAILED', 'COMPLETED'] };
      }
    }

    if (query.category || query.region) {
      whereClause.idea = {
        is: {
          ...(query.category ? { category: query.category } : {}),
          ...(query.region ? { region: query.region } : {}),
        },
      };
    }

    let orderBy: object = { createdAt: 'desc' };
    if (query.sort === 'closing-soon') {
      orderBy = { deadline: 'asc' };
    } else if (query.sort === 'most-backed') {
      orderBy = { totalRaised: 'desc' };
    } else if (query.sort === 'newest') {
      orderBy = { createdAt: 'desc' };
    }

    const campaigns = await this.prisma.campaign.findMany({
      where: whereClause,
      include: {
        creator: {
          include: { creatorProfile: true },
        },
        idea: true,
        milestones: {
          include: {
            claims: {
              orderBy: { submittedAt: 'desc' },
              take: 1,
            },
          },
        },
      },
      orderBy,
      skip: query.skip ?? 0,
      take: query.take ?? 50,
    });

    const result = campaigns.map((campaign) => {
      const { creator, milestones, ...rest } = campaign;
      const totalMilestones = milestones.length;
      const releasedMilestones = milestones.filter(
        (m) => m.claims[0]?.status === 'APPROVED',
      ).length;

      return {
        ...rest,
        creator: toPublicCreator(creator),
        milestoneSummary: {
          total: totalMilestones,
          released: releasedMilestones,
        },
      };
    });

    if (query.sort === 'most-delivered') {
      result.sort(
        (a, b) => b.milestoneSummary.released - a.milestoneSummary.released,
      );
    }

    return result;
  }

  async get(id: string, currentUserId?: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id },
      include: {
        creator: {
          include: { creatorProfile: true },
        },
        idea: true,
        milestones: {
          orderBy: { index: 'asc' },
          include: {
            claims: {
              orderBy: { submittedAt: 'desc' },
              take: 1,
            },
          },
        },
        contributions: currentUserId
          ? {
              where: { userId: currentUserId },
              take: 1,
            }
          : false,
      },
    });

    if (!campaign) throw new NotFoundException('Campaign not found');

    const { creator, milestones, contributions, ...rest } = campaign;

    const formattedMilestones = milestones.map((m) => {
      const latestClaim = m.claims[0] ?? null;
      return {
        id: m.id,
        index: m.index,
        title: m.title,
        deliverable: m.deliverable,
        tranchePct: Number(m.tranchePct),
        evidenceDefinition: m.evidenceDefinition,
        latestClaim: latestClaim
          ? {
              id: latestClaim.id,
              submittedAt: latestClaim.submittedAt,
              objectionWindowEndsAt: latestClaim.objectionWindowEndsAt,
              status: latestClaim.status,
            }
          : null,
      };
    });

    const myContribution =
      Array.isArray(contributions) && contributions.length > 0
        ? {
            amount: Number(contributions[0].amount),
            tokenType: contributions[0].tokenType,
            txSignature: contributions[0].txSignature,
            createdAt: contributions[0].createdAt,
          }
        : null;

    return {
      ...rest,
      creator: toPublicCreator(creator),
      milestones: formattedMilestones,
      myContribution,
    };
  }

  async submit(userId: string, campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
    });

    if (!campaign) throw new NotFoundException('Campaign not found');
    if (campaign.creatorId !== userId) {
      throw new ForbiddenException('Not your campaign');
    }
    if (campaign.status !== 'DRAFT') {
      throw new BadRequestException('Only draft campaigns can be submitted for review');
    }

    const updated = await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'IN_REVIEW' },
      include: {
        creator: {
          include: { creatorProfile: true },
        },
      },
    });

    const { creator, ...rest } = updated;
    return {
      ...rest,
      creator: toPublicCreator(creator),
    };
  }

  async getPlatformEscrowStats() {
    const [events, activeCount, completedCount, refundedCount, activeCampaigns] =
      await Promise.all([
        this.prisma.onChainEvent.findMany({
          select: { eventType: true, amount: true },
        }),
        this.prisma.campaign.count({ where: { status: 'ACTIVE' } }),
        this.prisma.campaign.count({ where: { status: 'COMPLETED' } }),
        this.prisma.campaign.count({ where: { status: 'FAILED' } }),
        this.prisma.campaign.aggregate({
          where: { status: 'ACTIVE' },
          _sum: { totalRaised: true },
        }),
      ]);

    let releasedSum = 0;
    let refundedSum = 0;

    for (const event of events) {
      const amt = Number(event.amount ?? 0);
      if (event.eventType === 'TRANCHE_RELEASED') {
        releasedSum += amt;
      } else if (event.eventType === 'REFUND_CLAIMED') {
        refundedSum += amt;
      }
    }

    const heldUsd = (Number(activeCampaigns._sum.totalRaised ?? 0) - releasedSum).toFixed(2);

    return {
      heldUsd,
      releasedUsd: releasedSum.toFixed(2),
      refundedUsd: refundedSum.toFixed(2),
      counts: {
        active: activeCount,
        completed: completedCount,
        refunded: refundedCount,
      },
    };
  }
}
