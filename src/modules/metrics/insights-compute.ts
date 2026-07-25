// Pure aggregation helpers for the creator insights endpoint (chart-ready shapes).
import { round2 } from './pledge-weighting';

export interface QuestionLite {
  id: string;
  index: number;
  prompt: string;
  type: 'RATING' | 'TEXT' | 'SINGLE_CHOICE' | 'MULTI_CHOICE' | 'BOOLEAN';
}
export interface AnswerLite {
  questionId: string;
  value: unknown;
}

// Per-question aggregates + an overall 1..5 rating histogram.
export function buildFeedbackInsights(questions: QuestionLite[], responses: { answers: unknown }[]) {
  const answersByQ = new Map<string, unknown[]>();
  for (const q of questions) answersByQ.set(q.id, []);
  for (const r of responses) {
    const answers = Array.isArray(r.answers) ? (r.answers as AnswerLite[]) : [];
    for (const a of answers) {
      if (a && answersByQ.has(a.questionId)) answersByQ.get(a.questionId)!.push(a.value);
    }
  }

  const ratingDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<1 | 2 | 3 | 4 | 5, number>;

  const perQuestion = questions.map((q) => {
    const values = answersByQ.get(q.id) ?? [];
    const base = { questionId: q.id, prompt: q.prompt, type: q.type, answered: values.length };
    switch (q.type) {
      case 'RATING': {
        const nums = values.filter((v): v is number => typeof v === 'number');
        for (const n of nums) if (n >= 1 && n <= 5) ratingDistribution[n as 1 | 2 | 3 | 4 | 5] += 1;
        const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<number, number>;
        for (const n of nums) dist[n] = (dist[n] ?? 0) + 1;
        const avg = nums.length ? round2(nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
        return { ...base, average: avg, distribution: dist };
      }
      case 'SINGLE_CHOICE':
      case 'MULTI_CHOICE': {
        const tally: Record<string, number> = {};
        for (const v of values) {
          const picks = Array.isArray(v) ? v : [v];
          for (const p of picks) if (typeof p === 'string') tally[p] = (tally[p] ?? 0) + 1;
        }
        return { ...base, tally };
      }
      case 'BOOLEAN': {
        const yes = values.filter((v) => v === true).length;
        return { ...base, yes, no: values.length - yes };
      }
      default: // TEXT
        return base;
    }
  });

  return { ratingDistribution, perQuestion };
}

// Per-criterion graduation progress (FR-204) for a progress chart. Sustainment (FR-204a)
// is a time condition, reported separately by the caller.
export interface GateInputs {
  supporterCount: number;
  weighted: number;
  feedbackCount: number;
  feedbackScore: number;
  askAmount: number;
  creatorTarget: number;
  minSupporters: number;
  minWeightedUSD: number;
  minPct: number;
  minFeedbackCount: number;
  minAvgFeedbackRating: number;
}

export function buildGateProgress(g: GateInputs) {
  const requiredWeighted = Math.max(g.minWeightedUSD, g.minPct * g.askAmount, g.creatorTarget);
  const crit = (have: number, need: number) => ({
    have: round2(have),
    need: round2(need),
    pct: need > 0 ? Math.min(1, round2(have / need)) : 1,
    met: have >= need,
  });
  const criteria = {
    supporters: crit(g.supporterCount, g.minSupporters),
    weightedInterest: crit(g.weighted, requiredWeighted),
    feedbackCount: crit(g.feedbackCount, g.minFeedbackCount),
    feedbackScore: crit(g.feedbackScore, g.minAvgFeedbackRating),
  };
  return {
    requiredWeighted: round2(requiredWeighted),
    criteria,
    meetsThreshold: Object.values(criteria).every((c) => c.met),
  };
}

// Trailing-window deltas from the daily snapshots (for a "momentum" tile).
export function computeVelocity(
  timeseries: { capturedAt: Date; weightedTotal: number; supporterCount: number }[],
  now: Date,
  windowDays = 7,
) {
  if (timeseries.length === 0) return { windowDays, supporters: 0, weighted: 0 };
  const from = now.getTime() - windowDays * 86_400_000;
  const inWindow = timeseries.filter((p) => p.capturedAt.getTime() >= from);
  const baseline = inWindow[0] ?? timeseries[0];
  const latest = timeseries[timeseries.length - 1];
  return {
    windowDays,
    supporters: latest.supporterCount - baseline.supporterCount,
    weighted: round2(latest.weightedTotal - baseline.weightedTotal),
  };
}
