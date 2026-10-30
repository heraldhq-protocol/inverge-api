import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { IdeasService } from './ideas.service';

function txMock() {
  return {
    ideaSignal: { upsert: jest.fn().mockResolvedValue({}), deleteMany: jest.fn().mockResolvedValue({}) },
  };
}

function prismaMock(idea: any = null) {
  const tx = txMock();
  return {
    _tx: tx,
    idea: {
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'new-id', ...data })),
      update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'idea1', ...data })),
      findUnique: jest.fn().mockResolvedValue(idea),
      findFirst: jest.fn().mockResolvedValue(idea),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    ideaSignal: { findUnique: jest.fn().mockResolvedValue(null) },
    surveyQuestion: { createMany: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (cb: any) => cb(tx)),
  } as any;
}
const metricsMock = () => ({ recompute: jest.fn().mockResolvedValue({}), normalizeToUsd: jest.fn().mockResolvedValue(100) }) as any;
const qualityMock = () => ({ evaluate: jest.fn().mockResolvedValue({ tier: 'DISCOVERABLE' }), latestReport: jest.fn().mockResolvedValue({ id: 'r1' }) }) as any;
const moderationMock = () => ({ screenSafe: jest.fn().mockResolvedValue(null), screen: jest.fn() }) as any;
const mediaMock = () =>
  ({
    assertAttachable: jest.fn().mockResolvedValue(undefined),
    bindToCampaign: jest.fn().mockResolvedValue(undefined),
    bindToIdea: jest.fn().mockResolvedValue(undefined),
  }) as any;
const paramsMock = (store: Record<string, number> = { 'idea.maxActivePerCreator': 3 }) =>
  ({ getNumber: jest.fn(async (k: string, fb = 0) => (k in store ? store[k] : fb)) }) as any;

function make(idea: any = null, params = paramsMock(), cache?: any) {
  const p = prismaMock(idea), m = metricsMock(), q = qualityMock(), mod = moderationMock();
  return { svc: new IdeasService(p, m, q, mod, params, mediaMock(), cache), p, m, q, mod };
}

const validDto = {
  title: 'My Idea', problem: 'p', solution: 's',
  targetUser: 'smallholder farmers', currentAlternative: 'they guess yields manually',
  askBreakdown: { hardware: 1000 },
  roadmapSteps: [{ date: '2026-Q1', description: 'pilot' }, { date: '2026-Q2', description: 'scale' }],
  category: 'agriculture', askAmount: 25000, creatorPrePledgeTarget: 800,
} as any;

describe('IdeasService.create (FR-270/275)', () => {
  it('creates a structured DRAFT, derives a roadmap summary, scores, returns fresh', async () => {
    const fresh = { id: 'new-id', creatorId: 'u1', status: 'DRAFT' };
    const { svc, p, q } = make(fresh);
    const res = await svc.create('u1', validDto);
    const data = p.idea.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ creatorId: 'u1', status: 'DRAFT', targetUser: 'smallholder farmers', category: 'agriculture', creatorPrePledgeTarget: 800 });
    expect(data.roadmap).toContain('2026-Q1'); // derived from roadmapSteps
    expect(q.evaluate).toHaveBeenCalledWith('new-id', false); // coaching, no tier change
    expect(res).toMatchObject(fresh); // re-fetched
  });

  it('stores a feedback-only idea with no ask and no roadmap', async () => {
    const { svc, p } = make({ id: 'new-id', creatorId: 'u1', status: 'DRAFT' });
    const feedbackOnly = { ...validDto };
    delete feedbackOnly.askBreakdown;
    delete feedbackOnly.roadmapSteps;
    delete feedbackOnly.askAmount;

    await svc.create('u1', feedbackOnly);

    const data = p.idea.create.mock.calls[0][0].data;
    expect(data.askAmount).toBe(0);
    expect(data.askBreakdown).toEqual({});
    expect(data.roadmapSteps).toEqual([]);
    expect(data.roadmap).toBe('');
  });

  it('rejects creation over the per-creator concurrency cap (FR-275)', async () => {
    const { svc, p, q } = make({ id: 'x' });
    p.idea.count.mockResolvedValue(3);
    await expect(svc.create('u1', validDto)).rejects.toBeInstanceOf(BadRequestException);
    expect(p.idea.create).not.toHaveBeenCalled();
    expect(q.evaluate).not.toHaveBeenCalled();
  });
});

describe('IdeasService.update — draft + ownership guards', () => {
  it('updates a DRAFT and re-scores (FR-271)', async () => {
    const { svc, p, q } = make({ id: 'idea1', creatorId: 'u1', status: 'DRAFT' });
    await svc.update('u1', 'idea1', { title: 'New' } as any);
    expect(p.idea.update).toHaveBeenCalled();
    expect(q.evaluate).toHaveBeenCalledWith('idea1', false);
  });
  it('rejects editing a non-draft idea', async () => {
    const { svc } = make({ id: 'idea1', creatorId: 'u1', status: 'VALIDATING' });
    await expect(svc.update('u1', 'idea1', { title: 'X' } as any)).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects a non-owner', async () => {
    const { svc } = make({ id: 'idea1', creatorId: 'other', status: 'DRAFT' });
    await expect(svc.update('u1', 'idea1', { title: 'X' } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('404s a missing idea', async () => {
    const { svc } = make(null);
    await expect(svc.update('u1', 'ghost', {} as any)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('IdeasService.publish (FR-204a + FR-272)', () => {
  it('moves DRAFT → VALIDATING, stamps validatingSince, applies the tier, screens on publish', async () => {
    const { svc, p, q, mod } = make({ id: 'idea1', creatorId: 'u1', status: 'DRAFT' });
    await svc.publish('u1', 'idea1');
    const data = p.idea.update.mock.calls[0][0].data;
    expect(data.status).toBe('VALIDATING');
    expect(data.validatingSince).toBeInstanceOf(Date);
    expect(q.evaluate).toHaveBeenCalledWith('idea1', true); // sets discoverability tier
    expect(mod.screenSafe).toHaveBeenCalled(); // FR-1004 non-blocking moderation screen
  });
  it('rejects publishing a non-draft idea', async () => {
    const { svc } = make({ id: 'idea1', creatorId: 'u1', status: 'VALIDATING' });
    await expect(svc.publish('u1', 'idea1')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('publishes a feedback-only idea with no roadmap (askAmount 0)', async () => {
    const { svc, p } = make({
      id: 'idea1', creatorId: 'u1', status: 'DRAFT',
      askAmount: { toString: () => '0' }, roadmapSteps: [],
    });
    await svc.publish('u1', 'idea1');
    expect(p.idea.update).toHaveBeenCalled();
  });
  it('refuses a funding idea without two complete roadmap steps', async () => {
    const { svc, p } = make({
      id: 'idea1', creatorId: 'u1', status: 'DRAFT',
      askAmount: { toString: () => '25000' },
      roadmapSteps: [{ date: '2026-Q1', description: 'pilot' }],
    });
    await expect(svc.publish('u1', 'idea1')).rejects.toMatchObject({
      response: { code: 'FUNDING_REQUIRES_ROADMAP' },
    });
    expect(p.idea.update).not.toHaveBeenCalled();
  });
});

describe('IdeasService.getQuality', () => {
  it('returns the latest coaching report', async () => {
    const { svc, q } = make({ id: 'idea1' });
    await svc.getQuality('idea1');
    expect(q.latestReport).toHaveBeenCalledWith('idea1');
  });
});

const ideaFixture = (overrides: Record<string, unknown> = {}) => ({
  id: 'idea1',
  creatorId: 'u1',
  status: 'VALIDATING',
  createdAt: new Date('2026-01-02T00:00:00.000Z'),
  supporterCount: 0,
  weightedPrePledgeTotal: 0,
  feedbackCount: 0,
  feedbackScore: 0,
  askAmount: 1000,
  creatorPrePledgeTarget: null,
  creator: null,
  taxonomyCategorySlug: null,
  taxonomySubcategorySlug: null,
  ...overrides,
});

describe('IdeasService.get - unpublished visibility (FR-272)', () => {
  it('404s a DRAFT for an anonymous reader', async () => {
    const { svc } = make(ideaFixture({ status: 'DRAFT' }));
    await expect(svc.get('idea1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s a DRAFT for another authenticated user', async () => {
    const { svc } = make(ideaFixture({ status: 'DRAFT' }));
    await expect(svc.get('idea1', { id: 'u2' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns a DRAFT to its owner', async () => {
    const { svc } = make(ideaFixture({ status: 'DRAFT' }));
    const idea = await svc.get('idea1', { id: 'u1' });
    expect(idea.status).toBe('DRAFT');
  });

  it('returns a DRAFT to an admin', async () => {
    const { svc } = make(ideaFixture({ status: 'DRAFT' }));
    const idea = await svc.get('idea1', { id: 'u2', role: 'ADMIN' });
    expect(idea.status).toBe('DRAFT');
  });

  it('keeps a published LINK_ONLY idea reachable by direct URL', async () => {
    const { svc } = make(
      ideaFixture({ status: 'VALIDATING', discoverabilityTier: 'LINK_ONLY' }),
    );
    await expect(svc.get('idea1')).resolves.toMatchObject({
      discoverabilityTier: 'LINK_ONLY',
    });
  });

  it('caches only the anonymous projection and bypasses cache for a viewer', async () => {
    const cache = {
      getOrSet: jest.fn(
        async (
          _ns: string,
          _key: string,
          _ttl: number,
          loader: () => Promise<unknown>,
        ) => loader(),
      ),
    };
    const { svc } = make(ideaFixture(), paramsMock(), cache);

    await svc.get('idea1');
    expect(cache.getOrSet).toHaveBeenCalledWith(
      'idea',
      'public:v2:idea1',
      30,
      expect.any(Function),
    );

    cache.getOrSet.mockClear();
    await svc.get('idea1', { id: 'u1' });
    expect(cache.getOrSet).not.toHaveBeenCalled();
  });
});

describe('IdeasService.getQuality - unpublished visibility', () => {
  it('404s a DRAFT coaching report for an anonymous reader', async () => {
    const { svc } = make(ideaFixture({ status: 'DRAFT' }));
    await expect(svc.getQuality('idea1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns a DRAFT coaching report to its owner', async () => {
    const { svc, q } = make(ideaFixture({ status: 'DRAFT' }));
    await expect(svc.getQuality('idea1', { id: 'u1' })).resolves.toEqual({
      id: 'r1',
    });
    expect(q.latestReport).toHaveBeenCalledWith('idea1');
  });
});

describe('IdeasService — public creator counts', () => {
  const creator = {
    id: 'u1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    creatorProfile: {
      username: 'alice',
      displayName: 'Alice',
      tier: 'STARTER',
      completedCampaigns: 0,
      links: [],
      tenureStartedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  };

  it('counts only the creators on the page', async () => {
    const { svc, p } = make();
    p.idea.findMany.mockResolvedValue([
      {
        id: 'idea1',
        creatorId: 'u1',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        boosts: [],
        creator,
      },
    ]);
    p.idea.groupBy.mockResolvedValue([
      { creatorId: 'u1', _count: { _all: 7 } },
    ]);

    const page = await svc.list({ limit: 20 } as any);

    expect(p.idea.groupBy).toHaveBeenCalledWith({
      by: ['creatorId'],
      where: { creatorId: { in: ['u1'] } },
      _count: { _all: true },
    });
    expect(page.data[0].creator?.ideasPublished).toBe(7);
    expect(page.data[0].gateProgress.criteria.supporters).toEqual({
      have: 0,
      need: 50,
      pct: 0,
      met: false,
    });
    expect(page.data[0].gateProgress.meetsThreshold).toBe(false);
  });

  it('counts one creator on detail', async () => {
    const idea = {
      id: 'idea1',
      creatorId: 'u1',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      supporterCount: 0,
      weightedPrePledgeTotal: 0,
      feedbackCount: 0,
      feedbackScore: 0,
      askAmount: 1000,
      creatorPrePledgeTarget: null,
      creator,
    };
    const { svc, p } = make(idea);
    p.idea.count.mockResolvedValue(4);

    const result = await svc.get('idea1');

    expect(p.idea.count).toHaveBeenCalledWith({ where: { creatorId: 'u1' } });
    expect(result.creator?.ideasPublished).toBe(4);
  });
});

describe('IdeasService — signals recompute through MetricsService (FR-206a boundary)', () => {
  it('support upserts a SUPPORT signal then recomputes', async () => {
    const { svc, p, m } = make({ id: 'idea1', status: 'VALIDATING' });
    await svc.support('u2', 'idea1');
    expect(p._tx.ideaSignal.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ type: 'SUPPORT' }) }),
    );
    expect(m.recompute).toHaveBeenCalledWith(p._tx, 'idea1');
  });

  it('records one analytics signal for a first support and none for a repeat', async () => {
    const p = prismaMock({ id: 'idea1', status: 'VALIDATING' });
    const analytics = { record: jest.fn().mockResolvedValue(true) } as any;
    const svc = new IdeasService(
      p,
      metricsMock(),
      qualityMock(),
      moderationMock(),
      paramsMock(),
      mediaMock(),
      undefined,
      analytics,
    );

    await svc.support('u2', 'idea1');
    p.ideaSignal.findUnique.mockResolvedValue({ id: 'existing' });
    await svc.support('u2', 'idea1');

    expect(analytics.record).toHaveBeenCalledTimes(1);
    expect(analytics.record).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'IDEA_SIGNAL', signalType: 'SUPPORT' }),
    );
  });

  it('unsupport deletes the SUPPORT signal then recomputes', async () => {
    const { svc, p, m } = make({ id: 'idea1', status: 'VALIDATING' });
    await svc.unsupport('u2', 'idea1');
    expect(p._tx.ideaSignal.deleteMany).toHaveBeenCalledWith({ where: { ideaId: 'idea1', userId: 'u2', type: 'SUPPORT' } });
    expect(m.recompute).toHaveBeenCalled();
  });

  it('pre-pledge normalizes to USD (default) and stores amount/currency/amountUsd', async () => {
    const { svc, p, m } = make({ id: 'idea1', status: 'VALIDATING' });
    await svc.prePledge('u2', 'idea1', { amount: 500 } as any);
    expect(m.normalizeToUsd).toHaveBeenCalledWith(500, 'USD');
    expect(p._tx.ideaSignal.upsert.mock.calls[0][0].create).toMatchObject({ type: 'PRE_PLEDGE', amount: 500, currency: 'USD', amountUsd: 100 });
    expect(m.recompute).toHaveBeenCalled();
  });

  it('pre-pledge passes an explicit NGN currency to normalization', async () => {
    const { svc, m } = make({ id: 'idea1', status: 'VALIDATING' });
    await svc.prePledge('u2', 'idea1', { amount: 160000, currency: 'NGN' } as any);
    expect(m.normalizeToUsd).toHaveBeenCalledWith(160000, 'NGN');
  });

  it('withdraw deletes the PRE_PLEDGE signal then recomputes (FR-211)', async () => {
    const { svc, p, m } = make({ id: 'idea1', status: 'VALIDATING' });
    await svc.withdrawPrePledge('u2', 'idea1');
    expect(p._tx.ideaSignal.deleteMany).toHaveBeenCalledWith({ where: { ideaId: 'idea1', userId: 'u2', type: 'PRE_PLEDGE' } });
    expect(m.recompute).toHaveBeenCalled();
  });

  it('seeds a default survey on create (rating + open-text)', async () => {
    const { svc, p } = make({ id: 'new-id', creatorId: 'u1', status: 'DRAFT' });
    await svc.create('u1', validDto);
    const data = p.surveyQuestion.createMany.mock.calls[0][0].data;
    expect(data.some((q: any) => q.type === 'RATING')).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it('404s a signal against a missing idea (never opens a transaction)', async () => {
    const { svc, p, m } = make(null);
    await expect(svc.support('u2', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
    expect(p.$transaction).not.toHaveBeenCalled();
    expect(m.recompute).not.toHaveBeenCalled();
  });

  it('rejects signals on a non-published idea (DRAFT/CONVERTED cannot be pumped)', async () => {
    for (const status of ['DRAFT', 'CONVERTED', 'ARCHIVED']) {
      const { svc, p, m } = make({ id: 'idea1', status });
      await expect(svc.prePledge('u2', 'idea1', { amount: 100 } as any)).rejects.toBeInstanceOf(BadRequestException);
      expect(p.$transaction).not.toHaveBeenCalled();
      expect(m.recompute).not.toHaveBeenCalled();
    }
  });
});
