import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { CreateCommentDto } from './dto/comment.dto';

import { toPublicCreator } from '../../common/projections/creator-profile.projection';

// Free-form comments thread on an idea (distinct from the structured survey). Comments
// can be liked and replied to. Thread volume feeds Idea.commentCount (engagement metric,
// FR-273); it does NOT touch the FR-203 validation metrics (feedbackScore etc.).
@Injectable()
export class CommentsService {
  constructor(private readonly prisma: PrismaService) {}

  async post(userId: string, ideaId: string, dto: CreateCommentDto) {
    await this.assertPublished(ideaId);
    if (dto.parentId) {
      const parent = await this.prisma.ideaComment.findUnique({ where: { id: dto.parentId } });
      if (!parent || parent.ideaId !== ideaId) throw new NotFoundException('Parent comment not found');
    }
    return this.prisma.$transaction(async (tx) => {
      const comment = await tx.ideaComment.create({
        data: { ideaId, userId, body: dto.body, parentId: dto.parentId ?? null },
      });
      await this.recountComments(tx, ideaId);
      return comment;
    });
  }

  // Public: highlighted first, then most-liked, then most-recent. Flat list carrying
  // parentId + likeCount so the client can nest replies. Includes author projection.
  async list(ideaId: string, currentUserId?: string) {
    await this.exists(ideaId);
    const creatorId = await this.ideaCreator(ideaId);
    const comments = await this.prisma.ideaComment.findMany({
      where: { ideaId },
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
      orderBy: [{ highlighted: 'desc' }, { likeCount: 'desc' }, { createdAt: 'desc' }],
      take: 300,
    });

    return comments.map((comment) => {
      const publicCreator = toPublicCreator(comment.user);
      const isCreator = comment.userId === creatorId;
      const { user, likes, ...rest } = comment;

      return {
        ...rest,
        author: {
          id: comment.user.id,
          displayName: publicCreator?.displayName ?? null,
          avatarUrl: publicCreator?.avatarUrl ?? null,
          isCreator,
        },
        ...(currentUserId ? { likedByMe: Array.isArray(likes) && likes.length > 0 } : {}),
      };
    });
  }

  async like(userId: string, ideaId: string, commentId: string) {
    await this.load(ideaId, commentId);
    return this.prisma.$transaction(async (tx) => {
      await tx.commentLike.upsert({
        where: { commentId_userId: { commentId, userId } },
        update: {},
        create: { commentId, userId },
      });
      return this.recountLikes(tx, commentId);
    });
  }

  async unlike(userId: string, ideaId: string, commentId: string) {
    await this.load(ideaId, commentId);
    return this.prisma.$transaction(async (tx) => {
      await tx.commentLike.deleteMany({ where: { commentId, userId } });
      return this.recountLikes(tx, commentId);
    });
  }

  // Author or the idea's creator may delete (cascades replies + likes).
  async remove(userId: string, ideaId: string, commentId: string) {
    const comment = await this.load(ideaId, commentId);
    const creatorId = await this.ideaCreator(ideaId);
    if (comment.userId !== userId && creatorId !== userId) {
      throw new ForbiddenException('You cannot delete this comment');
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.ideaComment.delete({ where: { id: commentId } });
      await this.recountComments(tx, ideaId);
      return { deleted: true };
    });
  }

  async setHighlight(userId: string, ideaId: string, commentId: string, highlighted: boolean) {
    await this.load(ideaId, commentId);
    if ((await this.ideaCreator(ideaId)) !== userId) {
      throw new ForbiddenException('Only the idea creator can highlight comments');
    }
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

  private async ideaCreator(ideaId: string): Promise<string> {
    const idea = await this.prisma.idea.findUnique({ where: { id: ideaId }, select: { creatorId: true } });
    if (!idea) throw new NotFoundException('Idea not found');
    return idea.creatorId;
  }

  private async exists(ideaId: string) {
    const idea = await this.prisma.idea.findUnique({ where: { id: ideaId }, select: { id: true } });
    if (!idea) throw new NotFoundException('Idea not found');
  }

  private async assertPublished(ideaId: string) {
    const idea = await this.prisma.idea.findUnique({ where: { id: ideaId }, select: { status: true } });
    if (!idea) throw new NotFoundException('Idea not found');
    if (idea.status !== 'VALIDATING' && idea.status !== 'THRESHOLD_MET') {
      throw new BadRequestException('Idea is not open for comments');
    }
  }
}
