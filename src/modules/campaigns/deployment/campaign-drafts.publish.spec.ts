import { CampaignDraftsService } from './campaign-drafts.service';
import { IDEA_CONVERTED_TO_CAMPAIGN } from '../pre-pledge-conversion.event';

const deadline = new Date('2026-12-01T00:00:00.000Z');

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    coverImageUrl: '/images/solar.jpg',
    creatorId: 'creator1',
    deadline,
    deployment: {
      feeStatus: 'NOT_REQUIRED',
      id: 'dep1',
      status: 'CONFIRMED',
    },
    id: 'cmp1',
    ideaId: 'idea1',
    launchedAt: null,
    milestones: [{ id: 'm1' }, { id: 'm2' }],
    reviewStatus: 'APPROVED',
    status: 'IN_REVIEW',
    summary: 'A shared solar cold room.',
    targetAmount: { toFixed: () => '5000.00' },
    termsHash: 'terms-hash',
    title: 'Solar cold storage',
    ...overrides,
  } as any;
}

function harness() {
  const tx = {
    campaign: {
      findUnique: jest.fn().mockResolvedValue(campaign()),
      findUniqueOrThrow: jest.fn().mockResolvedValue(campaign()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    campaignDeploymentEvent: { create: jest.fn().mockResolvedValue({}) },
  } as any;
  const prisma = {
    $transaction: jest.fn(async (cb: any) => cb(tx)),
  } as any;
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) } as any;
  const notifier = {
    dispatch: jest.fn().mockResolvedValue(undefined),
    prepare: jest.fn().mockResolvedValue(['n1', 'n2']),
  } as any;
  const service = new CampaignDraftsService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    undefined,
    notifications,
    notifier,
  );
  jest.spyOn(service as any, 'present').mockResolvedValue({ id: 'cmp1' });
  return { notifier, notifications, prisma, service, tx };
}

describe('CampaignDraftsService.publish pre-pledge fan-out', () => {
  it('writes recipient rows in the publication transaction and schedules them after commit', async () => {
    const { notifier, notifications, service } = harness();

    await service.publish('creator1', 'cmp1');

    expect(notifier.prepare).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        campaignId: 'cmp1',
        creatorId: 'creator1',
        ideaId: 'idea1',
        type: IDEA_CONVERTED_TO_CAMPAIGN,
      }),
      expect.objectContaining({ id: 'cmp1', ideaId: 'idea1' }),
    );
    expect(notifier.dispatch).toHaveBeenCalledWith(['n1', 'n2']);
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ template: 'CAMPAIGN_PUBLISHED' }),
    );
  });

  it('does not notify pre-pledgers for a campaign with no source idea', async () => {
    const { notifier, service, tx } = harness();
    const orphan = campaign({ ideaId: null });
    tx.campaign.findUnique.mockResolvedValue(orphan);
    tx.campaign.findUniqueOrThrow.mockResolvedValue(orphan);

    await service.publish('creator1', 'cmp1');

    expect(notifier.prepare).not.toHaveBeenCalled();
    expect(notifier.dispatch).toHaveBeenCalledWith([]);
  });

  it('does not fan out when publication is blocked', async () => {
    const { notifier, service, tx } = harness();
    tx.campaign.findUnique.mockResolvedValue(
      campaign({ reviewStatus: 'IN_REVIEW' }),
    );

    await expect(service.publish('creator1', 'cmp1')).rejects.toBeTruthy();

    expect(notifier.prepare).not.toHaveBeenCalled();
    expect(notifier.dispatch).not.toHaveBeenCalled();
  });
});
