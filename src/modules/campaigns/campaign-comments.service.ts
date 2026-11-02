import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { toPublicCreator } from '../../common/projections/creator-profile.projection';
import {
  asCursorDate,
  buildPage,
  decodeCursor,
  encodeCursor,
  filterFingerprint,
  keysetCondition,
} from '../../common/http/pagination';
import { CreateCampaignCommentDto, ListCommentsQueryDto } from '../survey/dto/comment.dto';
import { ModerationService } from '../moderation/moderation.service';

/**
 * The campaign discussion thread (FR-701).
 *
 * Campaigns are a different record from ideas, so the thread has its own table
 * and its own lifecycle rule: a campaign is readable only while it is publicly
 * funded or finished. `DRAFT`, `IN_REVIEW`, `REJECTED` and `CANCELLED` rows are
 * never returnable here, including by guessed id or source-idea slug.
 *
 * Authentication and ownership are re-checked on every write. Nothing is
 * derived from a body field, and the author is always the server-side session
 * user.
 */
@Injectable()
export class CampaignCommentsService {
  private static readonly PAGE_SIZE = 50;
  private static readonly MAX_PAGE_SIZE = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  private async resolvePublicCampaign(idOrSlug: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: {
        AND: [
          { OR: [{ id: idOrSlug }, { idea: { is: { slug: idOrSlug } } }] },
          { status: { in: ['ACTIVE', 'FUNDED', 'FAILED', 'COMPLETED'] } },
        ],
      },
      select: { id: true, creatorId: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  async list(idOrSlug: string, query: ListCommentsQueryDto) {
    const campaign = await this.resolvePublicCampaign(idOrSlug);
    const limit = Math.min(
      Math.max(query.limit ?? CampaignCommentsService.PAGE_SIZE, 1),
      CampaignCommentsService.MAX_PAGE_SIZE,
    );
    const fingerprint = filterFingerprint({
      route: 'campaigns.comments',
      campaignId: campaign.id,
      sort: 'createdAt_desc,id_desc',
    });
    const cursor = query.cursor
      ? decodeCursor(query.cursor, fingerprint)
      : null;

    const comments = await this.prisma.campaignComment.findMany({
      where: {
        campaignId: campaign.id,
        ...(cursor
          ? keysetCondition('createdAt', 'desc', cursor, asCursorDate)
          : {}),
      },
      include: {
        user: { include: { creatorProfile: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const page = buildPage(comments, limit, (comment) =>
      encodeCursor(comment.createdAt.toISOString(), comment.id, fingerprint),
    );

    return {
      data: page.data.map((comment) =>
        this.toPublicComment(comment, campaign.creatorId),
      ),
      page: page.page,
    };
  }

  async post(userId: string, idOrSlug: string, dto: CreateCampaignCommentDto) {
    const campaign = await this.resolvePublicCampaign(idOrSlug);
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('A comment needs text');

    // Advisory only (NFR-17/D1): a review case is recorded and never blocks the
    // post or changes visibility.
    await this.moderation.screenSafe(
      { kind: 'comment', text: body },
      { campaignId: campaign.id, submittedById: userId },
    );

    const comment = await this.prisma.campaignComment.create({
      data: { body, campaignId: campaign.id, userId },
      include: { user: { include: { creatorProfile: true } } },
    });

    return this.toPublicComment(comment, campaign.creatorId);
  }

  /**
   * The author may delete their comment; the campaign creator may also remove a
   * comment from their campaign thread. Nobody else can mutate it.
   */
  async remove(userId: string, idOrSlug: string, commentId: string) {
    const campaign = await this.resolvePublicCampaign(idOrSlug);
    const comment = await this.prisma.campaignComment.findUnique({
      where: { id: commentId },
      select: { id: true, campaignId: true, userId: true },
    });
    if (!comment || comment.campaignId !== campaign.id) {
      throw new NotFoundException('Comment not found');
    }
    if (comment.userId !== userId && campaign.creatorId !== userId) {
      throw new ForbiddenException('You cannot delete this comment');
    }

    await this.prisma.campaignComment.delete({ where: { id: commentId } });
    return { deleted: true };
  }

  private toPublicComment(
    comment: Prisma.CampaignCommentGetPayload<{
      include: { user: { include: { creatorProfile: true } } };
    }>,
    campaignCreatorId: string,
  ) {
    const publicCreator = toPublicCreator(comment.user);
    return {
      id: comment.id,
      campaignId: comment.campaignId,
      body: comment.body,
      createdAt: comment.createdAt,
      author: {
        id: comment.user.id,
        displayName: publicCreator?.displayName ?? null,
        avatarUrl: publicCreator?.avatarUrl ?? null,
        isCreator: comment.userId === campaignCreatorId,
      },
    };
  }
}
