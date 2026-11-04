import {
  communityScore,
  rankEntries,
  standingsChecksum,
  validateRubric,
  validateScoringConfiguration,
  weightedJudgeScore,
  type RankableEntry,
  type RubricCriterion,
  type ScoringConfiguration,
} from './programme-scoring';

const rubric: RubricCriterion[] = [
  { id: 'problem', label: 'Problem', weight: 60, minScore: 0, maxScore: 10 },
  { id: 'team', label: 'Team', weight: 40, minScore: 0, maxScore: 5 },
];

const config = (
  overrides: Partial<ScoringConfiguration> = {},
): ScoringConfiguration => ({
  judgingMethod: 'JUDGES',
  communityWeight: 0,
  judgeWeight: 100,
  rubric,
  minimumEvaluations: 1,
  missingEvaluationPolicy: 'EXCLUDE',
  tieBreak: [{ type: 'SUBMITTED_AT' }],
  ...overrides,
});

const entry = (
  id: string,
  overrides: Partial<RankableEntry> = {},
): RankableEntry => ({
  id,
  title: id,
  submittedAt: '2026-01-02T12:00:00.000Z',
  communitySupporters: 0,
  evaluations: [],
  ...overrides,
});

const evaluation = (
  judgeId: string,
  problem: number,
  team: number,
  status: 'DRAFT' | 'SUBMITTED' = 'SUBMITTED',
) => ({
  judgeId,
  status,
  scores: { problem, team },
});

describe('validateRubric', () => {
  it('requires at least one criterion', () => {
    // #given an empty rubric
    // #when it is validated
    // #then publishing is blocked
    expect(validateRubric([])).toEqual([
      expect.objectContaining({ field: 'rubric' }),
    ]);
  });

  it('rejects duplicate ids, non-integer weights and bad ranges', () => {
    // #given a malformed rubric
    // #when it is validated
    // #then every problem is returned at once
    const issues = validateRubric([
      { id: 'a', label: 'A', weight: 50.5, minScore: 0, maxScore: 10 },
      { id: 'a', label: 'A again', weight: 30, minScore: 5, maxScore: 2 },
      { id: '', label: '', weight: 19, minScore: -1, maxScore: 101 },
    ]);
    expect(issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining([
        'rubric.0.weight',
        'rubric.1.id',
        'rubric.1.maxScore',
        'rubric.2.id',
        'rubric.2.label',
        'rubric.2.minScore',
        'rubric.2.maxScore',
        'rubric',
      ]),
    );
  });

  it('requires weights to total exactly one hundred', () => {
    // #given weights that total 90
    // #when validated
    // #then the total is reported
    expect(
      validateRubric([
        { id: 'a', label: 'A', weight: 50, minScore: 0, maxScore: 10 },
        { id: 'b', label: 'B', weight: 40, minScore: 0, maxScore: 10 },
      ]),
    ).toEqual([
      expect.objectContaining({ field: 'rubric', message: expect.stringContaining('90') }),
    ]);
  });
});

describe('validateScoringConfiguration', () => {
  it('requires hybrid weights to total one hundred', () => {
    // #given a hybrid programme weighted 60/30
    // #when validated
    // #then the weights are rejected
    expect(
      validateScoringConfiguration(
        config({ judgingMethod: 'HYBRID', communityWeight: 60, judgeWeight: 30 }),
      ),
    ).toEqual([
      expect.objectContaining({ field: 'weights' }),
    ]);
  });

  it('requires a rubric for judged methods but not for community', () => {
    // #given an empty rubric
    // #when judge and community methods are validated
    // #then only the judged method is blocked
    expect(
      validateScoringConfiguration(config({ rubric: [] })).some(
        (issue) => issue.field === 'rubric',
      ),
    ).toBe(true);
    expect(
      validateScoringConfiguration(
        config({ judgingMethod: 'COMMUNITY', rubric: [] }),
      ),
    ).toEqual([]);
  });

  it('rejects a manual judge tie-break outside curated judging', () => {
    // #given JUDGE_DECISION on a JUDGES programme
    // #when validated
    // #then it is refused rather than silently ignored
    expect(
      validateScoringConfiguration(
        config({ tieBreak: [{ type: 'JUDGE_DECISION' }] }),
      ),
    ).toEqual([
      expect.objectContaining({
        field: 'tieBreak.0',
        message: expect.stringContaining('CURATED'),
      }),
    ]);
  });

  it('rejects zero minimum evaluations for judge scoring unless ZERO is explicit', () => {
    // #given no minimum evaluations and EXCLUDE
    // #when validated
    // #then the configuration cannot silently score a missing judge as zero
    expect(
      validateScoringConfiguration(config({ minimumEvaluations: 0 })),
    ).toEqual([
      expect.objectContaining({ field: 'minimumEvaluations' }),
    ]);
    expect(
      validateScoringConfiguration(
        config({ minimumEvaluations: 0, missingEvaluationPolicy: 'ZERO' }),
      ),
    ).toEqual([]);
  });
});

describe('weightedJudgeScore', () => {
  it('normalises each criterion to 0..100 and applies its weight', () => {
    // #given 8/10 on problem (60%) and 4/5 on team (40%)
    // #when the weighted score is computed
    // #then the result is 80
    expect(weightedJudgeScore({ problem: 8, team: 4 }, rubric)).toBe(80);
  });

  it('returns null when a required criterion is missing or out of range', () => {
    // #given an incomplete or invalid score set
    // #when scored
    // #then it is not mistaken for a low score
    expect(weightedJudgeScore({ problem: 8 }, rubric)).toBeNull();
    expect(weightedJudgeScore({ problem: 11, team: 4 }, rubric)).toBeNull();
  });

  it('allows an optional criterion to be omitted without zeroing it', () => {
    // #given an optional criterion worth 40%
    // #when only the required 60% criterion is scored
    // #then the total reflects only the supplied criterion
    const optionalRubric: RubricCriterion[] = [
      { ...rubric[0]!, required: true },
      { ...rubric[1]!, required: false },
    ];
    expect(weightedJudgeScore({ problem: 10 }, optionalRubric)).toBe(60);
  });
});

describe('communityScore', () => {
  it('scales linearly to the highest entry and caps at 100', () => {
    // #given a scale maximum of 200
    // #when supporters are 50 and 500
    // #then the score is 25 and capped at 100
    expect(communityScore(50, 200)).toBe(25);
    expect(communityScore(500, 200)).toBe(100);
  });

  it('returns zero for no supporters or no scale', () => {
    // #given a zero scale
    // #when scored
    // #then the score is zero rather than NaN
    expect(communityScore(10, 0)).toBe(0);
    expect(communityScore(0, 100)).toBe(0);
  });
});

describe('rankEntries', () => {
  it('ranks by the mean of submitted rubric scores', () => {
    // #given two entries with different submitted averages
    // #when ranked
    // #then the higher average is first
    const result = rankEntries(
      [
        entry('low', { evaluations: [evaluation('j1', 5, 3)] }),
        entry('high', { evaluations: [evaluation('j1', 9, 5)] }),
      ],
      config(),
    );
    expect(result.ranked.map((row) => row.entry.id)).toEqual(['high', 'low']);
    expect(result.ranked[0]?.officialScore).toBe(94);
  });

  it('ignores draft evaluations and duplicate judge submissions', () => {
    // #given a draft and two submissions from the same judge
    // #when ranked
    // #then only the first submitted score per judge counts
    const result = rankEntries(
      [
        entry('a', {
          evaluations: [
            evaluation('j1', 1, 1, 'DRAFT'),
            evaluation('j1', 8, 4),
            evaluation('j1', 1, 1),
          ],
        }),
      ],
      config(),
    );
    expect(result.ranked[0]?.officialScore).toBe(80);
    expect(result.ranked[0]?.completedEvaluations).toBe(1);
  });

  it('leaves an entry with missing evaluations unranked and never scores it zero', () => {
    // #given an entry with no evaluations and EXCLUDE
    // #when ranked
    // #then it is unranked with a reason and a null official score
    const result = rankEntries([entry('pending')], config());
    expect(result.ranked).toHaveLength(0);
    expect(result.unranked[0]).toMatchObject({
      rank: null,
      officialScore: null,
      incompleteReason: expect.stringContaining('1 more'),
    });
  });

  it('scores a missing evaluation as zero only when ZERO is explicitly published', () => {
    // #given an entry with no evaluations and the ZERO policy
    // #when ranked
    // #then it is ranked at zero with no incomplete reason
    const result = rankEntries(
      [entry('pending')],
      config({ missingEvaluationPolicy: 'ZERO' }),
    );
    expect(result.ranked[0]).toMatchObject({
      rank: 1,
      officialScore: 0,
      incompleteReason: null,
    });
    expect(result.methodology.missingEvaluationPolicy).toBe('ZERO');
  });

  it('combines judge and community weights for hybrid programmes', () => {
    // #given a 70/30 hybrid with an 80 judge score and full community score
    // #when ranked
    // #then the official score is 86
    const result = rankEntries(
      [entry('a', { communitySupporters: 10, evaluations: [evaluation('j1', 8, 4)] })],
      config({ judgingMethod: 'HYBRID', communityWeight: 30, judgeWeight: 70 }),
    );
    expect(result.ranked[0]?.officialScore).toBe(86);
  });

  it('sorts curated entries by their authorised rank', () => {
    // #given two curated ranks in reverse submitted order
    // #when ranked
    // #then the curated order wins
    const result = rankEntries(
      [
        entry('first', { curatedRank: 1, submittedAt: '2026-01-03T00:00:00.000Z' }),
        entry('second', { curatedRank: 2, submittedAt: '2026-01-02T00:00:00.000Z' }),
      ],
      config({ judgingMethod: 'CURATED', rubric: [] }),
    );
    expect(result.ranked.map((row) => row.entry.id)).toEqual(['first', 'second']);
    expect(result.ranked[0]?.officialScore).toBeNull();
  });

  it('leaves an unset curated rank unranked with a reason', () => {
    // #given a curated entry without a decision
    // #when ranked
    // #then it is not given an arbitrary position
    const result = rankEntries(
      [entry('undecided')],
      config({ judgingMethod: 'CURATED', rubric: [] }),
    );
    expect(result.unranked[0]?.incompleteReason).toContain('judge decision');
  });

  it('breaks a score tie with the submitted time, then the stable id', () => {
    // #given two equal scores
    // #when one was submitted earlier
    // #then the earlier submission wins
    const earlier = entry('zzz', {
      submittedAt: '2026-01-01T00:00:00.000Z',
      evaluations: [evaluation('j1', 8, 4)],
    });
    const later = entry('aaa', {
      submittedAt: '2026-01-02T00:00:00.000Z',
      evaluations: [evaluation('j1', 8, 4)],
    });
    expect(
      rankEntries([later, earlier], config()).ranked.map((row) => row.entry.id),
    ).toEqual(['zzz', 'aaa']);

    // #given the same score and the same time
    // #when the ids differ
    // #then the id provides the deterministic final order
    const same = { submittedAt: '2026-01-01T00:00:00.000Z' };
    expect(
      rankEntries(
        [
          entry('bbb', { ...same, evaluations: [evaluation('j1', 8, 4)] }),
          entry('aaa', { ...same, evaluations: [evaluation('j1', 8, 4)] }),
        ],
        config(),
      ).ranked.map((row) => row.entry.id),
    ).toEqual(['aaa', 'bbb']);
  });

  it('breaks a score tie with a declared criterion', () => {
    // #given equal official scores and a problem-criterion tie-break
    // #when the problem scores differ
    // #then the higher criterion score wins
    const result = rankEntries(
      [
        entry('team-heavy', { evaluations: [evaluation('j1', 5, 5)] }),
        entry('problem-heavy', { evaluations: [evaluation('j1', 9, 2)] }),
      ],
      config({ tieBreak: [{ type: 'CRITERION', criteria: ['problem'] }] }),
    );
    expect(result.ranked.map((row) => row.entry.id)).toEqual([
      'problem-heavy',
      'team-heavy',
    ]);
  });

  it('excludes a disqualified entry from both ranking and the community scale', () => {
    // #given a disqualified entry with the highest supporters
    // #when ranked
    // #then it is not ranked and does not compress other scores
    const result = rankEntries(
      [
        entry('out', { disqualified: true, communitySupporters: 1000 }),
        entry('in', { communitySupporters: 50 }),
      ],
      config({ judgingMethod: 'COMMUNITY', rubric: [] }),
    );
    expect(result.communityScaleMax).toBe(50);
    expect(result.ranked[0]?.entry.id).toBe('in');
    expect(result.entries.find((row) => row.entry.id === 'out')?.disqualified).toBe(
      true,
    );
  });
});

describe('standingsChecksum', () => {
  it('is stable for the same inputs and changes when the order changes', () => {
    // #given the same entries
    // #when ranked twice
    // #then the checksum matches
    const entries = [
      entry('a', { evaluations: [evaluation('j1', 8, 4)] }),
      entry('b', { evaluations: [evaluation('j1', 6, 4)] }),
    ];
    const first = rankEntries(entries, config());
    const second = rankEntries(entries, config());
    expect(standingsChecksum(first)).toBe(standingsChecksum(second));

    // #given the scores are reversed
    // #when ranked
    // #then the checksum changes
    const reversed = rankEntries(
      [
        entry('a', { evaluations: [evaluation('j1', 6, 4)] }),
        entry('b', { evaluations: [evaluation('j1', 8, 4)] }),
      ],
      config(),
    );
    expect(standingsChecksum(reversed)).not.toBe(standingsChecksum(first));
  });
});
