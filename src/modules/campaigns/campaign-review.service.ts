import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { evaluateCampaignReviewGates } from './campaign-review.preconditions';
import {
  nextReviewStatus,
  normalizeReviewReason,
  validateReviewDecision,
} from './campaign-review.rules';
import {
  DecideCampaignReviewDto,
  ListCampaignReviewQueueDto,
} from './dto/campaign-review.dto';

const REVIEW_ACTOR_SELECT = {
  id: true,
  email: true,
  role: true,
} as const;

const QUEUE_CAMPAIGN_SELECT = {
  id: true,
  ideaId: true,
  creatorId: true,
  type: true,
  status: true,
  reviewStatus: true,
  targetAmount: true,
  deadline: true,
  submittedAt: true,
  reviewedAt: true,
  reviewReason: true,
  createdAt: true,
  updatedAt: true,
  creator: {
    select: {
      id: true,
      email: true,
      creatorProfile: {
        select: { displayName: true, username: true, avatarUrl: true },
      },
      business: { select: { legalName: true } },
    },
  },
  idea: { select: { id: true, title: true, category: true, region: true } },
  _count: { select: { milestones: true } },
} as const;

// Admin review of campaigns (FR-304). Reads are projections with no provider
// references; writes append an immutable event and move the review state only.
@Injectable()
export class CampaignReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async listQueue(query: ListCampaignReviewQueueDto) {
    const reviewStatus = query.reviewStatus ?? 'IN_REVIEW';
    const where =
      reviewStatus === 'ALL' ? {} : { reviewStatus };
    const skip = query.skip ?? 0;
    const take = query.take ?? 50;

    const orderBy =
      reviewStatus === 'IN_REVIEW'
        ? [
            { submittedAt: { sort: 'asc' as const, nulls: 'last' as const } },
            { createdAt: 'asc' as const },
          ]
        : [
            { reviewedAt: { sort: 'desc' as const, nulls: 'last' as const } },
            { createdAt: 'desc' as const },
          ];

    const [items, total] = await Promise.all([
      this.prisma.campaign.findMany({
        where,
        select: QUEUE_CAMPAIGN_SELECT,
        orderBy,
        skip,
        take,
      }),
      this.prisma.campaign.count({ where }),
    ]);

    return { items, total, skip, take, reviewStatus };
  }

  async getForReview(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: {
        ...QUEUE_CAMPAIGN_SELECT,
        creator: {
          select: {
            id: true,
            email: true,
            kycStatus: true,
            amlStatus: true,
            creatorProfile: {
              select: { displayName: true, username: true, avatarUrl: true },
            },
            business: {
              select: { legalName: true, kybStatus: true, amlStatus: true },
            },
          },
        },
        tokenType: true,
        fundingFloorPct: true,
        workingCapitalPct: true,
        termsHash: true,
        videoUrl: true,
        videoPosterUrl: true,
        coverImageUrl: true,
        rewardTiers: true,
        ideaSnapshot: true,
        launchedAt: true,
        applicationFeeChargeId: true,
        reviewedBy: { select: REVIEW_ACTOR_SELECT },
        milestones: {
          orderBy: { index: 'asc' },
          select: {
            id: true,
            index: true,
            title: true,
            deliverable: true,
            tranchePct: true,
            evidenceDefinition: true,
          },
        },
        reviewEvents: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            action: true,
            fromStatus: true,
            toStatus: true,
            reason: true,
            createdAt: true,
            actor: { select: REVIEW_ACTOR_SELECT },
          },
        },
      },
    });

    if (!campaign) throw new NotFoundException('Campaign not found');

    const applicationFee = campaign.applicationFeeChargeId
      ? await this.prisma.flatFeeCharge.findUnique({
          where: { id: campaign.applicationFeeChargeId },
          select: {
            id: true,
            userId: true,
            purpose: true,
            status: true,
            amount: true,
            currency: true,
            metadata: true,
            createdAt: true,
          },
        })
      : null;

    const { creator, milestones, reviewEvents, ...rest } = campaign;

    const preconditions = evaluateCampaignReviewGates({
      campaignId: campaign.id,
      creatorId: campaign.creatorId,
      applicationFeeChargeId: campaign.applicationFeeChargeId,
      creator: {
        kycStatus: creator.kycStatus,
        amlStatus: creator.amlStatus,
      },
      business: creator.business,
      applicationFee,
    });

    return {
      campaign: {
        ...rest,
        creator: {
          id: creator.id,
          email: creator.email,
          creatorProfile: creator.creatorProfile,
          business: creator.business,
        },
        milestones: milestones.map((milestone) => ({
          ...milestone,
          tranchePct: Number(milestone.tranchePct),
        })),
      },
      applicationFee: applicationFee
        ? {
            id: applicationFee.id,
            userId: applicationFee.userId,
            purpose: applicationFee.purpose,
            status: applicationFee.status,
            amount: Number(applicationFee.amount),
            currency: applicationFee.currency,
            createdAt: applicationFee.createdAt,
          }
        : null,
      preconditions,
      reviewEvents,
    };
  }

  async decide(
    actorId: string,
    campaignId: string,
    dto: DecideCampaignReviewDto,
  ) {
    const error = validateReviewDecision(dto);
    if (error) throw new BadRequestException(error);

    const reason = normalizeReviewReason(dto.reason);

    return this.prisma.$transaction(async (tx) => {
      const campaign = await tx.campaign.findUnique({
        where: { id: campaignId },
        select: {
          id: true,
          reviewStatus: true,
          creatorId: true,
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
      if (campaign.reviewStatus !== 'IN_REVIEW') {
        throw new ConflictException(
          `Campaign is ${campaign.reviewStatus.toLowerCase()}, not in review`,
        );
      }

      if (dto.action === 'APPROVE') {
        const applicationFee = campaign.applicationFeeChargeId
          ? await tx.flatFeeCharge.findUnique({
              where: { id: campaign.applicationFeeChargeId },
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
          applicationFeeChargeId: campaign.applicationFeeChargeId,
          creator: campaign.creator,
          business: campaign.creator.business,
          applicationFee,
        });

        if (!gates.eligible) {
          throw new UnprocessableEntityException({
            message: 'Campaign is not eligible for approval',
            blockers: gates.blockers,
          });
        }
      }

      const now = new Date();
      const toStatus = nextReviewStatus(dto.action);

      // Conditional on IN_REVIEW so two admins deciding at once cannot both win.
      const updated = await tx.campaign.updateMany({
        where: { id: campaignId, reviewStatus: 'IN_REVIEW' },
        data: {
          reviewStatus: toStatus,
          reviewedAt: now,
          reviewedById: actorId,
          reviewReason: reason,
        },
      });

      if (updated.count !== 1) {
        throw new ConflictException('Campaign review was already decided');
      }

      const event = await tx.campaignReviewEvent.create({
        data: {
          campaignId,
          actorId,
          action: dto.action,
          fromStatus: 'IN_REVIEW',
          toStatus,
          reason,
          createdAt: now,
        },
        select: {
          id: true,
          action: true,
          fromStatus: true,
          toStatus: true,
          reason: true,
          createdAt: true,
          actor: { select: REVIEW_ACTOR_SELECT },
        },
      });

      return {
        id: campaignId,
        reviewStatus: toStatus,
        reviewedAt: now,
        reviewedById: actorId,
        reviewReason: reason,
        event,
      };
    });
  }
}
