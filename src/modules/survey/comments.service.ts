import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { CreateCommentDto, ListCommentsQueryDto } from './dto/comment.dto';
import {
  buildPage,
  filterFingerprint,
} from '../../common/http/pagination';
import {
  commentKeysetWhere,
  decodeCommentCursor,
  encodeCommentCursor,
} from './comment-cursor';

import { toPublicCreator } from '../../common/projections/creator-profile.projection';
import { ModerationService } from '../moderation/moderation.service';

const COMMENT_PAGE_SIZE = 50;
const COMMENT_MAX_PAGE_SIZE = 100;

// Free-form comments thread on an idea (distinct from the structured survey). Comments
// can be liked and replied to. Thread volume feeds Idea.commentCount (engagement metric,
// FR-273); it does NOT touch the FR-203 validation metrics (feedbackScore etc.).
@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderation: ModerationService,
  ) {}

  /**
   * A readable idea. `DRAFT` is unpublished, so its thread is not public even
   * when the caller knows an id. An optional write check keeps posting limited
   * to the lifecycle states FR-273 opens for comments.
   */
  private async resolveIdea(
    idOrSlug: string,
    options: { requireOpen?: boolean } = {},
  ) {
    const idea = await this.prisma.idea.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      select: { id: true, status: true, creatorId: true },
    });
    if (!idea || idea.status === 'DRAFT') {
      throw new NotFoundException('Idea not found');
    }
    if (
      options.requireOpen &&
      idea.status !== 'VALIDATING' &&
      idea.status !== 'THRESHOLD_MET'
    ) {
      throw new BadRequestException('Idea is not open for comments');
    }
    return idea;
  }

  async post(userId: string, ideaIdOrSlug: string, dto: CreateCommentDto) {
    const idea = await this.resolveIdea(ideaIdOrSlug, { requireOpen: true });
    const ideaId = idea.id;
    const body = dto.body.trim();
    if (!body) throw new BadRequestException('A comment needs text');
    if (dto.parentId) {
      const parent = await this.prisma.ideaComment.findUnique({ where: { id: dto.parentId } });
      if (!parent || parent.ideaId !== ideaId) throw new NotFoundException('Parent comment not found');
    }
    // Advisory only (NFR-17/D1): the case informs review and never blocks the
    // post. Comments are public the moment they are created, exactly as before.
    await this.moderation.screenSafe(
      { kind: 'comment', text: body },
      { ideaId, submittedById: userId },
    );
    const comment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.ideaComment.create({
        data: { ideaId, userId, body, parentId: dto.parentId ?? null },
        include: {
          user: {
            include: { creatorProfile: true },
          },
        },
      });
      await this.recountComments(tx, ideaId);
      return created;
    });

    const publicCreator = toPublicCreator(comment.user);
    const isCreator = comment.userId === idea.creatorId;
    const { user, ...rest } = comment;

    return {
      ...rest,
      author: {
        id: comment.user.id,
        displayName: publicCreator?.displayName ?? null,
        avatarUrl: publicCreator?.avatarUrl ?? null,
        isCreator,
      },
    };
  }

  // Public: highlighted first, then most-liked, then most-recent. Flat page carrying
  // parentId + likeCount so the client can nest replies. Includes author projection.
  async list(
    ideaIdOrSlug: string,
    query: ListCommentsQueryDto,
    currentUserId?: string,
  ) {
    const idea = await this.resolveIdea(ideaIdOrSlug);
    const ideaId = idea.id;
    const limit = Math.min(
      Math.max(query.limit ?? COMMENT_PAGE_SIZE, 1),
      COMMENT_MAX_PAGE_SIZE,
    );
    const fingerprint = filterFingerprint({
      route: 'ideas.comments',
      ideaId,
      sort: 'highlighted_desc,likeCount_desc,createdAt_desc,id_desc',
    });
    const cursor = query.cursor
      ? decodeCommentCursor(query.cursor, fingerprint)
      : null;

    const comments = await this.prisma.ideaComment.findMany({
      where: {
        ideaId,
        ...(cursor ? commentKeysetWhere(cursor) : {}),
      },
      include: {
        user: {
          include: { creatorProfile: true },
        },
        likes: currentUserId
          ? {
              where: { userId: currentUserId },
              select: { userId: true },
            }
          : false,
      },
      orderBy: [
        { highlighted: 'desc' },
        { likeCount: 'desc' },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: limit + 1,
    });

    const page = buildPage(comments, limit, (comment) =>
      encodeCommentCursor(comment, fingerprint),
    );

    return {
      data: page.data.map((comment) => {
        const publicCreator = toPublicCreator(comment.user);
        const isCreator = comment.userId === idea.creatorId;
        const { user, likes, ...rest } = comment;

        return {
          ...rest,
          author: {
            id: comment.user.id,
            displayName: publicCreator?.displayName ?? null,
            avatarUrl: publicCreator?.avatarUrl ?? null,
            isCreator,
          },
          ...(currentUserId
            ? { likedByMe: Array.isArray(likes) && likes.length > 0 }
            : {}),
        };
      }),
      page: page.page,
    };
  }

  async like(userId: string, ideaIdOrSlug: string, commentId: string) {
    const idea = await this.resolveIdea(ideaIdOrSlug);
    await this.load(idea.id, commentId);
    return this.prisma.$transaction(async (tx) => {
      await tx.commentLike.upsert({
        where: { commentId_userId: { commentId, userId } },
        update: {},
        create: { commentId, userId },
      });
      return this.recountLikes(tx, commentId);
    });
  }

  async unlike(userId: string, ideaIdOrSlug: string, commentId: string) {
    const idea = await this.resolveIdea(ideaIdOrSlug);
    await this.load(idea.id, commentId);
    return this.prisma.$transaction(async (tx) => {
      await tx.commentLike.deleteMany({ where: { commentId, userId } });
      return this.recountLikes(tx, commentId);
    });
  }

  // Author or the idea's creator may delete (cascades replies + likes).
  async remove(userId: string, ideaIdOrSlug: string, commentId: string) {
    const idea = await this.resolveIdea(ideaIdOrSlug);
    const comment = await this.load(idea.id, commentId);
    if (comment.userId !== userId && idea.creatorId !== userId) {
      throw new ForbiddenException('You cannot delete this comment');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.ideaComment.delete({ where: { id: commentId } });
      await this.recountComments(tx, idea.id);
      return { deleted: true };
    });
  }

  async setHighlight(userId: string, ideaIdOrSlug: string, commentId: string, highlighted: boolean) {
    const idea = await this.resolveIdea(ideaIdOrSlug);
    if (idea.creatorId !== userId) {
      throw new ForbiddenException('Only the idea creator can highlight comments');
    }
    await this.load(idea.id, commentId);
    return this.prisma.ideaComment.update({ where: { id: commentId }, data: { highlighted } });
  }

  private async recountComments(tx: Prisma.TransactionClient, ideaId: string) {
    const commentCount = await tx.ideaComment.count({ where: { ideaId } });
    await tx.idea.update({ where: { id: ideaId }, data: { commentCount } });
  }

  private async recountLikes(tx: Prisma.TransactionClient, commentId: string) {
    const likeCount = await tx.commentLike.count({ where: { commentId } });
    return tx.ideaComment.update({ where: { id: commentId }, data: { likeCount } });
  }

  private async load(ideaId: string, commentId: string) {
    const comment = await this.prisma.ideaComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.ideaId !== ideaId) throw new NotFoundException('Comment not found');
    return comment;
  }
}
