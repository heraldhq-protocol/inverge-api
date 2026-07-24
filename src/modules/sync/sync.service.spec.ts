import { ForbiddenException } from '@nestjs/common';
import { SyncService } from './sync.service';

// FR-204/204a — configurable validation-threshold rule engine gating idea→draft.
function paramsMock(overrides: Record<string, number> = {}) {
  const store: Record<string, number> = {
    'validation.minSupporters': 50,
    'validation.minWeightedUSD': 2000,
    'validation.minPrePledgePctOfAsk': 0.1,
    'validation.minFeedbackCount': 10,
    'validation.minAvgFeedbackRating': 3,
    ...overrides,
  };
  return {
    getNumber: jest.fn(async (k: string, fb = 0) => (k in store ? store[k] : fb)),
  } as any;
}

// A fully-passing idea (against defaults) unless overridden.
function idea(overrides: Record<string, unknown> = {}) {
  return {
    id: 'idea1',
    creatorId: 'creator1',
    status: 'VALIDATING',
    supporterCount: 60,
    weightedPrePledgeTotal: 2500,
    askAmount: 10000, // pct-of-ask floor = 1000, below the 2000 abs floor
    creatorPrePledgeTarget: null,
    feedbackCount: 12,
    feedbackScore: 3.5,
    validatingSince: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as any;
}

function make(params = paramsMock(), sustained = true) {
  const metrics = { isSustained: jest.fn().mockResolvedValue(sustained) } as any;
  const svc = new SyncService({} as any, params, {} as any, metrics);
  return { svc, metrics };
}

describe('meetsValidationThreshold — the gate', () => {
  it('passes when every rule clears and the figure is sustained', async () => {
    const { svc } = make();
    expect(await svc.meetsValidationThreshold(idea())).toBe(true);
  });

  it('fails below the supporter minimum', async () => {
    const { svc } = make();
    expect(await svc.meetsValidationThreshold(idea({ supporterCount: 49 }))).toBe(false);
  });

  it('fails below the weighted interest floor (raw sum never consulted)', async () => {
    const { svc } = make();
    expect(await svc.meetsValidationThreshold(idea({ weightedPrePledgeTotal: 1999 }))).toBe(false);
  });

  it("uses max(floor, pct-of-ask, creator target) — creator's declared min can raise the bar", async () => {
    const { svc } = make();
    // weighted 2500 clears the 2000 floor but not a creator target of 3000.
    expect(
      await svc.meetsValidationThreshold(idea({ weightedPrePledgeTotal: 2500, creatorPrePledgeTarget: 3000 })),
    ).toBe(false);
    // raising weighted above the creator target passes.
    expect(
      await svc.meetsValidationThreshold(idea({ weightedPrePledgeTotal: 3200, creatorPrePledgeTarget: 3000 })),
    ).toBe(true);
  });

  it('pct-of-ask backstop scales the bar for large asks', async () => {
    const { svc } = make();
    // ask 100k -> pct floor = 10k > 2k abs floor; weighted 5k fails.
    expect(
      await svc.meetsValidationThreshold(idea({ askAmount: 100_000, weightedPrePledgeTotal: 5000 })),
    ).toBe(false);
    expect(
      await svc.meetsValidationThreshold(idea({ askAmount: 100_000, weightedPrePledgeTotal: 10_000 })),
    ).toBe(true);
  });

  it('fails below feedback count or average rating', async () => {
    const { svc } = make();
    expect(await svc.meetsValidationThreshold(idea({ feedbackCount: 9 }))).toBe(false);
    expect(await svc.meetsValidationThreshold(idea({ feedbackScore: 2.9 }))).toBe(false);
  });

  it('fails when metrics are met but not sustained over the window (FR-204a)', async () => {
    const { svc } = make(paramsMock(), false); // isSustained -> false
    expect(await svc.meetsValidationThreshold(idea())).toBe(false);
  });

  it('re-reads params at call time (runtime-tunable, no restart)', async () => {
    // Same idea, but admin lowered the supporter bar to 30 -> now passes at supporterCount 40.
    const { svc } = make(paramsMock({ 'validation.minSupporters': 30 }));
    expect(await svc.meetsValidationThreshold(idea({ supporterCount: 40 }))).toBe(true);
  });
});

describe('convert — precondition guards', () => {
  const dto: any = {
    type: 'ALL_OR_NOTHING',
    tokenType: 'USDC',
    targetAmount: 10000,
    deadline: '2026-12-31T00:00:00Z',
    milestones: [
      { title: 'a', deliverable: 'x', tranchePct: 50, evidenceDefinition: {} },
      { title: 'b', deliverable: 'y', tranchePct: 50, evidenceDefinition: {} },
    ],
  };

  it('rejects a non-owner before evaluating the gate', async () => {
    const prisma = { idea: { findUnique: jest.fn().mockResolvedValue(idea({ creatorId: 'someone-else' })) } } as any;
    const svc = new SyncService(prisma, paramsMock(), {} as any, { isSustained: jest.fn() } as any);
    await expect(svc.convert('not-the-owner', 'idea1', dto)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an already-converted idea', async () => {
    const prisma = { idea: { findUnique: jest.fn().mockResolvedValue(idea({ status: 'CONVERTED' })) } } as any;
    const svc = new SyncService(prisma, paramsMock(), {} as any, { isSustained: jest.fn() } as any);
    await expect(svc.convert('creator1', 'idea1', dto)).rejects.toThrow(/already converted/i);
  });

  it('blocks conversion when the gate is not cleared', async () => {
    const prisma = {
      idea: { findUnique: jest.fn().mockResolvedValue(idea({ supporterCount: 1 })) },
    } as any;
    const svc = new SyncService(prisma, paramsMock(), {} as any, { isSustained: jest.fn().mockResolvedValue(true) } as any);
    await expect(svc.convert('creator1', 'idea1', dto)).rejects.toThrow(/validation threshold/i);
  });
});
