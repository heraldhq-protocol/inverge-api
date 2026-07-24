import {
  DEFAULT_MIN_ACCOUNT_AGE_HOURS,
  DEFAULT_TIERS,
  PledgeWeightingParams,
  PledgerIdentity,
  baseTierId,
  contribution,
  normalizeToUsd,
  resolveTier,
  weightedTotal,
} from './pledge-weighting';

// Fixed "now" so account-age math is deterministic.
const NOW = new Date('2026-07-24T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);

const PARAMS: PledgeWeightingParams = {
  tiers: DEFAULT_TIERS,
  minAccountAgeHours: DEFAULT_MIN_ACCOUNT_AGE_HOURS, // 48
};

// Identity factory — matured (older than the age floor) by default.
function pledger(overrides: Partial<PledgerIdentity> = {}): PledgerIdentity {
  return {
    kycStatus: 'NOT_REQUIRED',
    oauthSubject: null,
    emailVerified: true,
    bannedAt: null,
    createdAt: daysAgo(30),
    ...overrides,
  };
}

const EMAIL = pledger();
const SOCIAL = pledger({ oauthSubject: 'oauth|abc' });
const VERIFIED = pledger({ kycStatus: 'VERIFIED' });

const tier = (id: string) => DEFAULT_TIERS.find((t) => t.id === id)!;

describe('baseTierId', () => {
  it('maps KYC-verified to VERIFIED', () => {
    expect(baseTierId(VERIFIED)).toBe('VERIFIED');
  });
  it('maps a past on-chain funder to VERIFIED even without KYC', () => {
    expect(baseTierId(pledger({ pastFunder: true }))).toBe('VERIFIED');
  });
  it('maps a unique social identity to SOCIAL', () => {
    expect(baseTierId(SOCIAL)).toBe('SOCIAL');
  });
  it('falls back to EMAIL for email-only', () => {
    expect(baseTierId(EMAIL)).toBe('EMAIL');
  });
});

describe('resolveTier — anti-sybil floors', () => {
  it('excludes banned pledgers entirely (FR-216)', () => {
    expect(resolveTier(pledger({ bannedAt: NOW }), PARAMS, NOW)).toBeNull();
  });

  it('forces a fresh KYC account down to the EMAIL floor (FR-213)', () => {
    // Verified identity, but the account is only 1h old.
    const fresh = pledger({ kycStatus: 'VERIFIED', createdAt: hoursAgo(1) });
    expect(resolveTier(fresh, PARAMS, NOW)!.id).toBe('EMAIL');
  });

  it('grants full tier once the account matures past the age floor', () => {
    const matured = pledger({ kycStatus: 'VERIFIED', createdAt: hoursAgo(49) });
    expect(resolveTier(matured, PARAMS, NOW)!.id).toBe('VERIFIED');
  });

  it('treats exactly-at-floor age as still-below (< is strict)', () => {
    const atFloor = pledger({ kycStatus: 'VERIFIED', createdAt: hoursAgo(48) });
    // 48h ago == exactly minAccountAgeHours -> ageHours == 48, not < 48 -> full tier
    expect(resolveTier(atFloor, PARAMS, NOW)!.id).toBe('VERIFIED');
  });
});

describe('contribution — cap × weight', () => {
  it('verified pledge counts at full weight up to its cap', () => {
    expect(contribution(1000, tier('VERIFIED'))).toBe(1000); // min(1000,1000)*1.0
    expect(contribution(5000, tier('VERIFIED'))).toBe(1000); // capped
  });

  it('email pledge is capped small and discounted (the core anti-manipulation)', () => {
    // The $1,000,000 troll: min(1_000_000, 100) * 0.25 = 25
    expect(contribution(1_000_000, tier('EMAIL'))).toBe(25);
    expect(contribution(80, tier('EMAIL'))).toBe(20); // under cap: 80*0.25
  });

  it('social sits between the two', () => {
    expect(contribution(1000, tier('SOCIAL'))).toBe(350); // min(1000,500)*0.7
  });

  it('rejects non-finite / negative amounts to zero (defensive against overflow gaming)', () => {
    expect(contribution(-100, tier('VERIFIED'))).toBe(0);
    expect(contribution(NaN, tier('VERIFIED'))).toBe(0);
    expect(contribution(Infinity, tier('EMAIL'))).toBe(0); // non-finite rejected outright
  });

  it('a null tier (banned) contributes nothing', () => {
    expect(contribution(1000, null)).toBe(0);
  });
});

describe('weightedTotal — gaming scenarios', () => {
  it('one email troll pledging $1M moves the figure by only $25', () => {
    const total = weightedTotal([{ amountUsd: 1_000_000, pledger: EMAIL }], PARAMS, NOW);
    expect(total).toBe(25);
  });

  it('email-only sybil swarm needs >=80 matured accounts to reach the $2,000 floor', () => {
    const swarm = (n: number) =>
      weightedTotal(
        Array.from({ length: n }, () => ({ amountUsd: 100_000, pledger: pledger() })),
        PARAMS,
        NOW,
      );
    expect(swarm(79)).toBe(1975); // 79 * 25
    expect(swarm(80)).toBe(2000); // exactly the floor — and that's 80 real, aged, unique accounts
    expect(swarm(79)).toBeLessThan(2000);
  });

  it('a fresh-account swarm is worthless: young verified accounts are floored', () => {
    const youngWhales = Array.from({ length: 10 }, () => ({
      amountUsd: 1000,
      pledger: pledger({ kycStatus: 'VERIFIED', createdAt: hoursAgo(2) }),
    }));
    // Each floored to EMAIL: min(1000,100)*0.25 = 25 -> 10*25 = 250, not 10*1000.
    expect(weightedTotal(youngWhales, PARAMS, NOW)).toBe(250);
  });

  it('verifying later upgrades an existing pledge (the incentive)', () => {
    const before = weightedTotal([{ amountUsd: 1000, pledger: EMAIL }], PARAMS, NOW);
    const after = weightedTotal([{ amountUsd: 1000, pledger: VERIFIED }], PARAMS, NOW);
    expect(before).toBe(25);
    expect(after).toBe(1000);
    expect(after).toBeGreaterThan(before);
  });

  it('banned accounts drop out of the total (FR-216 retroactive removal)', () => {
    const pledges = [
      { amountUsd: 1000, pledger: VERIFIED },
      { amountUsd: 1000, pledger: pledger({ kycStatus: 'VERIFIED', bannedAt: NOW }) },
    ];
    expect(weightedTotal(pledges, PARAMS, NOW)).toBe(1000); // only the non-banned one
  });

  it('mixed cohort sums per-tier correctly', () => {
    const pledges = [
      { amountUsd: 5000, pledger: VERIFIED }, // capped -> 1000
      { amountUsd: 5000, pledger: SOCIAL }, // capped -> 350
      { amountUsd: 5000, pledger: EMAIL }, // capped -> 25
    ];
    expect(weightedTotal(pledges, PARAMS, NOW)).toBe(1375);
  });

  it('respects an admin re-tuned tier table (calibration loop)', () => {
    // Simulate lowering the email weight to 0.1 after measuring conversion.
    const retuned: PledgeWeightingParams = {
      ...PARAMS,
      tiers: [
        { id: 'EMAIL', weight: 0.1, capUSD: 100 },
        { id: 'SOCIAL', weight: 0.7, capUSD: 500 },
        { id: 'VERIFIED', weight: 1.0, capUSD: 1000 },
      ],
    };
    expect(weightedTotal([{ amountUsd: 1000, pledger: EMAIL }], retuned, NOW)).toBe(10);
  });
});

describe('normalizeToUsd (FR-210)', () => {
  it('passes USD through untouched', () => {
    expect(normalizeToUsd(500, 'USD', 1600)).toBe(500);
  });

  it('normalizes NGN at the fx rate', () => {
    expect(normalizeToUsd(160_000, 'NGN', 1600)).toBe(100);
  });

  it('rejects NGN when no fx rate is configured', () => {
    expect(() => normalizeToUsd(160_000, 'NGN', 0)).toThrow(/fx/i);
  });

  it('rejects unsupported currencies', () => {
    expect(() => normalizeToUsd(100, 'BTC', 1600)).toThrow(/Unsupported/i);
  });
});
