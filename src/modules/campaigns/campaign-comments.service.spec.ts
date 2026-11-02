import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CampaignCommentsService } from './campaign-comments.service';

function prismaMock() {
  return {
    campaign: { findFirst: jest.fn() },
    campaignComment: {
      create: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
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
  return {
    moderation,
    prisma,
    svc: new CampaignCommentsService(prisma, moderation),
  };
}

const publicCampaign = { id: 'campaign-1', creatorId: 'creator-1' };

const storedComment = {
  id: 'comment-1',
  campaignId: 'campaign-1',
  userId: 'backer-1',
  body: 'When does the first tranche release?',
  createdAt: new Date('2026-11-01T10:00:00.000Z'),
  user: {
    id: 'backer-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    creatorProfile: { displayName: 'Ada Obi', avatarUrl: null, username: 'ada' },
  },
};

describe('CampaignCommentsService.list', () => {
  it('returns a public page with the author projection', async () => {
    // #given
    const { prisma, svc } = make();
    prisma.campaign.findFirst.mockResolvedValue(publicCampaign);
    prisma.campaignComment.findMany.mockResolvedValue([storedComment]);

    // #when
    const page = await svc.list('campaign-1', { limit: 20 });

    // #then
    expect(page.data).toEqual([
      {
        author: {
          avatarUrl: null,
          displayName: 'Ada Obi',
          id: 'backer-1',
          isCreator: false,
        },
        body: storedComment.body,
        campaignId: 'campaign-1',
        createdAt: storedComment.createdAt,
        id: 'comment-1',
      },
    ]);
    expect(page.page.hasMore).toBe(false);
  });

  it('does not find a campaign that is not publicly funded or finished', async () => {
    // #given
    const { prisma, svc } = make();
    prisma.campaign.findFirst.mockResolvedValue(null);

    // #when / #then
    await expect(svc.list('draft-campaign', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.campaignComment.findMany).not.toHaveBeenCalled();
  });

  it('marks the campaign creator in their own thread', async () => {
    // #given
    const { prisma, svc } = make();
    prisma.campaign.findFirst.mockResolvedValue(publicCampaign);
    prisma.campaignComment.findMany.mockResolvedValue([
      {
        ...storedComment,
        userId: 'creator-1',
        user: {
          ...storedComment.user,
          id: 'creator-1',
        },
      },
    ]);

    // #when
    const page = await svc.list('campaign-1', {});

    // #then
    expect(page.data[0]?.author.isCreator).toBe(true);
  });
});

describe('CampaignCommentsService.post', () => {
  it('credits the authenticated user and screens the body', async () => {
    // #given
    const { moderation, prisma, svc } = make();
    prisma.campaign.findFirst.mockResolvedValue(publicCampaign);
    prisma.campaignComment.create.mockResolvedValue(storedComment);

    // #when
    await svc.post('backer-1', 'campaign-1', { body: '  A question  ' });

    // #then
    expect(prisma.campaignComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          body: 'A question',
          campaignId: 'campaign-1',
          userId: 'backer-1',
        },
      }),
    );
    expect(moderation.screenSafe).toHaveBeenCalledWith(
      { kind: 'comment', text: 'A question' },
      { campaignId: 'campaign-1', submittedById: 'backer-1' },
    );
  });

  it('rejects an empty body before it reaches the database', async () => {
    // #given
    const { prisma, svc } = make();
    prisma.campaign.findFirst.mockResolvedValue(publicCampaign);

    // #when / #then
    await expect(
      svc.post('backer-1', 'campaign-1', { body: '   ' }),
    ).rejects.toThrow('A comment needs text');
    expect(prisma.campaignComment.create).not.toHaveBeenCalled();
  });

  it('refuses to post on a campaign that is not public', async () => {
    // #given
    const { prisma, svc } = make();
    prisma.campaign.findFirst.mockResolvedValue(null);

    // #when / #then
    await expect(
      svc.post('backer-1', 'draft-campaign', { body: 'Hello' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CampaignCommentsService.remove', () => {
  it('lets the author delete their own comment', async () => {
    // #given
    const { prisma, svc } = make();
    prisma.campaign.findFirst.mockResolvedValue(publicCampaign);
    prisma.campaignComment.findUnique.mockResolvedValue({
      campaignId: 'campaign-1',
      id: 'comment-1',
      userId: 'backer-1',
    });

    // #when
    await svc.remove('backer-1', 'campaign-1', 'comment-1');

    // #then
    expect(prisma.campaignComment.delete).toHaveBeenCalledWith({
      where: { id: 'comment-1' },
    });
  });

  it('lets the campaign creator remove somebody else’s comment', async () => {
    // #given
    const { prisma, svc } = make();
    prisma.campaign.findFirst.mockResolvedValue(publicCampaign);
    prisma.campaignComment.findUnique.mockResolvedValue({
      campaignId: 'campaign-1',
      id: 'comment-1',
      userId: 'backer-1',
    });

    // #when
    await svc.remove('creator-1', 'campaign-1', 'comment-1');

    // #then
    expect(prisma.campaignComment.delete).toHaveBeenCalled();
  });

  it('refuses an unrelated account', async () => {
    // #given
    const { prisma, svc } = make();
    prisma.campaign.findFirst.mockResolvedValue(publicCampaign);
    prisma.campaignComment.findUnique.mockResolvedValue({
      campaignId: 'campaign-1',
      id: 'comment-1',
      userId: 'backer-1',
    });

    // #when / #then
    await expect(
      svc.remove('someone-else', 'campaign-1', 'comment-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.campaignComment.delete).not.toHaveBeenCalled();
  });
});
