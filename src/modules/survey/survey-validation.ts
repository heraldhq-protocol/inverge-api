// Pure survey validation (no I/O). The creator builds a typed question set; backers
// submit answers that must match. RATING answers (1..5) feed the idea's feedbackScore.
export type QType = 'RATING' | 'TEXT' | 'SINGLE_CHOICE' | 'MULTI_CHOICE' | 'BOOLEAN';

export interface QuestionInput {
  index: number;
  prompt: string;
  type: QType;
  options?: string[];
  required?: boolean;
}

export interface QuestionRef {
  id: string;
  type: QType;
  options: string[] | null;
  required: boolean;
}

export interface Answer {
  questionId: string;
  value: unknown;
}

const isChoice = (t: QType) => t === 'SINGLE_CHOICE' || t === 'MULTI_CHOICE';

// Returns a list of problems; empty means the question set is valid (FR-270-ish gate at
// the survey level: at least one RATING question so feedbackScore is always meaningful).
export function validateQuestionSet(qs: QuestionInput[]): string[] {
  const problems: string[] = [];
  if (qs.length === 0) problems.push('A survey needs at least one question.');
  if (!qs.some((q) => q.type === 'RATING')) {
    problems.push('A survey must include at least one RATING question.');
  }
  const indexes = new Set<number>();
  for (const q of qs) {
    if (!q.prompt || !q.prompt.trim()) problems.push(`Question ${q.index} needs a prompt.`);
    if (indexes.has(q.index)) problems.push(`Duplicate question index ${q.index}.`);
    indexes.add(q.index);
    if (isChoice(q.type)) {
      const opts = q.options ?? [];
      if (opts.length < 2) problems.push(`Question ${q.index} (${q.type}) needs at least 2 options.`);
      if (new Set(opts).size !== opts.length) problems.push(`Question ${q.index} has duplicate options.`);
    }
  }
  return problems;
}

// Validate a backer's answers against the current question set. Returns the normalized
// answers (known questions only) plus a list of problems.
export function validateAnswers(
  questions: QuestionRef[],
  answers: Answer[],
): { normalized: Answer[]; problems: string[] } {
  const problems: string[] = [];
  const byId = new Map(answers.map((a) => [a.questionId, a.value]));
  const normalized: Answer[] = [];

  for (const q of questions) {
    const has = byId.has(q.id);
    const value = byId.get(q.id);
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

    if (q.required && (!has || empty)) {
      problems.push(`Question ${q.id} is required.`);
      continue;
    }
    if (!has || empty) continue; // optional + unanswered

    if (!answerMatchesType(q, value)) {
      problems.push(`Question ${q.id}: invalid answer for ${q.type}.`);
      continue;
    }
    normalized.push({ questionId: q.id, value });
  }
  return { normalized, problems };
}

function answerMatchesType(q: QuestionRef, value: unknown): boolean {
  switch (q.type) {
    case 'RATING':
      return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
    case 'TEXT':
      return typeof value === 'string' && value.length <= 2000;
    case 'BOOLEAN':
      return typeof value === 'boolean';
    case 'SINGLE_CHOICE':
      return typeof value === 'string' && (q.options ?? []).includes(value);
    case 'MULTI_CHOICE':
      return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((v) => typeof v === 'string' && (q.options ?? []).includes(v))
      );
    default:
      return false;
  }
}

// RATING values across a set of normalized answers (for feedbackScore aggregation).
export function extractRatings(ratingQuestionIds: Set<string>, answers: Answer[]): number[] {
  return answers
    .filter((a) => ratingQuestionIds.has(a.questionId) && typeof a.value === 'number')
    .map((a) => a.value as number);
}

// The default survey seeded on idea creation — a rating + an open comment prompt,
// preserving the prior 1..5 + free-text behaviour while the creator customises.
export const DEFAULT_SURVEY: QuestionInput[] = [
  { index: 0, prompt: 'Overall, how promising is this idea?', type: 'RATING', required: true },
  { index: 1, prompt: 'What would make this idea stronger?', type: 'TEXT', required: false },
];
