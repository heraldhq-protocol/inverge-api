import { PrePledgeCampaignNotifier } from './pre-pledge-campaign.notifier';
import {
  IDEA_CONVERTED_TO_CAMPAIGN,
  type IdeaConvertedToCampaignEvent,
  type PublishedCampaignSnapshot,
} from './pre-pledge-conversion.event';

const event: IdeaConvertedToCampaignEvent = {
  campaignId: 'cmp1',
  creatorId: 'creator1',
  eventId: 'idea-converted:cmp1',
  ideaId: 'idea1',
  occurredAt: '2026-11-02T10:00:00.000Z',
  type: IDEA_CONVERTED_TO_CAMPAIGN,
};

function campaign(
  overrides: Partial<PublishedCampaignSnapshot> = {},
): PublishedCampaignSnapshot {
  return {
    coverImageUrl: '/images/solar.jpg',
    creatorId: 'creator1',
    deadline: new Date('2026-12-01T00:00:00.000Z'),
    id: 'cmp1',
    ideaId: 'idea1',
    summary: 'A shared solar cold room for smallholder farmers.',
    targetAmount: { toFixed: () => '5000.00' },
    title: 'Solar cold storage',
    ...overrides,
  };
}

function harness() {
  const tx = {
    idea: { findUnique: jest.fn().mockResolvedValue({ title: 'Solar cold chain' }) },
    ideaSignal: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const notifications = {
    createManyInTransaction: jest.fn().mockResolvedValue(['n1', 'n2']),
    dispatchPersisted: jest.fn().mockResolvedValue(undefined),
  };
  const notifier = new PrePledgeCampaignNotifier(notifications as never);
  return { notifications, notifier, tx };
}

describe('PrePledgeCampaignNotifier.prepare', () => {
  it('does nothing for a campaign with no source idea', async () => {
    const { notifier, notifications, tx } = harness();

    const ids = await notifier.prepare(tx as never, event, campaign({ ideaId: null }));

    expect(ids).toEqual([]);
    expect(tx.ideaSignal.findMany).not.toHaveBeenCalled();
    expect(notifications.createManyInTransaction).not.toHaveBeenCalled();
  });

  it('selects valid interest signals and deduplicates recipients', async () => {
    const { notifier, notifications, tx } = harness();
    tx.ideaSignal.findMany.mockResolvedValue([
      { user: { creatorProfile: { displayName: 'Amara Obi' } }, userId: 'u1' },
      { user: { creatorProfile: { displayName: 'Amara Obi' } }, userId: 'u1' },
      { user: { creatorProfile: null }, userId: 'u2' },
    ]);

    const ids = await notifier.prepare(tx as never, event, campaign());

    expect(tx.ideaSignal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        distinct: ['userId'],
        where: expect.objectContaining({
          ideaId: 'idea1',
          OR: [
            { type: 'PRE_PLEDGE', amountUsd: { gt: 0 } },
            { type: 'SUPPORT' },
          ],
          user: { bannedAt: null },
        }),
      }),
    );

    const messages = notifications.createManyInTransaction.mock.calls[0][1];
    expect(ids).toEqual(['n1', 'n2']);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      dedupeKey: 'IDEA_CONVERTED_TO_CAMPAIGN:cmp1:u1',
      template: 'IDEA_CONVERTED_TO_CAMPAIGN',
      toUserId: 'u1',
    });
    expect(messages[0].data).toMatchObject({
      campaignId: 'cmp1',
      campaignTitle: 'Solar cold storage',
      firstName: 'Amara',
      fundingDeadline: '1 December 2026',
      fundingGoal: '$5,000.00',
      ideaId: 'idea1',
      ideaTitle: 'Solar cold chain',
    });
    expect(messages[1].data).not.toHaveProperty('firstName');
  });

  it('omits missing optional campaign figures and image', async () => {
    const { notifier, notifications, tx } = harness();
    tx.ideaSignal.findMany.mockResolvedValue([
      { user: { creatorProfile: null }, userId: 'u1' },
    ]);

    await notifier.prepare(
      tx as never,
      event,
      campaign({
        coverImageUrl: null,
        deadline: null,
        targetAmount: null,
      }),
    );

    const message = notifications.createManyInTransaction.mock.calls[0][1][0];
    expect(message.data).not.toHaveProperty('coverImageUrl');
    expect(message.data).not.toHaveProperty('fundingDeadline');
    expect(message.data).not.toHaveProperty('fundingGoal');
  });

  it('does not create rows when there are no eligible signals', async () => {
    const { notifier, notifications, tx } = harness();

    expect(await notifier.prepare(tx as never, event, campaign())).toEqual([]);
    expect(notifications.createManyInTransaction).not.toHaveBeenCalled();
  });
});

describe('PrePledgeCampaignNotifier.dispatch', () => {
  it('hands persisted ids to the notification scheduler', async () => {
    const { notifier, notifications } = harness();
    await notifier.dispatch(['n1', 'n2']);
    expect(notifications.dispatchPersisted).toHaveBeenCalledWith(['n1', 'n2']);
  });
});
