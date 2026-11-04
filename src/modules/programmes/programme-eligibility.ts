/**
 * Pure programme eligibility rules (FR-1201/1202/1210).
 *
 * Every gate that decides whether a person can register, enter or submit lives
 * here so it can be unit-tested without Nest or Prisma. Services pass the
 * authoritative database facts in; this module never reads a clock, a request or
 * a browser value. A refusal always carries a machine-readable code and a human
 * sentence, so the API never answers with a bare boolean.
 */

export const PROGRAMME_STATUSES = [
  'DRAFT',
  'SCHEDULED',
  'REGISTRATION_OPEN',
  'SUBMISSION_OPEN',
  'JUDGING',
  'RESULTS_REVIEW',
  'COMPLETED',
  'ARCHIVED',
] as const;
export type ProgrammeStatusValue = (typeof PROGRAMME_STATUSES)[number];

export const PROGRAMME_ENTRY_MODES = [
  'NEW_IDEAS_ONLY',
  'EXISTING_IDEAS_ONLY',
  'NEW_OR_EXISTING',
] as const;
export type ProgrammeEntryModeValue = (typeof PROGRAMME_ENTRY_MODES)[number];

export const PROGRAMME_ENTRY_SOURCES = ['NEW_IDEA', 'EXISTING_IDEA'] as const;
export type ProgrammeEntrySourceValue =
  (typeof PROGRAMME_ENTRY_SOURCES)[number];

export type ProgrammePhase =
  | 'SCHEDULED'
  | 'REGISTRATION_OPEN'
  | 'SUBMISSION_OPEN'
  | 'JUDGING'
  | 'RESULTS_REVIEW'
  | 'COMPLETED'
  | 'ARCHIVED';

export type EligibilityIssue = {
  code: string;
  message: string;
  field?: string;
};

export type EligibilityResult = {
  eligible: boolean;
  issues: EligibilityIssue[];
};

export type ProgrammeWindow = {
  status: ProgrammeStatusValue;
  registrationOpensAt: Date;
  registrationClosesAt: Date;
  submissionOpensAt: Date;
  submissionClosesAt: Date;
  judgingStartsAt: Date;
  judgingEndsAt: Date;
  resultsAt: Date;
  lateEntriesAllowed: boolean;
};

const issue = (
  code: string,
  message: string,
  field?: string,
): EligibilityIssue => (field ? { code, message, field } : { code, message });

function result(issues: EligibilityIssue[]): EligibilityResult {
  return { eligible: issues.length === 0, issues };
}

/**
 * The phase is derived from the stored timeline, not from the status column
 * alone. `status` remains the organiser's declared intent; a programme whose
 * clock has passed a boundary cannot pretend it has not. ARCHIVED and COMPLETED
 * always win over the clock.
 */
export function deriveProgrammePhase(
  window: ProgrammeWindow,
  now: Date,
): ProgrammePhase {
  if (window.status === 'ARCHIVED') return 'ARCHIVED';
  if (window.status === 'COMPLETED') return 'COMPLETED';
  if (window.status === 'DRAFT' || window.status === 'SCHEDULED') {
    return 'SCHEDULED';
  }
  if (window.status === 'RESULTS_REVIEW') return 'RESULTS_REVIEW';
  if (window.status === 'JUDGING') return 'JUDGING';

  if (now < window.registrationOpensAt) return 'SCHEDULED';
  // Submission can open while registration is still open. The action a visitor
  // can take is "submit", so the phase must prefer the submission window; the
  // registration window remains open in the eligibility rules independently.
  if (now >= window.submissionOpensAt && now <= window.submissionClosesAt) {
    return 'SUBMISSION_OPEN';
  }
  if (now <= window.registrationClosesAt) return 'REGISTRATION_OPEN';
  if (now < window.submissionOpensAt) return 'SCHEDULED';
  if (now < window.judgingEndsAt) return 'JUDGING';
  return 'RESULTS_REVIEW';
}

export type RegistrationInput = {
  now: Date;
  programme: ProgrammeWindow & {
    registrationRequired: boolean;
    requireEmailVerified: boolean;
  };
  participant: {
    id: string;
    emailVerified: boolean;
    bannedAt: Date | null;
  };
  existingRegistration?: {
    status: 'PENDING' | 'ELIGIBLE' | 'REJECTED' | 'WITHDRAWN';
  } | null;
};

/**
 * Registration is free and never depends on a payment (FR-1210), a supporter
 * count or a sponsor. The only reasons to refuse are identity, moderation and
 * the published window.
 */
export function evaluateRegistration(
  input: RegistrationInput,
): EligibilityResult {
  const { now, programme, participant } = input;
  const issues: EligibilityIssue[] = [];

  if (participant.bannedAt) {
    issues.push(
      issue(
        'PARTICIPANT_BANNED',
        'This account cannot take part in a programme.',
      ),
    );
  }

  if (programme.requireEmailVerified && !participant.emailVerified) {
    issues.push(
      issue(
        'EMAIL_NOT_VERIFIED',
        'Verify your email address before registering for this programme.',
        'email',
      ),
    );
  }

  if (programme.status === 'ARCHIVED' || programme.status === 'COMPLETED') {
    issues.push(
      issue('PROGRAMME_CLOSED', 'This programme is no longer accepting participants.'),
    );
    return result(issues);
  }

  if (programme.status === 'DRAFT' || programme.status === 'SCHEDULED') {
    issues.push(
      issue(
        'REGISTRATION_NOT_OPEN',
        'Registration for this programme has not opened yet.',
      ),
    );
    return result(issues);
  }

  if (programme.status !== 'REGISTRATION_OPEN' && programme.status !== 'SUBMISSION_OPEN') {
    issues.push(
      issue(
        'REGISTRATION_CLOSED',
        'Registration for this programme has closed.',
      ),
    );
    return result(issues);
  }

  if (now < programme.registrationOpensAt) {
    issues.push(
      issue(
        'REGISTRATION_NOT_OPEN',
        'Registration for this programme has not opened yet.',
      ),
    );
  }
  if (now > programme.registrationClosesAt) {
    issues.push(
      issue('REGISTRATION_CLOSED', 'Registration for this programme has closed.'),
    );
  }

  if (input.existingRegistration?.status === 'REJECTED') {
    issues.push(
      issue(
        'REGISTRATION_REJECTED',
        'This registration was rejected. Contact the organiser if that is wrong.',
      ),
    );
  }

  return result(issues);
}

export type EntryInput = {
  now: Date;
  programme: ProgrammeWindow & {
    registrationRequired: boolean;
    requireEmailVerified: boolean;
    entryMode: ProgrammeEntryModeValue;
    allowedCategories: readonly string[];
    allowMultipleEntries: boolean;
    maxEntriesPerParticipant: number;
    minQualityScore: number | null;
  };
  participant: { id: string; emailVerified: boolean; bannedAt: Date | null };
  registration: { status: 'PENDING' | 'ELIGIBLE' | 'REJECTED' | 'WITHDRAWN' } | null;
  activeEntryCount: number;
  entry: {
    source: ProgrammeEntrySourceValue;
    category: string;
  };
  idea: {
    id: string;
    ownerId: string;
    status: 'DRAFT' | 'VALIDATING' | 'THRESHOLD_MET' | 'CONVERTED' | 'ARCHIVED';
    qualityScore: number | null;
    category: string | null;
  };
};

/**
 * Entering an ideathon is free (FR-1210). An existing idea must belong to the
 * participant and have left draft; a quality threshold is a published rule, so
 * an idea below it is refused with the threshold in the message rather than a
 * silent exclusion from judging.
 */
export function evaluateEntry(input: EntryInput): EligibilityResult {
  const { now, programme, participant, entry, idea } = input;
  const issues: EligibilityIssue[] = [];

  if (participant.bannedAt) {
    issues.push(
      issue('PARTICIPANT_BANNED', 'This account cannot enter a programme.'),
    );
  }
  if (programme.requireEmailVerified && !participant.emailVerified) {
    issues.push(
      issue(
        'EMAIL_NOT_VERIFIED',
        'Verify your email address before entering this programme.',
        'email',
      ),
    );
  }

  if (programme.status === 'ARCHIVED' || programme.status === 'COMPLETED') {
    issues.push(issue('PROGRAMME_CLOSED', 'This programme is closed.'));
    return result(issues);
  }

  const lateWindowOpen =
    programme.lateEntriesAllowed &&
    programme.status === 'JUDGING' &&
    now < programme.judgingEndsAt;

  if (programme.status !== 'SUBMISSION_OPEN' && !lateWindowOpen) {
    issues.push(
      issue(
        'SUBMISSIONS_CLOSED',
        'Submissions for this programme are not open.',
      ),
    );
  }
  if (now < programme.submissionOpensAt) {
    issues.push(
      issue('SUBMISSIONS_NOT_OPEN', 'Submissions have not opened yet.'),
    );
  }
  if (now > programme.submissionClosesAt && !programme.lateEntriesAllowed) {
    issues.push(
      issue('SUBMISSION_DEADLINE_PASSED', 'The submission deadline has passed.'),
    );
  }
  if (
    now > programme.submissionClosesAt &&
    programme.lateEntriesAllowed &&
    now >= programme.judgingEndsAt
  ) {
    issues.push(
      issue(
        'SUBMISSION_DEADLINE_PASSED',
        'Late submission is no longer possible because judging has finished.',
      ),
    );
  }

  if (programme.registrationRequired) {
    if (!input.registration || input.registration.status === 'WITHDRAWN') {
      issues.push(
        issue(
          'REGISTRATION_REQUIRED',
          'Register for this programme before adding an entry.',
        ),
      );
    } else if (input.registration.status === 'REJECTED') {
      issues.push(
        issue('REGISTRATION_REJECTED', 'This registration was rejected.'),
      );
    } else if (input.registration.status === 'PENDING') {
      issues.push(
        issue(
          'REGISTRATION_PENDING',
          'Your registration is still being reviewed.',
        ),
      );
    }
  }

  if (entry.source === 'NEW_IDEA' && programme.entryMode === 'EXISTING_IDEAS_ONLY') {
    issues.push(
      issue(
        'NEW_IDEAS_NOT_ACCEPTED',
        'This programme only accepts ideas that already exist.',
        'source',
      ),
    );
  }
  if (entry.source === 'EXISTING_IDEA' && programme.entryMode === 'NEW_IDEAS_ONLY') {
    issues.push(
      issue(
        'EXISTING_IDEAS_NOT_ACCEPTED',
        'This programme only accepts ideas created for the programme.',
        'source',
      ),
    );
  }

  if (
    programme.allowedCategories.length > 0 &&
    !programme.allowedCategories.includes(entry.category)
  ) {
    issues.push(
      issue(
        'CATEGORY_NOT_ALLOWED',
        'Choose one of the programme categories.',
        'category',
      ),
    );
  }

  if (idea.ownerId !== participant.id) {
    issues.push(
      issue(
        'IDEA_NOT_OWNED',
        'You can only enter an idea that belongs to your account.',
        'ideaId',
      ),
    );
  }
  if (idea.status === 'DRAFT') {
    issues.push(
      issue(
        'IDEA_NOT_PUBLISHED',
        'Publish the idea before entering it into a programme.',
        'ideaId',
      ),
    );
  }
  if (idea.status === 'ARCHIVED') {
    issues.push(
      issue('IDEA_ARCHIVED', 'An archived idea cannot be entered.', 'ideaId'),
    );
  }
  if (
    programme.minQualityScore !== null &&
    (idea.qualityScore === null || idea.qualityScore < programme.minQualityScore)
  ) {
    issues.push(
      issue(
        'IDEA_BELOW_QUALITY_THRESHOLD',
        `This programme requires a quality score of at least ${Math.round(
          programme.minQualityScore * 100,
        )}%. Improve the idea and try again.`,
        'ideaId',
      ),
    );
  }

  const limit = programme.allowMultipleEntries
    ? Math.max(1, programme.maxEntriesPerParticipant)
    : 1;
  if (input.activeEntryCount >= limit) {
    issues.push(
      issue(
        'ENTRY_LIMIT_REACHED',
        limit === 1
          ? 'This programme accepts one entry per participant.'
          : `This programme accepts at most ${limit} entries per participant.`,
      ),
    );
  }

  return result(issues);
}

export type SubmissionInput = {
  now: Date;
  programme: ProgrammeWindow & {
    allowTeams: boolean;
    teamMinSize: number;
    teamMaxSize: number;
    requiredFields: readonly string[];
    customQuestions: readonly { id: string; required?: boolean; label?: string }[];
    maxAttachments: number;
  };
  entry: {
    status:
      | 'DRAFT'
      | 'SUBMITTED'
      | 'UNDER_REVIEW'
      | 'CHANGES_REQUESTED'
      | 'SHORTLISTED'
      | 'ACCEPTED'
      | 'REJECTED'
      | 'DISQUALIFIED'
      | 'WITHDRAWN';
    title: string;
    category: string;
    content: Record<string, unknown>;
    submittedAt: Date | null;
  };
  attachmentsCount: number;
  teamSize: number;
};

const EDITABLE_STATUSES = new Set(['DRAFT', 'CHANGES_REQUESTED']);

/**
 * Submission validates the entry's own content. It does not re-check
 * registration, ownership or the entry mode: the service composes both results
 * so a caller can never bypass one gate by satisfying another.
 */
export function evaluateSubmission(input: SubmissionInput): EligibilityResult {
  const { now, programme, entry } = input;
  const issues: EligibilityIssue[] = [];

  if (!EDITABLE_STATUSES.has(entry.status)) {
    issues.push(
      issue(
        'ENTRY_NOT_EDITABLE',
        entry.status === 'SUBMITTED'
          ? 'This entry has already been submitted.'
          : 'This entry can no longer be edited.',
      ),
    );
    return result(issues);
  }

  if (programme.status !== 'SUBMISSION_OPEN') {
    const lateWindowOpen =
      programme.lateEntriesAllowed &&
      programme.status === 'JUDGING' &&
      now < programme.judgingEndsAt;
    if (!lateWindowOpen) {
      issues.push(
        issue('SUBMISSIONS_CLOSED', 'Submissions for this programme are not open.'),
      );
    }
  }
  if (now < programme.submissionOpensAt) {
    issues.push(
      issue('SUBMISSIONS_NOT_OPEN', 'Submissions have not opened yet.'),
    );
  }
  if (now > programme.submissionClosesAt && !programme.lateEntriesAllowed) {
    issues.push(
      issue('SUBMISSION_DEADLINE_PASSED', 'The submission deadline has passed.'),
    );
  }

  if (!entry.title.trim()) {
    issues.push(issue('TITLE_REQUIRED', 'Add a title for this entry.', 'title'));
  }
  if (!entry.category.trim()) {
    issues.push(
      issue('CATEGORY_REQUIRED', 'Choose a category for this entry.', 'category'),
    );
  }

  for (const field of programme.requiredFields) {
    const value = entry.content[field];
    const missing =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim().length === 0) ||
      (Array.isArray(value) && value.length === 0);
    if (missing) {
      issues.push(
        issue(
          'REQUIRED_FIELD_MISSING',
          `The programme requires "${field}".`,
          field,
        ),
      );
    }
  }

  for (const question of programme.customQuestions) {
    if (!question.required) continue;
    const value = entry.content[question.id];
    const missing =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim().length === 0) ||
      (Array.isArray(value) && value.length === 0);
    if (missing) {
      issues.push(
        issue(
          'REQUIRED_FIELD_MISSING',
          `Answer "${question.label ?? question.id}" before submitting.`,
          question.id,
        ),
      );
    }
  }

  if (
    programme.maxAttachments > 0 &&
    input.attachmentsCount > programme.maxAttachments
  ) {
    issues.push(
      issue(
        'TOO_MANY_ATTACHMENTS',
        `At most ${programme.maxAttachments} attachments are allowed.`,
        'attachments',
      ),
    );
  }

  if (programme.allowTeams) {
    if (input.teamSize > 0 && input.teamSize < programme.teamMinSize) {
      issues.push(
        issue(
          'TEAM_TOO_SMALL',
          `A team needs at least ${programme.teamMinSize} member(s).`,
          'team',
        ),
      );
    }
    if (input.teamSize > programme.teamMaxSize) {
      issues.push(
        issue(
          'TEAM_TOO_LARGE',
          `A team can have at most ${programme.teamMaxSize} member(s).`,
          'team',
        ),
      );
    }
  }

  return result(issues);
}
