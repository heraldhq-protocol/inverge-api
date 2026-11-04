import {
  deriveProgrammePhase,
  evaluateEntry,
  evaluateRegistration,
  evaluateSubmission,
  type EntryInput,
  type ProgrammeWindow,
  type RegistrationInput,
  type SubmissionInput,
} from './programme-eligibility';

const day = (offset: number) => new Date(Date.UTC(2026, 0, 1 + offset, 12));

const window = (overrides: Partial<ProgrammeWindow> = {}): ProgrammeWindow => ({
  status: 'SUBMISSION_OPEN',
  registrationOpensAt: day(0),
  registrationClosesAt: day(10),
  submissionOpensAt: day(5),
  submissionClosesAt: day(20),
  judgingStartsAt: day(21),
  judgingEndsAt: day(30),
  resultsAt: day(31),
  lateEntriesAllowed: false,
  ...overrides,
});

const participant = (overrides: Partial<EntryInput['participant']> = {}) => ({
  id: 'user-1',
  emailVerified: true,
  bannedAt: null,
  ...overrides,
});

const idea = (overrides: Partial<EntryInput['idea']> = {}) => ({
  id: 'idea-1',
  ownerId: 'user-1',
  status: 'THRESHOLD_MET' as const,
  qualityScore: 0.8,
  category: 'climate',
  ...overrides,
});

const entryInput = (overrides: Partial<EntryInput> = {}): EntryInput => ({
  now: day(6),
  programme: {
    ...window(),
    registrationRequired: true,
    requireEmailVerified: true,
    entryMode: 'NEW_OR_EXISTING',
    allowedCategories: [],
    allowMultipleEntries: false,
    maxEntriesPerParticipant: 1,
    minQualityScore: null,
  },
  participant: participant(),
  registration: { status: 'ELIGIBLE' },
  activeEntryCount: 0,
  entry: { source: 'EXISTING_IDEA', category: 'climate' },
  idea: idea(),
  ...overrides,
});

const registrationInput = (
  overrides: Partial<RegistrationInput> = {},
): RegistrationInput => ({
  now: day(6),
  programme: {
    ...window(),
    registrationRequired: true,
    requireEmailVerified: true,
  },
  participant: {
    id: 'user-1',
    emailVerified: true,
    bannedAt: null,
  },
  existingRegistration: null,
  ...overrides,
});

const submissionInput = (
  overrides: Partial<SubmissionInput> = {},
): SubmissionInput => ({
  now: day(6),
  programme: {
    ...window(),
    allowTeams: false,
    teamMinSize: 1,
    teamMaxSize: 4,
    requiredFields: [],
    customQuestions: [],
    maxAttachments: 0,
  },
  entry: {
    status: 'DRAFT',
    title: 'Cooling roofs',
    category: 'climate',
    content: {},
    submittedAt: null,
  },
  attachmentsCount: 0,
  teamSize: 0,
  ...overrides,
});

function codes(result: { issues: { code: string }[] }): string[] {
  return result.issues.map((issue) => issue.code);
}

describe('deriveProgrammePhase', () => {
  it('is scheduled before registration opens', () => {
    // #given a timeline that has not opened
    // #when the phase is derived
    // #then registration is not open
    expect(deriveProgrammePhase(window({ status: 'REGISTRATION_OPEN' }), day(-1))).toBe(
      'SCHEDULED',
    );
  });

  it('moves from registration to submission to judging by the stored clock', () => {
    // #given explicit timeline boundaries
    const programme = window({ status: 'REGISTRATION_OPEN' });
    // #when the clock crosses each boundary
    // #then each declared phase is visible
    expect(deriveProgrammePhase(programme, day(3))).toBe('REGISTRATION_OPEN');
    expect(deriveProgrammePhase(programme, day(6))).toBe('SUBMISSION_OPEN');
    expect(deriveProgrammePhase(programme, day(25))).toBe('JUDGING');
    expect(deriveProgrammePhase(programme, day(40))).toBe('RESULTS_REVIEW');
  });

  it('lets archived and completed win over the clock', () => {
    // #given a closed programme whose dates are in the future
    // #when the phase is derived
    // #then the closed state wins
    expect(
      deriveProgrammePhase(window({ status: 'ARCHIVED' }), day(1)),
    ).toBe('ARCHIVED');
    expect(
      deriveProgrammePhase(window({ status: 'COMPLETED' }), day(1)),
    ).toBe('COMPLETED');
  });
});

describe('evaluateRegistration', () => {
  it('accepts a verified participant inside the window', () => {
    // #given the registration window is open
    // #when a verified participant registers
    // #then the registration is eligible with no issues
    expect(evaluateRegistration(registrationInput())).toEqual({
      eligible: true,
      issues: [],
    });
  });

  it('refuses an unverified email when the programme requires verification', () => {
    // #given email verification is required
    // #when an unverified participant registers
    // #then the refusal names the field and code
    const result = evaluateRegistration(
      registrationInput({ participant: { id: 'u', emailVerified: false, bannedAt: null } }),
    );
    expect(result.eligible).toBe(false);
    expect(result.issues[0]).toMatchObject({ code: 'EMAIL_NOT_VERIFIED', field: 'email' });
  });

  it('refuses a banned participant before any other gate', () => {
    // #given the account is banned
    // #when registration is evaluated
    // #then the ban is reported
    expect(
      codes(
        evaluateRegistration(
          registrationInput({ participant: { id: 'u', emailVerified: true, bannedAt: day(1) } }),
        ),
      ),
    ).toContain('PARTICIPANT_BANNED');
  });

  it('refuses registration after it closes', () => {
    // #given the clock is past registration close
    // #when registration is evaluated
    // #then registration is closed
    expect(
      codes(evaluateRegistration(registrationInput({ now: day(15) }))),
    ).toContain('REGISTRATION_CLOSED');
  });

  it('refuses a previously rejected registration', () => {
    // #given the existing registration was rejected
    // #when the participant tries again
    // #then the rejection is explicit
    expect(
      codes(
        evaluateRegistration(
          registrationInput({ existingRegistration: { status: 'REJECTED' } }),
        ),
      ),
    ).toContain('REGISTRATION_REJECTED');
  });
});

describe('evaluateEntry', () => {
  it('accepts a published idea inside the submission window', () => {
    // #given an eligible participant and a published idea
    // #when an existing idea is entered
    // #then the entry is allowed
    expect(evaluateEntry(entryInput())).toEqual({ eligible: true, issues: [] });
  });

  it('enforces NEW_IDEAS_ONLY and EXISTING_IDEAS_ONLY', () => {
    // #given each entry mode
    // #when the source does not match
    // #then the source is refused with a specific code
    expect(
      codes(
        evaluateEntry(
          entryInput({
            programme: { ...entryInput().programme, entryMode: 'NEW_IDEAS_ONLY' },
          }),
        ),
      ),
    ).toContain('EXISTING_IDEAS_NOT_ACCEPTED');
    expect(
      codes(
        evaluateEntry(
          entryInput({
            programme: { ...entryInput().programme, entryMode: 'EXISTING_IDEAS_ONLY' },
            entry: { source: 'NEW_IDEA', category: 'climate' },
          }),
        ),
      ),
    ).toContain('NEW_IDEAS_NOT_ACCEPTED');
  });

  it('refuses an idea owned by someone else', () => {
    // #given the idea belongs to another account
    // #when it is entered
    // #then ownership is enforced
    expect(
      codes(evaluateEntry(entryInput({ idea: idea({ ownerId: 'other' }) }))),
    ).toContain('IDEA_NOT_OWNED');
  });

  it('refuses a draft or archived idea', () => {
    // #given the idea has not left draft or is archived
    // #when it is entered
    // #then it cannot be judged
    expect(codes(evaluateEntry(entryInput({ idea: idea({ status: 'DRAFT' }) })))).toContain(
      'IDEA_NOT_PUBLISHED',
    );
    expect(
      codes(evaluateEntry(entryInput({ idea: idea({ status: 'ARCHIVED' }) }))),
    ).toContain('IDEA_ARCHIVED');
  });

  it('refuses an idea below the published quality threshold', () => {
    // #given a threshold of 0.7 and an idea at 0.5
    // #when it is entered
    // #then the message discloses the threshold
    const result = evaluateEntry(
      entryInput({
        programme: { ...entryInput().programme, minQualityScore: 0.7 },
        idea: idea({ qualityScore: 0.5 }),
      }),
    );
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'IDEA_BELOW_QUALITY_THRESHOLD',
          message: expect.stringContaining('70%'),
        }),
      ]),
    );
  });

  it('refuses a category outside the programme list', () => {
    // #given a programme with one allowed category
    // #when the entry uses another
    // #then the category is refused
    expect(
      codes(
        evaluateEntry(
          entryInput({
            programme: {
              ...entryInput().programme,
              allowedCategories: ['health'],
            },
          }),
        ),
      ),
    ).toContain('CATEGORY_NOT_ALLOWED');
  });

  it('enforces the single-entry limit and the multiple-entry limit', () => {
    // #given one active entry
    // #when another is added
    // #then a single-entry programme refuses it
    expect(
      codes(evaluateEntry(entryInput({ activeEntryCount: 1 }))),
    ).toContain('ENTRY_LIMIT_REACHED');

    // #given a multiple-entry programme with a limit of three
    // #when two are active
    // #then a third is allowed
    const multiple = entryInput({
      programme: {
        ...entryInput().programme,
        allowMultipleEntries: true,
        maxEntriesPerParticipant: 3,
      },
      activeEntryCount: 2,
    });
    expect(evaluateEntry(multiple).eligible).toBe(true);
  });

  it('allows a late entry during judging only when the programme opted in', () => {
    // #given a late-entry programme now in judging
    // #when the deadline has passed but judging has not ended
    // #then the entry is allowed
    const late = entryInput({
      now: day(25),
      programme: {
        ...entryInput().programme,
        status: 'JUDGING',
        lateEntriesAllowed: true,
      },
    });
    expect(evaluateEntry(late).eligible).toBe(true);

    // #given the same programme after judging ends
    // #when a late entry is attempted
    // #then the deadline is final
    expect(
      codes(evaluateEntry({ ...late, now: day(31) })),
    ).toContain('SUBMISSION_DEADLINE_PASSED');
  });
});

describe('evaluateSubmission', () => {
  it('accepts a complete draft inside the window', () => {
    // #given a draft with a title and category
    // #when it is submitted
    // #then no issues are reported
    expect(evaluateSubmission(submissionInput())).toEqual({
      eligible: true,
      issues: [],
    });
  });

  it('does not allow an already submitted entry to be submitted again', () => {
    // #given a submitted entry
    // #when submission is evaluated
    // #then the snapshot is protected
    expect(
      codes(
        evaluateSubmission(
          submissionInput({ entry: { ...submissionInput().entry, status: 'SUBMITTED' } }),
        ),
      ),
    ).toContain('ENTRY_NOT_EDITABLE');
  });

  it('refuses submission before it opens and after it closes', () => {
    // #given the submission window
    // #when the clock is outside it
    // #then both boundaries are enforced
    expect(
      codes(evaluateSubmission(submissionInput({ now: day(1) }))),
    ).toContain('SUBMISSIONS_NOT_OPEN');
    expect(
      codes(evaluateSubmission(submissionInput({ now: day(21) }))),
    ).toContain('SUBMISSION_DEADLINE_PASSED');
  });

  it('requires every declared field and custom question', () => {
    // #given required fields and a required custom question
    // #when the answers are missing
    // #then each missing field is named
    const result = evaluateSubmission(
      submissionInput({
        programme: {
          ...submissionInput().programme,
          requiredFields: ['summary', 'demoUrl'],
          customQuestions: [
            { id: 'traction', required: true, label: 'Traction' },
            { id: 'optional', required: false },
          ],
        },
        entry: {
          ...submissionInput().entry,
          content: { summary: 'A cool roof coating', demoUrl: '   ' },
        },
      }),
    );
    expect(codes(result)).toEqual([
      'REQUIRED_FIELD_MISSING',
      'REQUIRED_FIELD_MISSING',
    ]);
    expect(result.issues.map((issue) => issue.field)).toEqual([
      'demoUrl',
      'traction',
    ]);
  });

  it('enforces the attachment cap and team bounds', () => {
    // #given a programme with one attachment and a team of 2..3
    // #when the entry has two attachments and a team of four
    // #then both refusals are reported
    const result = evaluateSubmission(
      submissionInput({
        programme: {
          ...submissionInput().programme,
          allowTeams: true,
          teamMinSize: 2,
          teamMaxSize: 3,
          maxAttachments: 1,
        },
        attachmentsCount: 2,
        teamSize: 4,
      }),
    );
    expect(codes(result)).toEqual(
      expect.arrayContaining(['TOO_MANY_ATTACHMENTS', 'TEAM_TOO_LARGE']),
    );
  });
});
