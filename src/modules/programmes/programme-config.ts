import {
  MISSING_EVALUATION_POLICIES,
  TIE_BREAK_TYPES,
  type RubricCriterion,
  type ScoringConfiguration,
  type TieBreakRule,
  validateScoringConfiguration,
  type JudgingMethod,
  type MissingEvaluationPolicy,
  type ScoringIssue,
} from './programme-scoring';

/**
 * Shapes coming out of Prisma. Kept structural so the same helpers can be used
 * by unit tests with plain objects and by services with generated types.
 */
export type ProgrammeSetupInput = {
  status: string;
  type: string;
  title: string;
  tagline: string;
  slug: string;
  registrationOpensAt: Date;
  registrationClosesAt: Date;
  submissionOpensAt: Date;
  submissionClosesAt: Date;
  judgingStartsAt: Date;
  judgingEndsAt: Date;
  resultsAt: Date;
  entryMode: string;
  allowedCategories: readonly string[];
  allowMultipleEntries: boolean;
  maxEntriesPerParticipant: number;
  allowTeams: boolean;
  teamMinSize: number;
  teamMaxSize: number;
  minQualityScore: unknown;
  judgingMethod: string;
  communityWeight: number;
  judgeWeight: number;
  rubric: unknown;
  minimumEvaluations: number;
  missingEvaluationPolicy: string;
  tieBreak: unknown;
  prizes: readonly {
    kind: string;
    amountAtomic: string | null;
    fundingStatus: string;
  }[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Normalises stored JSON into the rubric type. Invalid entries are dropped. */
export function readRubric(value: unknown): RubricCriterion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = typeof entry.id === 'string' ? entry.id : '';
    const label = typeof entry.label === 'string' ? entry.label : '';
    const weight = typeof entry.weight === 'number' ? entry.weight : Number.NaN;
    const minScore = typeof entry.minScore === 'number' ? entry.minScore : Number.NaN;
    const maxScore = typeof entry.maxScore === 'number' ? entry.maxScore : Number.NaN;
    if (!id || !label || !Number.isFinite(weight)) return [];
    return [
      {
        id,
        label,
        ...(typeof entry.description === 'string'
          ? { description: entry.description }
          : {}),
        weight,
        minScore,
        maxScore,
        ...(entry.required === false ? { required: false } : {}),
      },
    ];
  });
}

export function readTieBreak(value: unknown): TieBreakRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const type = entry.type;
    if (
      typeof type !== 'string' ||
      !TIE_BREAK_TYPES.includes(type as (typeof TIE_BREAK_TYPES)[number])
    ) {
      return [];
    }
    return [
      {
        type: type as TieBreakRule['type'],
        ...(Array.isArray(entry.criteria)
          ? { criteria: entry.criteria.filter((item): item is string => typeof item === 'string') }
          : {}),
        ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
      },
    ];
  });
}

export function scoringConfigurationFrom(setup: {
  judgingMethod: string;
  communityWeight: number;
  judgeWeight: number;
  rubric: unknown;
  minimumEvaluations: number;
  missingEvaluationPolicy: string;
  tieBreak: unknown;
}): ScoringConfiguration {
  const method = (
    ['COMMUNITY', 'JUDGES', 'HYBRID', 'CURATED'] as const
  ).includes(setup.judgingMethod as JudgingMethod)
    ? (setup.judgingMethod as JudgingMethod)
    : 'JUDGES';
  const policy = MISSING_EVALUATION_POLICIES.includes(
    setup.missingEvaluationPolicy as MissingEvaluationPolicy,
  )
    ? (setup.missingEvaluationPolicy as MissingEvaluationPolicy)
    : 'EXCLUDE';

  return {
    judgingMethod: method,
    communityWeight: setup.communityWeight,
    judgeWeight: setup.judgeWeight,
    rubric: readRubric(setup.rubric),
    minimumEvaluations: setup.minimumEvaluations,
    missingEvaluationPolicy: policy,
    tieBreak: readTieBreak(setup.tieBreak),
  };
}

function checkTimeline(setup: ProgrammeSetupInput): ScoringIssue[] {
  const issues: ScoringIssue[] = [];
  const ordered: Array<[string, Date]> = [
    ['registrationOpensAt', setup.registrationOpensAt],
    ['registrationClosesAt', setup.registrationClosesAt],
    ['submissionOpensAt', setup.submissionOpensAt],
    ['submissionClosesAt', setup.submissionClosesAt],
    ['judgingStartsAt', setup.judgingStartsAt],
    ['judgingEndsAt', setup.judgingEndsAt],
    ['resultsAt', setup.resultsAt],
  ];

  for (const [field, value] of ordered) {
    if (Number.isNaN(value.getTime())) {
      issues.push({ field, message: `${field} must be a valid date.` });
    }
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const [previousField, previous] = ordered[index - 1]!;
    const [field, value] = ordered[index]!;
    if (previous.getTime() > value.getTime()) {
      issues.push({
        field,
        message: `${field} cannot be earlier than ${previousField}.`,
      });
    }
  }

  if (setup.registrationClosesAt > setup.submissionClosesAt) {
    issues.push({
      field: 'registrationClosesAt',
      message: 'Registration cannot close after submissions close.',
    });
  }

  return issues;
}

/**
 * Setup validation runs before a programme opens or publishes. It returns every
 * problem at once so the organiser fixes the edition in one pass rather than
 * discovering a second gate after the first.
 */
export function validateProgrammeSetup(
  setup: ProgrammeSetupInput,
): ScoringIssue[] {
  const issues = checkTimeline(setup);

  if (!setup.title.trim()) {
    issues.push({ field: 'title', message: 'Add a title.' });
  }
  if (setup.teamMinSize > setup.teamMaxSize) {
    issues.push({
      field: 'teamMaxSize',
      message: 'The maximum team size must be at least the minimum.',
    });
  }
  if (!setup.allowMultipleEntries && setup.maxEntriesPerParticipant !== 1) {
    issues.push({
      field: 'maxEntriesPerParticipant',
      message:
        'A single-entry programme must set the limit to 1, or enable multiple entries.',
    });
  }
  if (setup.allowMultipleEntries && setup.maxEntriesPerParticipant < 1) {
    issues.push({
      field: 'maxEntriesPerParticipant',
      message: 'Multiple entries need a limit of at least 1.',
    });
  }

  const scoring = scoringConfigurationFrom(setup);
  issues.push(...validateScoringConfiguration(scoring));

  const quality = decimalToNumber(setup.minQualityScore);
  if (quality !== null && (quality < 0 || quality > 1)) {
    issues.push({
      field: 'minQualityScore',
      message: 'The quality threshold must be between 0 and 1.',
    });
  }

  return issues;
}

/**
 * FR-1207: a programme may not open with an advertised prize it cannot pay.
 * Every cash-bearing prize must be FUNDED before the edition opens. Non-cash
 * benefits must be at least COMMITTED, because an uncommitted benefit cannot be
 * described as secured.
 */
export function validatePrizeFunding(
  prizes: ProgrammeSetupInput['prizes'],
): ScoringIssue[] {
  const issues: ScoringIssue[] = [];
  for (const [index, prize] of prizes.entries()) {
    const cash = prize.kind === 'CASH' || prize.kind === 'MIXED';
    if (cash && prize.fundingStatus !== 'FUNDED') {
      issues.push({
        field: `prizes.${index}.fundingStatus`,
        message:
          'Every cash prize must be marked FUNDED before the programme can open.',
      });
    }
    if (!cash && !['COMMITTED', 'FUNDED', 'DELIVERED'].includes(prize.fundingStatus)) {
      issues.push({
        field: `prizes.${index}.fundingStatus`,
        message:
          'A non-cash benefit must be committed or delivered before it is advertised.',
      });
    }
  }
  return issues;
}

const TRANSITIONS: Record<string, readonly string[]> = {
  DRAFT: ['SCHEDULED', 'REGISTRATION_OPEN', 'ARCHIVED'],
  SCHEDULED: ['REGISTRATION_OPEN', 'ARCHIVED'],
  REGISTRATION_OPEN: ['SUBMISSION_OPEN', 'JUDGING', 'ARCHIVED'],
  SUBMISSION_OPEN: ['JUDGING', 'ARCHIVED'],
  JUDGING: ['RESULTS_REVIEW', 'ARCHIVED'],
  RESULTS_REVIEW: ['COMPLETED', 'ARCHIVED'],
  COMPLETED: ['ARCHIVED'],
  ARCHIVED: [],
};

export function canTransitionProgramme(from: string, to: string): boolean {
  if (from === to) return false;
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** Public-facing prize rows: only benefits that are secured (FR-1206/1207). */
export function isPrizeAdvertisable(prize: {
  kind: string;
  fundingStatus: string;
}): boolean {
  if (prize.kind === 'CASH' || prize.kind === 'MIXED') {
    return prize.fundingStatus === 'FUNDED';
  }
  return ['COMMITTED', 'FUNDED', 'DELIVERED'].includes(prize.fundingStatus);
}

export function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (isRecord(value) && typeof value.toNumber === 'function') {
    const parsed = (value.toNumber as () => number)();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
