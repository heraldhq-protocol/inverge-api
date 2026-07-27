import {
  bayesianSmooth,
  computeTrustScore,
  deriveChip,
  explorationBonus,
  FeedItemSignals,
  FeedRankingParams,
  injectPaid,
  personalizationMultiplier,
  rankFeed,
  scorePool,
  standardizer,
  timeDecay,
} from './ranking';

const PARAMS: FeedRankingParams = {
  weights: {
    prePledge: 0.3,
    velocity: 0.2,
    feedback: 0.15,
    quality: 0.15,
    trust: 0.2,
  },
  dupPenaltyWeight: 0.3,
  velocityBayesC: 5,
  feedbackBayesC: 5,
  feedbackPriorMean: 3,
  gravity: 1.2,
  explorationSlotShare: 0.25,
  explorationBeta: 1,
  explorationMinQuality: 0.4,
  perCreatorCap: 2,
  categoryMaxShare: 0.5,
};

// Factory for a neutral item; override the fields a test cares about.
function item(over: Partial<FeedItemSignals> = {}): FeedItemSignals {
  return {
    objectType: 'idea',
    id: over.id ?? Math.random().toString(36).slice(2),
    creatorId: 'c1',
    category: 'software',
    region: null,
    ageHours: 24,
    qualityScore: 0.7,
    trustScore: 0.5,
    weightedPrePledge: 100,
    velocityEvents: 5,
    velocityExposureDays: 5,
    feedbackRatingSum: 12,
    feedbackRatingCount: 3,
    duplicatePenalty: 0,
    feedImpressions: 100,
    personalizationMultiplier: 1,
    matchReason: null,
    ...over,
  };
}

describe('stats helpers', () => {
  it('standardizer maps a zero-variance pool to 0 (no signal dominates on noise)', () => {
    const z = standardizer([5, 5, 5]);
    expect(z(5)).toBe(0);
    expect(z(9)).toBe(0);
  });

  it('standardizer produces symmetric z-scores', () => {
    const z = standardizer([0, 10]);
    expect(z(10)).toBeCloseTo(1, 5);
    expect(z(0)).toBeCloseTo(-1, 5);
  });

  it('bayesianSmooth shrinks a small sample toward the prior', () => {
    // 1 rating of 5, prior 3, C=5 → strongly pulled toward 3, not 5.
    const s = bayesianSmooth(5, 1, 5, 3);
    expect(s).toBeCloseTo((5 + 5 * 3) / (1 + 5), 5);
    expect(s).toBeLessThan(4);
  });

  it('bayesianSmooth trusts the raw rate as evidence accumulates', () => {
    const raw = 100 / 100; // rate 1.0
    const s = bayesianSmooth(100, 100, 5, 0.2);
    expect(s).toBeGreaterThan(0.9);
    expect(s).toBeLessThan(raw + 0.01);
  });

  it('explorationBonus is larger for less-exposed items and shrinks with exposure', () => {
    const low = explorationBonus(10_000, 1, 1);
    const high = explorationBonus(10_000, 5_000, 1);
    expect(low).toBeGreaterThan(high);
  });

  it('timeDecay is monotonically decreasing in age', () => {
    const fresh = timeDecay(10, 1, 1.2);
    const old = timeDecay(10, 500, 1.2);
    expect(fresh).toBeGreaterThan(old);
  });
});

describe('personalizationMultiplier', () => {
  const p = {
    min: 0.8,
    max: 1.5,
    categoryBonus: 0.25,
    regionBonus: 0.2,
    similarityBonus: 0.25,
    engagedCorpusMax: 10,
  };

  it('returns a neutral 1.0 for an anonymous user (no interests, no corpus)', () => {
    const r = personalizationMultiplier(
      { category: 'software', region: 'lagos', text: 'x' },
      { categories: [], regions: [] },
      [],
      p,
    );
    expect(r.multiplier).toBe(1);
    expect(r.matchReason).toBeNull();
  });

  it('lifts and labels a region match, region taking chip precedence', () => {
    const r = personalizationMultiplier(
      { category: 'software', region: 'Lagos', text: '' },
      { categories: ['software'], regions: ['lagos'] },
      [],
      p,
    );
    // 1 * 1.2 (region) * 1.25 (category) = 1.5, clamped at max
    expect(r.multiplier).toBeCloseTo(1.5, 5);
    expect(r.matchReason).toBe('region');
  });

  it('is bounded so an out-of-interest item still surfaces (never a filter)', () => {
    const r = personalizationMultiplier(
      { category: 'film', region: null, text: '' },
      { categories: ['software'], regions: [] },
      [],
      p,
    );
    expect(r.multiplier).toBe(1); // no match, no penalty either
  });

  it('adds a content-similarity bonus against the engaged corpus', () => {
    const text = 'a mobile savings app for market traders in lagos';
    const r = personalizationMultiplier(
      { category: 'film', region: null, text },
      { categories: [], regions: [] },
      [text], // identical → similarity 1.0
      p,
    );
    expect(r.multiplier).toBeCloseTo(1.25, 2);
  });
});

describe('computeTrustScore', () => {
  const w = { kyc: 0.5, kyb: 0.3, cosign: 0.2 };
  it('composes and clamps to [0,1]', () => {
    expect(
      computeTrustScore(
        { kycVerified: true, kybVerifiedClear: true, cosign: true },
        w,
      ),
    ).toBe(1);
    expect(
      computeTrustScore(
        { kycVerified: false, kybVerifiedClear: false, cosign: false },
        w,
      ),
    ).toBe(0);
    expect(
      computeTrustScore(
        { kycVerified: true, kybVerifiedClear: false, cosign: true },
        w,
      ),
    ).toBeCloseTo(0.7, 5);
  });
});

describe('scorePool', () => {
  it('shifts every organic score to a positive floor before personalization', () => {
    const pool = [
      item({ id: 'a', weightedPrePledge: 1000 }),
      item({ id: 'b', weightedPrePledge: 1, duplicatePenalty: 1 }),
    ];
    const scored = scorePool(pool, PARAMS);
    for (const s of scored) expect(s.final).toBeGreaterThan(0);
  });

  it('ranks a strong pre-pledge item above a weak one, all else equal', () => {
    const pool = [
      item({ id: 'weak', weightedPrePledge: 10 }),
      item({ id: 'strong', weightedPrePledge: 5000 }),
    ];
    const scored = scorePool(pool, PARAMS);
    const byId = Object.fromEntries(scored.map((s) => [s.item.id, s.final]));
    expect(byId.strong).toBeGreaterThan(byId.weak);
  });

  it('blunts a raw-supporter burst on a fresh low-trust item (Bayesian smoothing)', () => {
    // Attacker: huge supporter burst over a tiny window, but no pre-pledge, no trust.
    const pool = [
      item({
        id: 'organic',
        weightedPrePledge: 2000,
        velocityEvents: 8,
        velocityExposureDays: 8,
        trustScore: 0.8,
      }),
      item({
        id: 'burst',
        weightedPrePledge: 0,
        velocityEvents: 500,
        velocityExposureDays: 0.1,
        trustScore: 0,
      }),
    ];
    const scored = scorePool(pool, PARAMS);
    const byId = Object.fromEntries(scored.map((s) => [s.item.id, s.final]));
    // The burst does not rocket past the genuinely-supported item.
    expect(byId.organic).toBeGreaterThan(byId.burst);
  });

  it('subtracts a duplicate penalty', () => {
    const clean = item({ id: 'clean', duplicatePenalty: 0 });
    const dup = item({ id: 'dup', duplicatePenalty: 1 });
    const scored = scorePool([clean, dup], PARAMS);
    const byId = Object.fromEntries(
      scored.map((s) => [s.item.id, s.breakdown.organic]),
    );
    expect(byId.clean).toBeGreaterThan(byId.dup);
  });
});

describe('deriveChip', () => {
  it('labels a region match', () => {
    const scored = scorePool(
      [
        item({
          region: 'Lagos',
          personalizationMultiplier: 1.2,
          matchReason: 'region',
        }),
      ],
      PARAMS,
    );
    expect(deriveChip(scored[0])).toMatchObject({
      code: 'REGION',
      label: 'From Lagos',
    });
  });

  it('labels a feedback-dominant item', () => {
    const pool = [
      item({
        id: 'a',
        feedbackRatingSum: 50,
        feedbackRatingCount: 10,
        weightedPrePledge: 1,
        trustScore: 0,
        qualityScore: 0,
      }),
      item({
        id: 'b',
        feedbackRatingSum: 2,
        feedbackRatingCount: 1,
        weightedPrePledge: 1,
        trustScore: 0,
        qualityScore: 0,
      }),
    ];
    const scored = scorePool(pool, PARAMS);
    const a = scored.find((s) => s.item.id === 'a')!;
    expect(deriveChip(a).code).toBe('FEEDBACK');
  });
});

describe('rankFeed policy layer', () => {
  it('caps items per creator (anti-flood)', () => {
    // 6 strong items from one creator + plenty of distinct-creator filler, so the cap is
    // satisfiable without leaving the page short.
    const pool = Array.from({ length: 6 }, (_, i) =>
      item({
        id: `x${i}`,
        creatorId: 'flooder',
        weightedPrePledge: 1000 - i,
        category: `cat${i}`,
      }),
    );
    for (let i = 0; i < 8; i++)
      pool.push(
        item({ id: `o${i}`, creatorId: `other${i}`, category: `z${i}` }),
      );
    const page = rankFeed(pool, PARAMS, 6);
    const flooder = page.filter(
      (e) => pool.find((p) => p.id === e.id)!.creatorId === 'flooder',
    );
    expect(flooder.length).toBeLessThanOrEqual(PARAMS.perCreatorCap);
  });

  it('reserves exploration slots for under-exposed items', () => {
    // 8 heavily-exposed strong items + 1 fresh under-exposed one that would not rank organically.
    const pool = Array.from({ length: 8 }, (_, i) =>
      item({
        id: `pop${i}`,
        creatorId: `c${i}`,
        category: `k${i}`,
        weightedPrePledge: 5000,
        feedImpressions: 100_000,
      }),
    );
    pool.push(
      item({
        id: 'newbie',
        creatorId: 'cN',
        category: 'kN',
        weightedPrePledge: 1,
        feedImpressions: 0,
        qualityScore: 0.6,
      }),
    );
    const page = rankFeed(pool, PARAMS, 8);
    const newbie = page.find((e) => e.id === 'newbie');
    expect(newbie).toBeDefined();
    expect(newbie!.exploration).toBe(true);
    expect(newbie!.chip.code).toBe('EXPLORE');
  });

  it('never spends an exploration slot on a below-quality-floor item', () => {
    const pool = Array.from({ length: 6 }, (_, i) =>
      item({
        id: `p${i}`,
        creatorId: `c${i}`,
        category: `k${i}`,
        weightedPrePledge: 4000,
        feedImpressions: 50_000,
      }),
    );
    pool.push(
      item({
        id: 'lowq',
        creatorId: 'cL',
        category: 'kL',
        feedImpressions: 0,
        qualityScore: 0.1,
      }),
    );
    const page = rankFeed(pool, PARAMS, 6);
    const lowq = page.find((e) => e.id === 'lowq');
    // lowq may or may not appear organically, but must never be marked an exploration pick.
    if (lowq) expect(lowq.exploration).toBe(false);
  });

  it('is deterministic for the same input', () => {
    const pool = Array.from({ length: 10 }, (_, i) =>
      item({
        id: `d${i}`,
        creatorId: `c${i}`,
        category: `k${i}`,
        weightedPrePledge: 100 * i,
        feedImpressions: 1000 * i,
      }),
    );
    const a = rankFeed(pool, PARAMS, 10).map((e) => e.id);
    const b = rankFeed(pool, PARAMS, 10).map((e) => e.id);
    expect(a).toEqual(b);
  });
});

describe('injectPaid (Stage 3 — walled off)', () => {
  const organic = Array.from({ length: 12 }, (_, i) => ({
    objectType: 'idea' as const,
    id: `o${i}`,
    score: 100 - i,
    chip: { code: 'INTENT', label: 'x' },
    exploration: false,
    promoted: false,
    boostTier: null,
  }));

  it('injects clearly-labelled promoted slots at the configured cadence, frequency-capped', () => {
    const out = injectPaid(
      organic,
      [
        { objectType: 'idea', id: 'ad1', boostTier: 'FEATURED' },
        { objectType: 'idea', id: 'ad2', boostTier: 'BASIC' },
        { objectType: 'idea', id: 'ad3', boostTier: 'BASIC' },
      ],
      { everyN: 4, maxSlots: 2 },
    );
    const promoted = out.filter((e) => e.promoted);
    expect(promoted).toHaveLength(2); // capped at maxSlots
    expect(promoted.every((e) => e.chip.code === 'PROMOTED')).toBe(true);
  });

  it('never modifies organic scores or order — organic is recomputable with paid removed', () => {
    const out = injectPaid(
      organic,
      [{ objectType: 'idea', id: 'ad1', boostTier: 'FEATURED' }],
      { everyN: 4, maxSlots: 3 },
    );
    const organicBack = out.filter((e) => !e.promoted);
    expect(organicBack).toEqual(organic); // identical objects, same order, untouched scores
  });

  it('does not double-place an item already present organically', () => {
    const out = injectPaid(
      organic,
      [{ objectType: 'idea', id: 'o3', boostTier: 'BASIC' }],
      { everyN: 4, maxSlots: 3 },
    );
    expect(out.filter((e) => e.id === 'o3')).toHaveLength(1);
    expect(out.some((e) => e.promoted)).toBe(false);
  });

  it('promoted slots carry a zero organic score (outside the score space)', () => {
    const out = injectPaid(
      organic,
      [{ objectType: 'idea', id: 'ad1', boostTier: 'FEATURED' }],
      { everyN: 4, maxSlots: 3 },
    );
    expect(out.find((e) => e.promoted)!.score).toBe(0);
  });
});
