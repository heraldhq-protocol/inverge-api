import { PrismaService } from '../../prisma/prisma.service';
import { CommentsService } from './comments.service';

const IDEA = {
  id: 'idea-1',
  status: 'VALIDATING',
  creatorId: 'creator-1',
  title: 'Solar cold storage',
};

function member(userId: string) {
  return {
    id: userId,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    kycStatus: 'NOT_REQUIRED',
    creatorProfile: {
      avatarUrl: null,
      displayName: 'Ada',
      tenureStartedAt: null,
      tier: 'STARTER',
    },
  };
}

function createdComment(data: Record<string, unknown>) {
  return {
    ...data,
    createdAt: new Date(),
    highlighted: false,
    id: 'comment-1',
    likeCount: 0,
    user: member(String(data.userId)),
  };
}

function prisma(options: {
  parent?: { id: string; userId: string; ideaId: string } | null;
} = {}) {
  return {
    idea: {
      findFirst: jest.fn().mockResolvedValue(IDEA),
    },
    ideaComment: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
        createdComment(data),
      ),
      findUnique: jest.fn().mockResolvedValue(options.parent ?? null),
    },
    $transaction: jest.fn(async (callback: (client: unknown) => unknown) =>
      callback({
        ideaComment: {
          count: jest.fn().mockResolvedValue(1),
          create: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
            createdComment(data),
          ),
        },
        idea: { update: jest.fn().mockResolvedValue({}) },
      }),
    ),
  };
}

function service(
  client: ReturnType<typeof prisma>,
  notify = jest.fn().mockResolvedValue(undefined),
) {
  const svc = new CommentsService(
    client as unknown as PrismaService,
    { notify } as never,
  );
  return { svc, notify };
}

describe('CommentsService notifications', () => {
  it('notifies the idea creator with a confirmed comment event', async () => {
    const client = prisma();
    const { svc, notify } = service(client);

    await svc.post('backer-1', 'idea-1', { body: 'Looks promising' });

    expect(notify).toHaveBeenCalledWith({
      data: {
        ideaId: 'idea-1',
        ideaTitle: 'Solar cold storage',
        kind: 'COMMENT',
      },
      dedupeKey: 'IDEA_COMMENT:comment-1:creator',
      template: 'IDEA_COMMENT',
      toUserId: 'creator-1',
    });
  });

  it('does not email the creator about their own comment', async () => {
    const client = prisma();
    const { svc, notify } = service(client);

    await svc.post('creator-1', 'idea-1', { body: 'An update' });

    expect(notify).not.toHaveBeenCalled();
  });

  it('notifies a parent comment author once on a reply', async () => {
    const client = prisma({
      parent: { id: 'parent-1', userId: 'backer-2', ideaId: 'idea-1' },
    });
    const { svc, notify } = service(client);

    await svc.post('backer-1', 'idea-1', { body: 'Agreed', parentId: 'parent-1' });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'REPLY' }),
        dedupeKey: 'IDEA_COMMENT:comment-1:parent',
        toUserId: 'backer-2',
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: 'IDEA_COMMENT:comment-1:creator',
        toUserId: 'creator-1',
      }),
    );
  });
});
