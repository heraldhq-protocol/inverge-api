import {
  canTransitionProgramme,
  decimalToNumber,
  isPrizeAdvertisable,
  readRubric,
  readTieBreak,
  scoringConfigurationFrom,
  validateProgrammeSetup,
  validatePrizeFunding,
  type ProgrammeSetupInput,
} from './programme-config';

const date = (offset: number) => new Date(Date.UTC(2026, 0, 1 + offset, 12));

const setup = (overrides: Partial<ProgrammeSetupInput> = {}): ProgrammeSetupInput => ({
  status: 'DRAFT',
  type: 'MONTHLY_IDEATHON',
  title: 'February Ideathon',
  tagline: 'Build for the continent',
  slug: 'february-ideathon',
  registrationOpensAt: date(0),
  registrationClosesAt: date(5),
  submissionOpensAt: date(5),
  submissionClosesAt: date(15),
  judgingStartsAt: date(16),
  judgingEndsAt: date(20),
  resultsAt: date(21),
  entryMode: 'NEW_OR_EXISTING',
  allowedCategories: ['climate'],
  allowMultipleEntries: false,
  maxEntriesPerParticipant: 1,
  allowTeams: false,
  teamMinSize: 1,
  teamMaxSize: 4,
  minQualityScore: 0.6,
  judgingMethod: 'JUDGES',
  communityWeight: 0,
  judgeWeight: 100,
  rubric: [
    { id: 'problem', label: 'Problem', weight: 100, minScore: 0, maxScore: 10 },
  ],
  minimumEvaluations: 1,
  missingEvaluationPolicy: 'EXCLUDE',
  tieBreak: [{ type: 'SUBMITTED_AT' }],
  prizes: [],
  ...overrides,
});

describe('readRubric', () => {
  it('drops invalid entries instead of trusting stored JSON', () => {
    // #given a mixed JSON array
    // #when read
    // #then only well-shaped criteria survive, and optional flags are preserved
    expect(
      readRubric([
        { id: 'a', label: 'A', weight: 100, minScore: 0, maxScore: 10, required: false },
        { id: 'b', weight: 10 },
        'nope',
        null,
      ]),
    ).toEqual([
      {
        id: 'a',
        label: 'A',
        weight: 100,
        minScore: 0,
        maxScore: 10,
        required: false,
      },
    ]);
  });

  it('returns an empty list for non-array values', () => {
    // #given a null or object value
    // #when read
    // #then no criteria are invented
    expect(readRubric(null)).toEqual([]);
    expect(readRubric({})).toEqual([]);
  });
});

describe('readTieBreak', () => {
  it('keeps supported rules and drops unsupported ones', () => {
    // #given supported and unsupported rules
    // #when read
    // #then only supported rules survive with their criteria
    expect(
      readTieBreak([
        { type: 'CRITERION', criteria: ['problem', 1] },
        { type: 'RANDOM' },
        { type: 'SUBMITTED_AT', label: 'Earliest' },
      ]),
    ).toEqual([
      { type: 'CRITERION', criteria: ['problem'] },
      { type: 'SUBMITTED_AT', label: 'Earliest' },
    ]);
  });
});

describe('scoringConfigurationFrom', () => {
  it('falls back to safe defaults for unknown stored values', () => {
    // #given an unknown method and policy
    // #when the configuration is read
    // #then it uses JUDGES and EXCLUDE
    const config = scoringConfigurationFrom({
      judgingMethod: 'SOMETHING',
      communityWeight: 0,
      judgeWeight: 100,
      rubric: [],
      minimumEvaluations: 1,
      missingEvaluationPolicy: 'SOMETHING',
      tieBreak: [],
    });
    expect(config.judgingMethod).toBe('JUDGES');
    expect(config.missingEvaluationPolicy).toBe('EXCLUDE');
  });
});

describe('validateProgrammeSetup', () => {
  it('accepts a complete setup', () => {
    // #given a valid programme
    // #when validated
    // #then there are no issues
    expect(validateProgrammeSetup(setup())).toEqual([]);
  });

  it('rejects a timeline whose boundaries are out of order', () => {
    // #given judging that starts before submissions close
    // #when validated
    // #then the timeline is refused
    expect(
      validateProgrammeSetup(setup({ judgingStartsAt: date(10) })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'judgingStartsAt' }),
      ]),
    );
  });

  it('rejects registration that closes after submissions close', () => {
    // #given late registration
    // #when validated
    // #then the timeline is refused
    expect(
      validateProgrammeSetup(setup({ registrationClosesAt: date(16) })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'registrationClosesAt' }),
      ]),
    );
  });

  it('rejects an inconsistent entry limit', () => {
    // #given single-entry mode with a limit of three
    // #when validated
    // #then the contradiction is reported
    expect(
      validateProgrammeSetup(
        setup({ allowMultipleEntries: false, maxEntriesPerParticipant: 3 }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'maxEntriesPerParticipant' }),
      ]),
    );
  });

  it('rejects a team maximum below the minimum', () => {
    // #given teamMinSize 4 and teamMaxSize 2
    // #when validated
    // #then the bounds are refused
    expect(
      validateProgrammeSetup(setup({ teamMinSize: 4, teamMaxSize: 2 })),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'teamMaxSize' })]),
    );
  });

  it('rejects a quality threshold outside 0..1', () => {
    // #given a threshold above one
    // #when validated
    // #then it is refused
    expect(validateProgrammeSetup(setup({ minQualityScore: 1.5 }))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'minQualityScore' }),
      ]),
    );
  });

  it('rejects a missing title', () => {
    // #given an empty title
    // #when validated
    // #then the title is required
    expect(validateProgrammeSetup(setup({ title: '   ' }))).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'title' })]),
    );
  });
});

describe('validatePrizeFunding', () => {
  it('requires every cash prize to be funded', () => {
    // #given a committed cash prize
    // #when validated
    // #then opening is blocked
    expect(
      validatePrizeFunding([
        { kind: 'CASH', amountAtomic: '100000', fundingStatus: 'COMMITTED' },
      ]),
    ).toEqual([
      expect.objectContaining({ field: 'prizes.0.fundingStatus' }),
    ]);
  });

  it('accepts a funded cash prize and a committed non-cash benefit', () => {
    // #given a funded cash prize and a committed mentorship
    // #when validated
    // #then both are advertisable
    expect(
      validatePrizeFunding([
        { kind: 'CASH', amountAtomic: '100000', fundingStatus: 'FUNDED' },
        { kind: 'NON_CASH', amountAtomic: null, fundingStatus: 'COMMITTED' },
      ]),
    ).toEqual([]);
  });

  it('rejects an uncommitted non-cash benefit', () => {
    // #given an unconfirmed mentorship
    // #when validated
    // #then it cannot be advertised
    expect(
      validatePrizeFunding([
        { kind: 'NON_CASH', amountAtomic: null, fundingStatus: 'UNCONFIRMED' },
      ]),
    ).toHaveLength(1);
  });
});

describe('isPrizeAdvertisable', () => {
  it('only advertises secured benefits', () => {
    // #given cash and non-cash prizes in each state
    // #when checked
    // #then unsecured prizes are hidden
    expect(isPrizeAdvertisable({ kind: 'CASH', fundingStatus: 'FUNDED' })).toBe(true);
    expect(isPrizeAdvertisable({ kind: 'CASH', fundingStatus: 'COMMITTED' })).toBe(
      false,
    );
    expect(
      isPrizeAdvertisable({ kind: 'NON_CASH', fundingStatus: 'COMMITTED' }),
    ).toBe(true);
    expect(
      isPrizeAdvertisable({ kind: 'NON_CASH', fundingStatus: 'UNCONFIRMED' }),
    ).toBe(false);
  });
});

describe('canTransitionProgramme', () => {
  it('permits the declared lifecycle only', () => {
    // #given a programme in registration
    // #when it moves
    // #then submission and judging are allowed, but skipping back is not
    expect(canTransitionProgramme('REGISTRATION_OPEN', 'SUBMISSION_OPEN')).toBe(true);
    expect(canTransitionProgramme('REGISTRATION_OPEN', 'JUDGING')).toBe(true);
    expect(canTransitionProgramme('SUBMISSION_OPEN', 'REGISTRATION_OPEN')).toBe(false);
    expect(canTransitionProgramme('COMPLETED', 'DRAFT')).toBe(false);
    expect(canTransitionProgramme('DRAFT', 'DRAFT')).toBe(false);
  });

  it('allows archiving and nothing after it', () => {
    // #given any live state
    // #when archived
    // #then the transition is allowed once
    expect(canTransitionProgramme('JUDGING', 'ARCHIVED')).toBe(true);
    expect(canTransitionProgramme('ARCHIVED', 'REGISTRATION_OPEN')).toBe(false);
  });
});

describe('decimalToNumber', () => {
  it('normalises numbers, strings and Prisma-like decimals', () => {
    // #given different representations of 0.6
    // #when converted
    // #then they are equal
    expect(decimalToNumber(0.6)).toBe(0.6);
    expect(decimalToNumber('0.6')).toBe(0.6);
    expect(decimalToNumber({ toNumber: () => 0.6 })).toBe(0.6);
  });

  it('returns null for unusable values', () => {
    // #given null, NaN and an object without toNumber
    // #when converted
    // #then the absence is explicit
    expect(decimalToNumber(null)).toBeNull();
    expect(decimalToNumber('not a number')).toBeNull();
    expect(decimalToNumber({})).toBeNull();
  });
});
