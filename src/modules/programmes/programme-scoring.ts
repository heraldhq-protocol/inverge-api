/**
 * Pure programme scoring and ranking.
 *
 * Kept free of Nest and Prisma so the official standings can be recomputed from
 * a stored snapshot and proven identical to what participants saw. Every rule
 * that affects a rank is declared here: no database order, no JavaScript object
 * insertion order, and no silent zero for a missing evaluation.
 */

export const JUDGING_METHODS = [
  'COMMUNITY',
  'JUDGES',
  'HYBRID',
  'CURATED',
] as const;

export type JudgingMethod = (typeof JUDGING_METHODS)[number];

export const MISSING_EVALUATION_POLICIES = ['EXCLUDE', 'ZERO'] as const;
export type MissingEvaluationPolicy =
  (typeof MISSING_EVALUATION_POLICIES)[number];

export const TIE_BREAK_TYPES = [
  'CRITERION',
  'CRITERIA_AVERAGE',
  'SUBMITTED_AT',
  'JUDGE_DECISION',
] as const;
export type TieBreakType = (typeof TIE_BREAK_TYPES)[number];

export type RubricCriterion = {
  id: string;
  label: string;
  description?: string;
  /** Whole percentage. Criteria weights must total 100. */
  weight: number;
  minScore: number;
  maxScore: number;
  required?: boolean;
};

export type TieBreakRule = {
  type: TieBreakType;
  criteria?: string[];
  label?: string;
};

export type ScoringConfiguration = {
  judgingMethod: JudgingMethod;
  communityWeight: number;
  judgeWeight: number;
  rubric: readonly RubricCriterion[];
  minimumEvaluations: number;
  missingEvaluationPolicy: MissingEvaluationPolicy;
  tieBreak: readonly TieBreakRule[];
};

export type EvaluationInput = {
  judgeId: string;
  status: 'DRAFT' | 'SUBMITTED';
  scores: Readonly<Record<string, number>>;
};

export type RankableEntry = {
  id: string;
  title: string;
  submittedAt: string | Date;
  curatedRank?: number | null;
  communitySupporters: number;
  disqualified?: boolean;
  evaluations: readonly EvaluationInput[];
};

export type ScoredEntry = {
  entry: RankableEntry;
  rank: number | null;
  officialScore: number | null;
  judgeScore: number | null;
  communityScore: number | null;
  completedEvaluations: number;
  incompleteReason: string | null;
  disqualified: boolean;
};

export type RankingResult = {
  entries: ScoredEntry[];
  ranked: ScoredEntry[];
  unranked: ScoredEntry[];
  communityScaleMax: number;
  methodology: MethodologySummary;
};

export type MethodologySummary = {
  judgingMethod: JudgingMethod;
  communityWeight: number;
  judgeWeight: number;
  minimumEvaluations: number;
  missingEvaluationPolicy: MissingEvaluationPolicy;
  rubric: readonly RubricCriterion[];
  tieBreak: readonly TieBreakRule[];
  rounding: 'TWO_DECIMAL_PLACES';
  communityScale: 'LINEAR_TO_HIGHEST_ENTRY';
  formula: string;
};

export type ScoringIssue = { field: string; message: string };

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Rubric validation is deliberately strict. A published rubric whose weights do
 * not total 100, or whose ranges are unusable, cannot produce a defensible
 * score, so publishing is blocked rather than silently normalised.
 */
export function validateRubric(
  criteria: readonly RubricCriterion[],
): ScoringIssue[] {
  const issues: ScoringIssue[] = [];
  if (criteria.length === 0) {
    issues.push({
      field: 'rubric',
      message: 'Add at least one scoring criterion before judging.',
    });
    return issues;
  }

  const ids = new Set<string>();
  for (const [index, criterion] of criteria.entries()) {
    if (!criterion.id.trim()) {
      issues.push({
        field: `rubric.${index}.id`,
        message: 'Every criterion needs an id.',
      });
    } else if (ids.has(criterion.id)) {
      issues.push({
        field: `rubric.${index}.id`,
        message: `The criterion id "${criterion.id}" is duplicated.`,
      });
    }
    ids.add(criterion.id);

    if (!criterion.label.trim()) {
      issues.push({
        field: `rubric.${index}.label`,
        message: 'Every criterion needs a label.',
      });
    }
    if (!Number.isInteger(criterion.weight) || criterion.weight < 0) {
      issues.push({
        field: `rubric.${index}.weight`,
        message: 'Weights are whole percentages and cannot be negative.',
      });
    }
    if (!Number.isFinite(criterion.minScore) || criterion.minScore < 0) {
      issues.push({
        field: `rubric.${index}.minScore`,
        message: 'The minimum score cannot be negative.',
      });
    }
    if (
      !Number.isFinite(criterion.maxScore) ||
      criterion.maxScore <= criterion.minScore
    ) {
      issues.push({
        field: `rubric.${index}.maxScore`,
        message: 'The maximum score must be greater than the minimum.',
      });
    }
    if (criterion.maxScore > 100) {
      issues.push({
        field: `rubric.${index}.maxScore`,
        message: 'Scores are bounded at 100.',
      });
    }
  }

  const total = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  if (total !== 100) {
    issues.push({
      field: 'rubric',
      message: `Criterion weights must total 100 (currently ${total}).`,
    });
  }

  return issues;
}

export function validateScoringConfiguration(
  config: ScoringConfiguration,
): ScoringIssue[] {
  const issues: ScoringIssue[] = [];
  if (!JUDGING_METHODS.includes(config.judgingMethod)) {
    issues.push({
      field: 'judgingMethod',
      message: 'Choose a supported ranking method.',
    });
  }

  const usesJudges =
    config.judgingMethod === 'JUDGES' || config.judgingMethod === 'HYBRID';
  if (usesJudges) {
    issues.push(...validateRubric(config.rubric));
  }

  if (config.judgingMethod === 'HYBRID') {
    if (
      !Number.isInteger(config.communityWeight) ||
      !Number.isInteger(config.judgeWeight) ||
      config.communityWeight < 0 ||
      config.judgeWeight < 0 ||
      config.communityWeight + config.judgeWeight !== 100
    ) {
      issues.push({
        field: 'weights',
        message:
          'Hybrid community and judge weights must be whole percentages that total 100.',
      });
    }
  }

  if (!Number.isInteger(config.minimumEvaluations) || config.minimumEvaluations < 0) {
    issues.push({
      field: 'minimumEvaluations',
      message: 'The minimum number of evaluations cannot be negative.',
    });
  }

  if (!MISSING_EVALUATION_POLICIES.includes(config.missingEvaluationPolicy)) {
    issues.push({
      field: 'missingEvaluationPolicy',
      message: 'Choose EXCLUDE or ZERO for missing evaluations.',
    });
  }

  if (usesJudges && config.minimumEvaluations < 1 && config.missingEvaluationPolicy !== 'ZERO') {
    issues.push({
      field: 'minimumEvaluations',
      message:
        'Judge-scored programmes need at least one completed evaluation, unless missing evaluations are explicitly scored as ZERO.',
    });
  }

  for (const [index, rule] of config.tieBreak.entries()) {
    if (!TIE_BREAK_TYPES.includes(rule.type)) {
      issues.push({
        field: `tieBreak.${index}`,
        message: 'Unsupported tie-break rule.',
      });
      continue;
    }
    // A manual judge decision is an organiser action, not an automatic sort.
    // If it is published as a tie-break it must be applied through curated
    // ranks, otherwise the published rule silently does nothing.
    if (rule.type === 'JUDGE_DECISION' && config.judgingMethod !== 'CURATED') {
      issues.push({
        field: `tieBreak.${index}`,
        message:
          'A judge-decision tie-break requires the CURATED judging method so the decision is recorded as a curated rank.',
      });
    }
  }

  return issues;
}

/**
 * One evaluation, normalised to 0..100. Returns null when any required
 * criterion is missing or out of range, so an incomplete evaluation is never
 * mistaken for a low score.
 */
export function weightedJudgeScore(
  scores: Readonly<Record<string, number>>,
  rubric: readonly RubricCriterion[],
): number | null {
  let total = 0;
  for (const criterion of rubric) {
    const raw = scores[criterion.id];
    if (raw === undefined || !Number.isFinite(raw)) {
      if (criterion.required !== false) return null;
      continue;
    }
    if (raw < criterion.minScore || raw > criterion.maxScore) {
      return null;
    }
    const span = criterion.maxScore - criterion.minScore;
    if (span <= 0) return null;
    const normalised = ((raw - criterion.minScore) / span) * 100;
    total += (normalised * criterion.weight) / 100;
  }
  return round2(total);
}

/**
 * The community component uses a linear scale to the highest eligible entry, so
 * a paid boost that changes `supporters` changes only this declared community
 * metric and never a judge score. The scale maximum is computed once per
 * ranking run and stored with the published result.
 */
export function communityScore(
  supporters: number,
  scaleMax: number,
): number {
  if (!Number.isFinite(supporters) || supporters <= 0) return 0;
  if (!Number.isFinite(scaleMax) || scaleMax <= 0) return 0;
  return round2(Math.min(100, (supporters / scaleMax) * 100));
}

function completedEvaluations(entry: RankableEntry): EvaluationInput[] {
  const seen = new Set<string>();
  return entry.evaluations.filter((evaluation) => {
    if (evaluation.status !== 'SUBMITTED') return false;
    if (seen.has(evaluation.judgeId)) return false;
    seen.add(evaluation.judgeId);
    return true;
  });
}

function judgeAverage(
  evaluations: readonly EvaluationInput[],
  rubric: readonly RubricCriterion[],
): { average: number | null; completed: number } {
  const completed: number[] = [];
  for (const evaluation of evaluations) {
    const score = weightedJudgeScore(evaluation.scores, rubric);
    if (score !== null) completed.push(score);
  }
  if (completed.length === 0) return { average: null, completed: 0 };
  return {
    average: round2(
      completed.reduce((sum, score) => sum + score, 0) / completed.length,
    ),
    completed: completed.length,
  };
}

function criterionValue(
  entry: RankableEntry,
  criterionId: string,
  rubric: readonly RubricCriterion[],
): number | null {
  const criterion = rubric.find((item) => item.id === criterionId);
  if (!criterion) return null;
  const values = completedEvaluations(entry)
    .map((evaluation) => evaluation.scores[criterionId])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) return null;
  return round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function submittedTime(entry: RankableEntry): number {
  const value =
    entry.submittedAt instanceof Date
      ? entry.submittedAt.getTime()
      : new Date(entry.submittedAt).getTime();
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function compareTieBreak(
  left: RankableEntry & { judgeScore: number | null },
  right: RankableEntry & { judgeScore: number | null },
  rules: readonly TieBreakRule[],
  rubric: readonly RubricCriterion[],
): number {
  for (const rule of rules) {
    if (rule.type === 'CRITERION') {
      const id = rule.criteria?.[0];
      if (!id) continue;
      const leftValue = criterionValue(left, id, rubric);
      const rightValue = criterionValue(right, id, rubric);
      if (leftValue === null && rightValue === null) continue;
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      if (rightValue !== leftValue) return rightValue - leftValue;
    }
    if (rule.type === 'CRITERIA_AVERAGE') {
      const ids = rule.criteria ?? [];
      if (ids.length === 0) continue;
      const average = (entry: RankableEntry) => {
        const values = ids
          .map((id) => criterionValue(entry, id, rubric))
          .filter((value): value is number => value !== null);
        return values.length === 0
          ? null
          : values.reduce((sum, value) => sum + value, 0) / values.length;
      };
      const leftValue = average(left);
      const rightValue = average(right);
      if (leftValue === null && rightValue === null) continue;
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      if (rightValue !== leftValue) return rightValue - leftValue;
    }
    if (rule.type === 'SUBMITTED_AT') {
      const delta = submittedTime(left) - submittedTime(right);
      if (delta !== 0) return delta;
    }
    // JUDGE_DECISION is a manual organiser decision. It is applied by writing a
    // curated rank; the automatic sort only guarantees a deterministic fallback.
  }

  // Never resolve a tie with database order: earlier submission, then the
  // stable id, is the declared final fallback.
  const delta = submittedTime(left) - submittedTime(right);
  if (delta !== 0) return delta;
  return left.id.localeCompare(right.id);
}

export function methodologyFor(
  config: ScoringConfiguration,
): MethodologySummary {
  const formula =
    config.judgingMethod === 'COMMUNITY'
      ? 'official = community normalised to the highest entry (0-100)'
      : config.judgingMethod === 'JUDGES'
        ? 'official = mean of completed rubric scores, each normalised to 0-100'
        : config.judgingMethod === 'HYBRID'
          ? `official = judge (${config.judgeWeight}%) + community (${config.communityWeight}%), both normalised to 0-100`
          : 'official = order set by the authorised judge decision (curated rank)';

  return {
    judgingMethod: config.judgingMethod,
    communityWeight: config.communityWeight,
    judgeWeight: config.judgeWeight,
    minimumEvaluations: config.minimumEvaluations,
    missingEvaluationPolicy: config.missingEvaluationPolicy,
    rubric: config.rubric,
    tieBreak: config.tieBreak,
    rounding: 'TWO_DECIMAL_PLACES',
    communityScale: 'LINEAR_TO_HIGHEST_ENTRY',
    formula,
  };
}

/**
 * Ranks entries. `officialScore` is null for an entry that cannot be scored
 * under the published rules; that entry is returned in `unranked` with a reason
 * rather than being given a fake zero.
 */
export function rankEntries(
  entries: readonly RankableEntry[],
  config: ScoringConfiguration,
): RankingResult {
  const scaleMax = entries.reduce(
    (max, entry) =>
      entry.disqualified ? max : Math.max(max, entry.communitySupporters),
    0,
  );

  const scored: ScoredEntry[] = entries.map((entry) => {
    if (entry.disqualified) {
      return {
        entry,
        rank: null,
        officialScore: null,
        judgeScore: null,
        communityScore: null,
        completedEvaluations: 0,
        incompleteReason: 'Disqualified by the organiser',
        disqualified: true,
      };
    }

    const { average, completed } = judgeAverage(
      completedEvaluations(entry),
      config.rubric,
    );
    const community = communityScore(entry.communitySupporters, scaleMax);
    const needsJudge =
      config.judgingMethod === 'JUDGES' || config.judgingMethod === 'HYBRID';

    if (needsJudge && (completed < config.minimumEvaluations || average === null)) {
      if (config.missingEvaluationPolicy === 'ZERO') {
        const zeroedJudge = 0;
        const score =
          config.judgingMethod === 'HYBRID'
            ? round2(
                (zeroedJudge * config.judgeWeight) / 100 +
                  (community * config.communityWeight) / 100,
              )
            : zeroedJudge;
        return {
          entry,
          rank: null,
          officialScore: score,
          judgeScore: zeroedJudge,
          communityScore: community,
          completedEvaluations: completed,
          incompleteReason: null,
          disqualified: false,
        };
      }
      return {
        entry,
        rank: null,
        officialScore: null,
        judgeScore: average,
        communityScore: community,
        completedEvaluations: completed,
        incompleteReason: `Awaiting ${config.minimumEvaluations - completed} more completed evaluation(s)`,
        disqualified: false,
      };
    }

    let official: number | null;
    if (config.judgingMethod === 'COMMUNITY') {
      official = community;
    } else if (config.judgingMethod === 'CURATED') {
      // Curated standings are an authorised order, not a numeric score. The
      // rank is published; inventing a score would misrepresent the method.
      official = null;
    } else if (config.judgingMethod === 'HYBRID') {
      official = round2(
        ((average ?? 0) * config.judgeWeight) / 100 +
          (community * config.communityWeight) / 100,
      );
    } else {
      official = average ?? 0;
    }

    return {
      entry,
      rank: null,
      officialScore: official,
      judgeScore: average,
      communityScore: community,
      completedEvaluations: completed,
      incompleteReason:
        config.judgingMethod === 'CURATED' && entry.curatedRank == null
          ? 'Awaiting an authorised judge decision'
          : null,
      disqualified: false,
    };
  });

  const eligible = scored.filter(
    (entry) => !entry.disqualified && entry.incompleteReason === null,
  );

  eligible.sort((left, right) => {
    if (config.judgingMethod === 'CURATED') {
      const delta =
        (left.entry.curatedRank ?? Number.MAX_SAFE_INTEGER) -
        (right.entry.curatedRank ?? Number.MAX_SAFE_INTEGER);
      if (delta !== 0) return delta;
      return compareTieBreak(
        { ...left.entry, judgeScore: left.judgeScore },
        { ...right.entry, judgeScore: right.judgeScore },
        config.tieBreak,
        config.rubric,
      );
    }

    const leftScore = left.officialScore ?? 0;
    const rightScore = right.officialScore ?? 0;
    if (rightScore !== leftScore) return rightScore - leftScore;
    return compareTieBreak(
      { ...left.entry, judgeScore: left.judgeScore },
      { ...right.entry, judgeScore: right.judgeScore },
      config.tieBreak,
      config.rubric,
    );
  });

  eligible.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  const unranked = scored.filter(
    (entry) => !entry.disqualified && entry.incompleteReason !== null,
  );

  return {
    entries: scored,
    ranked: eligible,
    unranked,
    communityScaleMax: scaleMax,
    methodology: methodologyFor(config),
  };
}

/**
 * A stable checksum over the published ordering and the inputs that produced
 * it. It makes a published result reproducible without storing every row twice.
 */
export function standingsChecksum(result: RankingResult): string {
  return JSON.stringify({
    methodology: result.methodology,
    communityScaleMax: result.communityScaleMax,
    ranked: result.ranked.map((entry) => ({
      id: entry.entry.id,
      rank: entry.rank,
      score: entry.officialScore,
      judge: entry.judgeScore,
      community: entry.communityScore,
      evaluations: entry.completedEvaluations,
    })),
    unranked: result.unranked.map((entry) => ({
      id: entry.entry.id,
      reason: entry.incompleteReason,
    })),
  });
}
