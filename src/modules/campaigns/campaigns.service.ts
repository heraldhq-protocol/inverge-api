import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { toPublicCreator } from '../../common/projections/creator-profile.projection';
import { evaluateCampaignReviewGates } from './campaign-review.preconditions';
import { ListCampaignsQueryDto, SubmitCampaignDto } from './dto/campaign.dto';

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

  // FR-103 + FR-311: a campaign enters the curation queue only when the creator is
  // funds-eligible and a successful application fee is linked. Checks run before the
  // state change and inside the same transaction; an existing fee is reused when a
  // change-requested campaign is resubmitted (the fee is non-refundable, FR-311).
  async submit(userId: string, campaignId: string, dto: SubmitCampaignDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const campaign = await tx.campaign.findUnique({
          where: { id: campaignId },
          select: {
            id: true,
            creatorId: true,
            status: true,
            reviewStatus: true,
            applicationFeeChargeId: true,
            creator: {
              select: {
                kycStatus: true,
                amlStatus: true,
                business: { select: { kybStatus: true, amlStatus: true } },
              },
            },
          },
        });

        if (!campaign) throw new NotFoundException('Campaign not found');
        if (campaign.creatorId !== userId) {
          throw new ForbiddenException('Not your campaign');
        }

        const resubmission =
          campaign.status === 'IN_REVIEW' &&
          campaign.reviewStatus === 'CHANGES_REQUESTED';

        if (campaign.status !== 'DRAFT' && !resubmission) {
          throw new ConflictException(
            'Only draft or changes-requested campaigns can be submitted for review',
          );
        }

        const requestedChargeId = dto.applicationFeeChargeId?.trim();
        if (
          requestedChargeId &&
          campaign.applicationFeeChargeId &&
          requestedChargeId !== campaign.applicationFeeChargeId
        ) {
          throw new BadRequestException(
            'Campaign is already linked to a different application fee',
          );
        }

        const chargeId =
          requestedChargeId ?? campaign.applicationFeeChargeId ?? null;

        if (chargeId) {
          const claimedBy = await tx.campaign.findFirst({
            where: {
              applicationFeeChargeId: chargeId,
              id: { not: campaignId },
            },
            select: { id: true },
          });
          if (claimedBy) {
            throw new ConflictException(
              'That application fee is already linked to another campaign',
            );
          }
        }

        const applicationFee = chargeId
          ? await tx.flatFeeCharge.findUnique({
              where: { id: chargeId },
              select: {
                id: true,
                userId: true,
                purpose: true,
                status: true,
                metadata: true,
              },
            })
          : null;

        const gates = evaluateCampaignReviewGates({
          campaignId: campaign.id,
          creatorId: campaign.creatorId,
          applicationFeeChargeId: chargeId,
          creator: {
            kycStatus: campaign.creator.kycStatus,
            amlStatus: campaign.creator.amlStatus,
          },
          business: campaign.creator.business,
          applicationFee,
        });

        if (!gates.eligible) {
          throw new BadRequestException({
            message: 'Campaign cannot enter review yet',
            blockers: gates.blockers,
          });
        }

        const submittedAt = new Date();
        const updated = await tx.campaign.updateMany({
          where: {
            id: campaignId,
            OR: [
              { status: 'DRAFT' },
              { status: 'IN_REVIEW', reviewStatus: 'CHANGES_REQUESTED' },
            ],
          },
          data: {
            status: 'IN_REVIEW',
            reviewStatus: 'IN_REVIEW',
            submittedAt,
            reviewReason: null,
            reviewedAt: null,
            reviewedById: null,
            applicationFeeChargeId: chargeId,
          },
        });

        if (updated.count !== 1) {
          throw new ConflictException('Campaign is not in a submittable state');
        }

        const updatedCampaign = await tx.campaign.findUniqueOrThrow({
          where: { id: campaignId },
          include: {
            creator: {
              include: { creatorProfile: true },
            },
          },
        });

        const { creator, ...rest } = updatedCampaign;
        return {
          ...rest,
          creator: toPublicCreator(creator),
        };
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'That application fee is already linked to another campaign',
        );
      }
      throw error;
    }
  }

  async getPlatformEscrowStats() {
    // One grouped aggregate instead of loading every indexed event into Node.
    // The table is append-only (FR-803) and grows with every chain event, so the
    // previous `findMany` was an unbounded read once the indexer had history.
    const [eventTotals, activeCount, completedCount, refundedCount, activeCampaigns] =
      await Promise.all([
        this.prisma.onChainEvent.groupBy({
          by: ['eventType'],
          where: {
            eventType: { in: ['TRANCHE_RELEASED', 'REFUND_CLAIMED'] },
          },
          _sum: { amount: true },
        }),
        this.prisma.campaign.count({ where: { status: 'ACTIVE' } }),
        this.prisma.campaign.count({ where: { status: 'COMPLETED' } }),
        this.prisma.campaign.count({ where: { status: 'FAILED' } }),
        this.prisma.campaign.aggregate({
          where: { status: 'ACTIVE' },
          _sum: { totalRaised: true },
        }),
      ]);

    const sumFor = (eventType: 'TRANCHE_RELEASED' | 'REFUND_CLAIMED') =>
      Number(
        eventTotals.find((row) => row.eventType === eventType)?._sum.amount ?? 0,
      );

    const releasedSum = sumFor('TRANCHE_RELEASED');
    const refundedSum = sumFor('REFUND_CLAIMED');

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
