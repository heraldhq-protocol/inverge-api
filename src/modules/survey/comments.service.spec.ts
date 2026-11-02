import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CommentsService } from './comments.service';

function prismaMock() {
  const tx = {
    ideaComment: { create: jest.fn() },
    idea: { update: jest.fn() },
    ideaCommentCount: undefined,
  };
  return {
    _tx: tx,
    $transaction: jest.fn(async (callback: (client: any) => unknown) =>
      callback({
        ...tx,
        ideaComment: {
          create: jest.fn().mockResolvedValue({
            body: 'Hello',
            createdAt: new Date('2026-11-01T10:00:00.000Z'),
            highlighted: false,
            id: 'comment-1',
            ideaId: 'idea-1',
            likeCount: 0,
            parentId: null,
            userId: 'user-1',
            user: {
              createdAt: new Date('2026-01-01T00:00:00.000Z'),
              creatorProfile: {
                avatarUrl: null,
                displayName: 'Ada Obi',
                username: 'ada',
              },
              id: 'user-1',
            },
          }),
          count: jest.fn().mockResolvedValue(1),
        },
      }),
    ),
    idea: { findFirst: jest.fn() },
    ideaComment: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
    },
  } as any;
}

const moderationMock = () =>
  ({ screenSafe: jest.fn().mockResolvedValue(null) }) as any;

function make() {
  const prisma = prismaMock();
  const moderation = moderationMock();
  return { moderation, prisma, svc: new CommentsService(prisma, moderation) };
}

describe('CommentsService public read', () => {
  it('does not expose a draft idea thread', async () => {
    // #given
    const { prisma, svc } = make();
    prisma.idea.findFirst.mockResolvedValue({
      creatorId: 'creator-1',
      id: 'idea-1',
      status: 'DRAFT',
    });

    // #when / #then
    await expect(svc.list('idea-1', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.ideaComment.findMany).not.toHaveBeenCalled();
  });

  it('reads a converted idea thread as history', async () => {
    // #given
    const { prisma, svc } = make();
    prisma.idea.findFirst.mockResolvedValue({
      creatorId: 'creator-1',
      id: 'idea-1',
      status: 'CONVERTED',
    });

    // #when
    const page = await svc.list('idea-1', { limit: 20 });

    // #then
    expect(page.data).toEqual([]);
    expect(prisma.ideaComment.findMany).toHaveBeenCalled();
  });
});

describe('CommentsService.post', () => {
  it('posts as the authenticated author and records a moderation case', async () => {
    // #given
    const { moderation, prisma, svc } = make();
    prisma.idea.findFirst.mockResolvedValue({
      creatorId: 'creator-1',
      id: 'idea-1',
      status: 'VALIDATING',
    });

    // #when
    const created = await svc.post('user-1', 'idea-1', { body: '  Hello  ' });

    // #then
    expect(created.author).toEqual({
      avatarUrl: null,
      displayName: 'Ada Obi',
      id: 'user-1',
      isCreator: false,
    });
    expect(moderation.screenSafe).toHaveBeenCalledWith(
      { kind: 'comment', text: 'Hello' },
      { ideaId: 'idea-1', submittedById: 'user-1' },
    );
  });

  it('rejects posting on an archived idea', async () => {
    // #given
    const { prisma, svc } = make();
    prisma.idea.findFirst.mockResolvedValue({
      creatorId: 'creator-1',
      id: 'idea-1',
      status: 'ARCHIVED',
    });

    // #when / #then
    await expect(
      svc.post('user-1', 'idea-1', { body: 'Hello' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a body that is only whitespace', async () => {
    // #given
    const { prisma, svc } = make();
    prisma.idea.findFirst.mockResolvedValue({
      creatorId: 'creator-1',
      id: 'idea-1',
      status: 'VALIDATING',
    });

    // #when / #then
    await expect(
      svc.post('user-1', 'idea-1', { body: '   ' }),
    ).rejects.toThrow('A comment needs text');
  });
});
