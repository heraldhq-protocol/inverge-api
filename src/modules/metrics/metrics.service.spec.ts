import { MetricsService } from './metrics.service';
import { DEFAULT_TIERS } from './pledge-weighting';

// Mocked PlatformParamsService — returns the weighting defaults.
function paramsMock(overrides: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = {
    'validation.pledgeTiers': DEFAULT_TIERS,
    'validation.minAccountAgeHours': 48,
    'validation.sustainmentDays': 14,
    'validation.windowDays': 90,
    'fx.ngnPerUsd': 1600,
    ...overrides,
  };
  return {
    get: jest.fn(async (k: string, fb?: unknown) => store[k] ?? fb),
    getNumber: jest.fn(async (k: string, fb = 0) =>
      typeof store[k] === 'number' ? (store[k] as number) : fb,
    ),
  } as any;
}

const OLD = new Date('2026-06-01T00:00:00Z'); // matured account
const NOW = new Date('2026-07-24T12:00:00Z');

describe('MetricsService.recompute — weighted aggregation (FR-207)', () => {
  it('writes weighted figure = Σ min(amountUsd,cap)×weight, plus raw sum + feedback', async () => {
    const tx = {
      ideaSignal: {
        count: jest.fn().mockResolvedValue(2), // supporters
        findMany: jest.fn().mockResolvedValue([
          // verified $1000 -> 1000 ; email $1,000,000 -> min(1e6,100)*0.25 = 25
          {
            amount: 1000,
            amountUsd: 1000,
            user: { kycStatus: 'VERIFIED', oauthSubject: null, emailVerified: true, bannedAt: null, createdAt: OLD },
          },
          {
            amount: 1_000_000,
            amountUsd: 1_000_000,
            user: { kycStatus: 'NOT_REQUIRED', oauthSubject: null, emailVerified: true, bannedAt: null, createdAt: OLD },
          },
        ]),
      },
      surveyResponse: {
        findMany: jest.fn().mockResolvedValue([
          { answers: [{ questionId: 'q1', value: 4 }] },
          { answers: [{ questionId: 'q1', value: 5 }] },
        ]),
      },
      surveyQuestion: { findMany: jest.fn().mockResolvedValue([{ id: 'q1' }]) },
      idea: { update: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)) },
    } as any;

    const svc = new MetricsService({} as any, paramsMock());
    await svc.recompute(tx, 'idea1', NOW);

    const data = tx.idea.update.mock.calls[0][0].data;
    expect(data.supporterCount).toBe(2);
    expect(data.prePledgeTotal).toBe(1_001_000); // raw sum untouched
    expect(data.weightedPrePledgeTotal).toBe(1025); // 1000 + 25 — the troll is capped
    expect(data.feedbackScore).toBe(4.5); // mean of RATING answers (4,5)
    expect(data.feedbackCount).toBe(2); // distinct responders
  });

  it('drops banned pledgers from the weighted figure (FR-216)', async () => {
    const tx = {
      ideaSignal: {
        count: jest.fn().mockResolvedValue(2),
        findMany: jest.fn().mockResolvedValue([
          { amount: 1000, amountUsd: 1000, user: { kycStatus: 'VERIFIED', oauthSubject: null, emailVerified: true, bannedAt: null, createdAt: OLD } },
          { amount: 1000, amountUsd: 1000, user: { kycStatus: 'VERIFIED', oauthSubject: null, emailVerified: true, bannedAt: NOW, createdAt: OLD } },
        ]),
      },
      surveyResponse: { findMany: jest.fn().mockResolvedValue([]) },
      surveyQuestion: { findMany: jest.fn().mockResolvedValue([]) },
      idea: { update: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)) },
    } as any;

    const svc = new MetricsService({} as any, paramsMock());
    await svc.recompute(tx, 'idea1', NOW);
    const data = tx.idea.update.mock.calls[0][0].data;
    expect(data.weightedPrePledgeTotal).toBe(1000); // banned one excluded
    expect(data.prePledgeTotal).toBe(2000); // raw still counts both
    expect(data.feedbackScore).toBe(0); // null avg -> 0
  });

  it('reads FR-206a-safe inputs only: never queries IdeaBoost', async () => {
    const tx = {
      ideaSignal: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
      surveyResponse: { findMany: jest.fn().mockResolvedValue([]) },
      surveyQuestion: { findMany: jest.fn().mockResolvedValue([]) },
      idea: { update: jest.fn().mockResolvedValue({}) },
      ideaBoost: { count: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
    } as any;
    const svc = new MetricsService({} as any, paramsMock());
    await svc.recompute(tx, 'idea1', NOW);
    expect(tx.ideaBoost.count).not.toHaveBeenCalled();
    expect(tx.ideaBoost.findMany).not.toHaveBeenCalled();
    expect(tx.ideaBoost.findFirst).not.toHaveBeenCalled();
  });
});

describe('MetricsService.normalizeToUsd (FR-210)', () => {
  it('normalizes NGN with the configured rate', async () => {
    const svc = new MetricsService({} as any, paramsMock());
    expect(await svc.normalizeToUsd(160_000, 'NGN')).toBe(100);
    expect(await svc.normalizeToUsd(250, 'USD')).toBe(250);
  });
});

describe('MetricsService.snapshotAllValidating (FR-204a)', () => {
  it('writes one snapshot row per VALIDATING/THRESHOLD_MET idea', async () => {
    const prisma = {
      idea: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'a', weightedPrePledgeTotal: 100, supporterCount: 5 },
          { id: 'b', weightedPrePledgeTotal: 200, supporterCount: 9 },
        ]),
      },
      ideaMetricSnapshot: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
    } as any;
    const svc = new MetricsService(prisma, paramsMock());
    const n = await svc.snapshotAllValidating(NOW);
    expect(n).toBe(2);
    expect(prisma.ideaMetricSnapshot.createMany).toHaveBeenCalledWith({
      data: [
        { ideaId: 'a', capturedAt: NOW, weightedTotal: 100, supporterCount: 5 },
        { ideaId: 'b', capturedAt: NOW, weightedTotal: 200, supporterCount: 9 },
      ],
    });
  });

  it('no-ops when nothing is validating', async () => {
    const prisma = {
      idea: { findMany: jest.fn().mockResolvedValue([]) },
      ideaMetricSnapshot: { createMany: jest.fn() },
    } as any;
    const svc = new MetricsService(prisma, paramsMock());
    expect(await svc.snapshotAllValidating(NOW)).toBe(0);
    expect(prisma.ideaMetricSnapshot.createMany).not.toHaveBeenCalled();
  });
});

describe('MetricsService.isSustained (FR-204a)', () => {
  it('is disabled when sustainmentDays <= 0', async () => {
    const svc = new MetricsService({} as any, paramsMock({ 'validation.sustainmentDays': 0 }));
    expect(await svc.isSustained('idea1', 2000, 100, NOW)).toBe(true);
  });

  it('holds at window close if the current figure still clears the bar', async () => {
    const prisma = { ideaMetricSnapshot: { findMany: jest.fn().mockResolvedValue([]) } } as any;
    const svc = new MetricsService(prisma, paramsMock({ 'validation.windowDays': 90, 'validation.sustainmentDays': 14 }));
    const validatingSince = new Date(NOW.getTime() - 100 * 86_400_000); // window closed
    expect(await svc.isSustained('idea1', 2000, 2500, validatingSince, NOW)).toBe(true);
    expect(await svc.isSustained('idea1', 2000, 1500, validatingSince, NOW)).toBe(false);
  });

  it('requires enough snapshots that never dropped below the bar', async () => {
    const belowThenAbove = Array.from({ length: 14 }, (_, i) => ({ weightedTotal: i < 2 ? 1000 : 3000 }));
    const allAbove = Array.from({ length: 14 }, () => ({ weightedTotal: 3000 }));
    const validatingSince = new Date(NOW.getTime() - 20 * 86_400_000); // window still open

    const mk = (snaps: any[]) =>
      new MetricsService(
        { ideaMetricSnapshot: { findMany: jest.fn().mockResolvedValue(snaps) } } as any,
        paramsMock({ 'validation.sustainmentDays': 14, 'validation.windowDays': 90 }),
      );

    expect(await mk(allAbove).isSustained('i', 2000, 3000, validatingSince, NOW)).toBe(true);
    expect(await mk(belowThenAbove).isSustained('i', 2000, 3000, validatingSince, NOW)).toBe(false);
    expect(await mk([{ weightedTotal: 3000 }]).isSustained('i', 2000, 3000, validatingSince, NOW)).toBe(false); // too few
  });
});
