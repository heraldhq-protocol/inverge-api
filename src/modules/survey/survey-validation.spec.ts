import {
  DEFAULT_SURVEY,
  QuestionInput,
  QuestionRef,
  extractRatings,
  validateAnswers,
  validateQuestionSet,
} from './survey-validation';

describe('validateQuestionSet', () => {
  const rating: QuestionInput = { index: 0, prompt: 'Rate it', type: 'RATING' };

  it('accepts a valid set with at least one RATING', () => {
    expect(validateQuestionSet([rating, { index: 1, prompt: 'Why?', type: 'TEXT' }])).toEqual([]);
  });

  it('requires at least one RATING question', () => {
    expect(validateQuestionSet([{ index: 0, prompt: 'Why?', type: 'TEXT' }])).toContainEqual(
      expect.stringMatching(/at least one RATING/i),
    );
  });

  it('rejects choice questions with fewer than 2 options and empty prompts', () => {
    const problems = validateQuestionSet([
      rating,
      { index: 1, prompt: '', type: 'SINGLE_CHOICE', options: ['only-one'] },
    ]);
    expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(/prompt/i), expect.stringMatching(/2 options/i)]));
  });

  it('rejects duplicate indexes', () => {
    expect(validateQuestionSet([rating, { index: 0, prompt: 'dup', type: 'TEXT' }])).toContainEqual(
      expect.stringMatching(/Duplicate question index/i),
    );
  });

  it('the default survey is valid', () => {
    expect(validateQuestionSet(DEFAULT_SURVEY)).toEqual([]);
  });
});

describe('validateAnswers', () => {
  const qs: QuestionRef[] = [
    { id: 'r', type: 'RATING', options: null, required: true },
    { id: 't', type: 'TEXT', options: null, required: false },
    { id: 'sc', type: 'SINGLE_CHOICE', options: ['a', 'b'], required: false },
    { id: 'mc', type: 'MULTI_CHOICE', options: ['x', 'y', 'z'], required: false },
    { id: 'bo', type: 'BOOLEAN', options: null, required: false },
  ];

  it('accepts well-typed answers and normalizes to known questions', () => {
    const { normalized, problems } = validateAnswers(qs, [
      { questionId: 'r', value: 4 },
      { questionId: 'sc', value: 'a' },
      { questionId: 'mc', value: ['x', 'z'] },
      { questionId: 'bo', value: true },
      { questionId: 'unknown', value: 'dropped' },
    ]);
    expect(problems).toEqual([]);
    expect(normalized.map((a) => a.questionId)).toEqual(['r', 'sc', 'mc', 'bo']); // unknown dropped
  });

  it('flags a missing required answer', () => {
    expect(validateAnswers(qs, [{ questionId: 't', value: 'hi' }]).problems).toContainEqual(
      expect.stringMatching(/required/i),
    );
  });

  it('rejects out-of-range rating, invalid choice, and wrong types', () => {
    expect(validateAnswers(qs, [{ questionId: 'r', value: 6 }]).problems.length).toBeGreaterThan(0);
    expect(validateAnswers(qs, [{ questionId: 'r', value: 4 }, { questionId: 'sc', value: 'z' }]).problems.length).toBe(1);
    expect(validateAnswers(qs, [{ questionId: 'r', value: 4 }, { questionId: 'bo', value: 'yes' }]).problems.length).toBe(1);
    expect(validateAnswers(qs, [{ questionId: 'r', value: 4 }, { questionId: 'mc', value: ['x', 'nope'] }]).problems.length).toBe(1);
  });
});

describe('extractRatings', () => {
  it('pulls only RATING answers by question id', () => {
    const ratings = extractRatings(new Set(['r']), [
      { questionId: 'r', value: 5 },
      { questionId: 't', value: 'text' },
      { questionId: 'r2', value: 3 },
    ]);
    expect(ratings).toEqual([5]);
  });
});
