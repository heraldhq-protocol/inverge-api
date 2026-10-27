import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { toPublicCreator } from '../../common/projections/creator-profile.projection';
import { evaluateCampaignReviewGates } from './campaign-review.preconditions';
import { VerificationService } from '../kyc/verification.service';
import { ListCampaignsQueryDto, SubmitCampaignDto } from './dto/campaign.dto';
import {
  resolveTaxonomyPair,
  toTaxonomyProjection,
} from '../taxonomy/taxonomy';
import {
  asCursorDate,
  buildPage,
  clampPageSize,
  decodeCursor,
  encodeCursor,
  filterFingerprint,
  keysetCondition,
} from '../../common/http/pagination';

/**
 * The campaign states a visitor may read by direct link.
 *
 * DRAFT, IN_REVIEW and a change-requested draft are creator workspaces, not
 * public pages. `get` therefore resolves them only for the signed-in owner;
 * everyone else gets the same 404 as an unknown id. The discovery list already
 * excludes them, so a direct read must not be the bypass.
 */
const PUBLIC_CAMPAIGN_STATUSES = [
  'ACTIVE',
  'FUNDED',
  'FAILED',
  'COMPLETED',
] as const;

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verification: VerificationService,
    @Optional() private readonly cache?: CacheService,
  ) {}

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

    // Each sort is a total order: `id` breaks ties so a page boundary can never
    // repeat or drop a campaign with the same timestamp or raised amount.
    const sort = query.sort ?? 'newest';
    const sortConfig: {
      orderBy: Prisma.CampaignOrderByWithRelationInput[];
      field: 'createdAt' | 'deadline' | 'totalRaised';
      direction: 'asc' | 'desc';
    } = (() => {
      switch (sort) {
        case 'closing-soon':
          return {
            orderBy: [{ deadline: 'asc' }, { id: 'asc' }],
            field: 'deadline',
            direction: 'asc',
          };
        case 'most-backed':
          return {
            orderBy: [{ totalRaised: 'desc' }, { id: 'desc' }],
            field: 'totalRaised',
            direction: 'desc',
          };
        default:
          return {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            field: 'createdAt',
            direction: 'desc',
          };
      }
    })();

    const limit = clampPageSize(query.limit);
    const fingerprint = filterFingerprint({
      route: 'campaigns.list',
      mine: Boolean(query.mine),
      viewer: query.mine ? (currentUserId ?? null) : null,
      status: query.status ?? null,
      category: query.category ?? null,
      taxonomyCategory: taxonomy.pair?.category ?? null,
      taxonomySubcategory: taxonomy.pair?.subcategory ?? null,
      region: query.region ?? null,
      sort,
    });
    const cursor = query.cursor
      ? decodeCursor(query.cursor, fingerprint)
      : null;

    const loadPage = async () => {
      const campaigns = await this.prisma.campaign.findMany({
        where: cursor
          ? {
              AND: [
                whereClause,
                keysetCondition(sortConfig.field, sortConfig.direction, cursor, (value) =>
                  sortConfig.field === 'totalRaised' ? value : asCursorDate(value),
                ),
              ],
            }
          : whereClause,
        include: {
          creator: {
            include: { creatorProfile: true },
          },
          idea: true,
          // A card only needs the milestone count and whether each one was
          // released. Loading every milestone field for every row was excess.
          milestones: {
            select: {
              id: true,
              claims: {
                orderBy: { submittedAt: 'desc' },
                take: 1,
                select: { status: true },
              },
            },
          },
        },
        orderBy: sortConfig.orderBy,
        take: limit + 1,
      });

      const result = campaigns.map((campaign) => {
        const {
          creator,
          milestones,
          taxonomyCategorySlug,
          taxonomySubcategorySlug,
          ...rest
        } = campaign;
        const totalMilestones = milestones.length;
        const releasedMilestones = milestones.filter(
          (m) => m.claims[0]?.status === 'APPROVED',
        ).length;

        return {
          ...rest,
          taxonomy: toTaxonomyProjection(
            taxonomyCategorySlug,
            taxonomySubcategorySlug,
          ),
          creator: toPublicCreator(creator),
          milestoneSummary: {
            total: totalMilestones,
            released: releasedMilestones,
          },
        };
      });

      return buildPage(result, limit, (campaign) => {
        const sortValue =
          sort === 'closing-soon'
            ? campaign.deadline.toISOString()
            : sort === 'most-backed'
              ? campaign.totalRaised.toString()
              : campaign.createdAt.toISOString();

        return encodeCursor(sortValue, campaign.id, fingerprint);
      });
    };

    // `mine=true` is a creator-specific view and is never cached across callers.
    if (query.mine) return loadPage();
    return this.cache
      ? this.cache.getOrSet(
          'campaigns',
          `${fingerprint}:${limit}:${query.cursor ?? 'first'}`,
          20,
          loadPage,
        )
      : loadPage();
  }

  /**
   * A campaign by id, or by its source idea's public slug.
   *
   * The campaign row has no slug of its own. A campaign converted from an idea
   * can inherit that idea's already-unique public slug for its marketing URL,
   * which keeps the web route stable without a schema migration. Ids keep
   * working, including for campaigns that were never converted from an idea.
   */
  async get(idOrSlug: string, currentUserId?: string) {
    const loadCampaign = async () => {
      const detailInclude = {
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
        ...(currentUserId
          ? {
              contributions: {
                where: { userId: currentUserId },
                take: 1,
              },
            }
          : {}),
      } satisfies Prisma.CampaignInclude;

      const campaign =
        (await this.prisma.campaign.findUnique({
          where: { id: idOrSlug },
          include: detailInclude,
        })) ??
        (await this.prisma.campaign.findFirst({
          where: { idea: { is: { slug: idOrSlug } } },
          include: detailInclude,
        }));

      if (!campaign) throw new NotFoundException('Campaign not found');

      const isOwner = currentUserId === campaign.creatorId;
      const isPublic = (
        PUBLIC_CAMPAIGN_STATUSES as readonly string[]
      ).includes(campaign.status);
      if (!isPublic && !isOwner) {
        throw new NotFoundException('Campaign not found');
      }

      const {
        creator,
        milestones,
        contributions,
        taxonomyCategorySlug,
        taxonomySubcategorySlug,
        ...rest
      } = campaign;

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
        taxonomy: toTaxonomyProjection(
          taxonomyCategorySlug,
          taxonomySubcategorySlug,
        ),
        creator: toPublicCreator(creator),
        milestones: formattedMilestones,
        myContribution,
      };
    };

    // A contribution lookup is viewer-specific: never serve it from a shared key.
    if (currentUserId) return loadCampaign();
    return this.cache
      ? this.cache.getOrSet('campaign', idOrSlug, 30, loadCampaign)
      : loadCampaign();
  }

  // FR-103 + FR-311: a campaign enters the curation queue only when the creator is
  // funds-eligible and a successful application fee is linked. Checks run before the
  // state change and inside the same transaction; an existing fee is reused when a
  // change-requested campaign is resubmitted (the fee is non-refundable, FR-311).
  async submit(userId: string, campaignId: string, dto: SubmitCampaignDto) {
    // Verification is read before the transaction: it is an independent aggregate and
    // must not extend the lock window of the campaign row. Every blocker has a stable
    // code so the web can explain the refusal without parsing prose.
    const verificationGate = await this.verification.campaignGate(userId);
    try {
      const result = await this.prisma.$transaction(async (tx) => {
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
          throw new ForbiddenException({
            code: 'CAMPAIGN_NOT_OWNED',
            message: 'Not your campaign',
          });
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
          verification: {
            accountType: verificationGate.accountType,
            blockers: verificationGate.blockers,
            code: verificationGate.code,
            complianceHold: verificationGate.complianceHold,
            eligible: verificationGate.eligible,
          },
        });

        if (!gates.eligible) {
          throw new BadRequestException({
            blockers: gates.blockers,
            code: gates.code,
            message: 'Campaign cannot enter review yet',
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
      // A submission changes review state visible on the creator and admin
      // surfaces. Invalidate after commit, never inside the transaction.
      this.cache?.bumpEventually('campaigns');
      this.cache?.bumpEventually('campaign');
      return result;
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

  /**
   * Public counters for the marketing homepage (no money, no per-user data).
   *
   * `publishedIdeas` uses exactly the predicate of the public discovery list —
   * `Idea_public_discovery_idx` — so the figure matches what a visitor can find
   * with `GET /ideas`. `totalCampaigns` counts the four public campaign states
   * and therefore excludes DRAFT, IN_REVIEW and REJECTED rows, which are not
   * marketing-visible. Counts are the only reads: an indexed count per counter,
   * never a scan of `Contribution` or `OnChainEvent`, and never an escrow figure.
   */
  async getPlatformSummary() {
    const loadSummary = async () => {
      const [publishedIdeas, activeCampaigns, completedCampaigns, totalCampaigns] =
        await Promise.all([
          this.prisma.idea.count({
            where: {
              status: { in: ['VALIDATING', 'THRESHOLD_MET'] },
              discoverabilityTier: { in: ['DISCOVERABLE', 'FEATURED'] },
            },
          }),
          this.prisma.campaign.count({ where: { status: 'ACTIVE' } }),
          this.prisma.campaign.count({ where: { status: 'COMPLETED' } }),
          this.prisma.campaign.count({
            where: { status: { in: ['ACTIVE', 'FUNDED', 'FAILED', 'COMPLETED'] } },
          }),
        ]);

      return {
        asOf: new Date().toISOString(),
        activeCampaigns,
        completedCampaigns,
        publishedIdeas,
        totalCampaigns,
      };
    };

    return this.cache
      ? this.cache.getOrSet('platform', 'summary', 60, loadSummary)
      : loadSummary();
  }

  async getPlatformEscrowStats() {
    const loadStats = async () => {
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

      const heldUsd = (
        Number(activeCampaigns._sum.totalRaised ?? 0) - releasedSum
      ).toFixed(2);

      return {
        // Escrow figures are a projection of chain events, not an authoritative
        // balance: the label tells a client how fresh the snapshot is.
        asOf: new Date().toISOString(),
        heldUsd,
        releasedUsd: releasedSum.toFixed(2),
        refundedUsd: refundedSum.toFixed(2),
        counts: {
          active: activeCount,
          completed: completedCount,
          refunded: refundedCount,
        },
      };
    };

    return this.cache
      ? this.cache.getOrSet('platform', 'escrow', 60, loadStats)
      : loadStats();
  }
}
