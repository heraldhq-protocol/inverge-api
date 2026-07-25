import { buildFeedbackInsights, buildGateProgress, computeVelocity, QuestionLite } from './insights-compute';

describe('buildFeedbackInsights', () => {
  const questions: QuestionLite[] = [
    { id: 'r', index: 0, prompt: 'Rate', type: 'RATING' },
    { id: 'c', index: 1, prompt: 'Pick', type: 'SINGLE_CHOICE' },
    { id: 'b', index: 2, prompt: 'Would you pay?', type: 'BOOLEAN' },
    { id: 't', index: 3, prompt: 'Why?', type: 'TEXT' },
  ];
  const responses = [
    { answers: [{ questionId: 'r', value: 5 }, { questionId: 'c', value: 'a' }, { questionId: 'b', value: true }, { questionId: 't', value: 'nice' }] },
    { answers: [{ questionId: 'r', value: 3 }, { questionId: 'c', value: 'b' }, { questionId: 'b', value: false }] },
    { answers: [{ questionId: 'r', value: 5 }, { questionId: 'c', value: 'a' }] },
  ];

  it('builds the overall rating histogram', () => {
    const { ratingDistribution } = buildFeedbackInsights(questions, responses);
    expect(ratingDistribution[5]).toBe(2);
    expect(ratingDistribution[3]).toBe(1);
    expect(ratingDistribution[1]).toBe(0);
  });

  it('aggregates per question by type', () => {
    const { perQuestion } = buildFeedbackInsights(questions, responses);
    const byId = Object.fromEntries(perQuestion.map((p) => [p.questionId, p]));
    expect(byId.r).toMatchObject({ answered: 3, average: 4.33 });
    expect(byId.c).toMatchObject({ answered: 3, tally: { a: 2, b: 1 } });
    expect(byId.b).toMatchObject({ answered: 2, yes: 1, no: 1 });
    expect(byId.t).toMatchObject({ answered: 1 }); // text: count only
  });
});

describe('buildGateProgress', () => {
  const base = {
    supporterCount: 30, weighted: 1500, feedbackCount: 8, feedbackScore: 3.5,
    askAmount: 25000, creatorTarget: 800,
    minSupporters: 50, minWeightedUSD: 2000, minPct: 0.1, minFeedbackCount: 10, minAvgFeedbackRating: 3,
  };

  it('uses max(floor, pct-of-ask, creator target) as the weighted requirement', () => {
    // max(2000, 0.1*25000=2500, 800) = 2500
    expect(buildGateProgress(base).requiredWeighted).toBe(2500);
  });

  it('reports per-criterion progress and overall met flag', () => {
    const g = buildGateProgress(base);
    expect(g.criteria.supporters).toMatchObject({ have: 30, need: 50, met: false });
    expect(g.criteria.supporters.pct).toBeCloseTo(0.6, 2);
    expect(g.criteria.feedbackScore).toMatchObject({ met: true }); // 3.5 >= 3
    expect(g.meetsThreshold).toBe(false);
  });

  it('meetsThreshold true when every criterion clears', () => {
    const g = buildGateProgress({ ...base, supporterCount: 60, weighted: 3000, feedbackCount: 12 });
    expect(g.meetsThreshold).toBe(true);
  });
});

describe('computeVelocity', () => {
  const now = new Date('2026-07-25T00:00:00Z');
  const day = (d: number) => new Date(now.getTime() - d * 86_400_000);

  it('computes trailing-window deltas from snapshots', () => {
    const ts = [
      { capturedAt: day(10), weightedTotal: 100, supporterCount: 5 },
      { capturedAt: day(5), weightedTotal: 300, supporterCount: 12 },
      { capturedAt: day(1), weightedTotal: 500, supporterCount: 20 },
    ];
    const v = computeVelocity(ts, now, 7); // baseline = first within 7d (day5), latest = day1
    expect(v).toEqual({ windowDays: 7, supporters: 8, weighted: 200 });
  });

  it('is zero for an empty series', () => {
    expect(computeVelocity([], now)).toEqual({ windowDays: 7, supporters: 0, weighted: 0 });
  });
});
