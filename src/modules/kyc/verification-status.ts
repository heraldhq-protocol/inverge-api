import type { AmlOutcome } from '../../ports/kyc/kyc-provider.port';

// The one internal verification lifecycle. Provider strings are mapped exactly once,
// here, and never leak into eligibility checks, campaign gates or API contracts.
//
// Didit's enum is case-sensitive and contains spaces ("In Review", "Kyc Expired");
// see https://docs.didit.me/integration/verification-statuses. Anything unrecognised
// maps to ERROR rather than to a permissive state.

export const VERIFICATION_STATES = [
  'NOT_STARTED',
  'SESSION_CREATED',
  'AWAITING_USER',
  'SUBMITTED',
  'IN_REVIEW',
  'APPROVED',
  'DECLINED',
  'ACTION_REQUIRED',
  'EXPIRED',
  'CANCELLED',
  'ERROR',
] as const;

export type VerificationState = (typeof VERIFICATION_STATES)[number];

export const DIDIT_STATUSES = [
  'Not Started',
  'In Progress',
  'Approved',
  'Declined',
  'In Review',
  'Awaiting User',
  'Resubmitted',
  'Expired',
  'Abandoned',
  'Kyc Expired',
] as const;

export type DiditStatus = (typeof DIDIT_STATUSES)[number];

export function isDiditStatus(value: unknown): value is DiditStatus {
  return (
    typeof value === 'string' &&
    (DIDIT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Maps a Didit status onto the internal model. `Abandoned` and `Kyc Expired` are
 * distinct provider outcomes but both end the usability of the current session, so
 * they map to EXPIRED; the exact provider label stays on the case and in the event.
 */
export function mapDiditStatus(
  value: unknown,
): { state: VerificationState; providerStatus: DiditStatus | null } {
  if (!isDiditStatus(value)) {
    return { providerStatus: null, state: 'ERROR' };
  }
  switch (value) {
    case 'Not Started':
      return { providerStatus: value, state: 'SESSION_CREATED' };
    case 'In Progress':
      return { providerStatus: value, state: 'AWAITING_USER' };
    case 'Awaiting User':
      return { providerStatus: value, state: 'AWAITING_USER' };
    case 'Approved':
      return { providerStatus: value, state: 'APPROVED' };
    case 'Declined':
      return { providerStatus: value, state: 'DECLINED' };
    case 'In Review':
      return { providerStatus: value, state: 'IN_REVIEW' };
    case 'Resubmitted':
      return { providerStatus: value, state: 'ACTION_REQUIRED' };
    case 'Expired':
    case 'Abandoned':
    case 'Kyc Expired':
      return { providerStatus: value, state: 'EXPIRED' };
  }
}

/** States in which no further provider transition is expected. */
export function isTerminalState(state: VerificationState): boolean {
  return state === 'APPROVED' || state === 'DECLINED' || state === 'EXPIRED';
}

/** States that still block a new case: the user should resume instead. */
export function isActiveState(state: VerificationState): boolean {
  return (
    state === 'SESSION_CREATED' ||
    state === 'AWAITING_USER' ||
    state === 'SUBMITTED' ||
    state === 'IN_REVIEW' ||
    state === 'ACTION_REQUIRED'
  );
}

/** A terminal state from which policy permits a fresh session. */
export function canStartNewSession(state: VerificationState): boolean {
  return (
    state === 'DECLINED' ||
    state === 'EXPIRED' ||
    state === 'CANCELLED' ||
    state === 'ERROR'
  );
}

/** Provider statuses that may move a case backwards without being authoritative. */
export function isOutOfOrder(
  current: VerificationState,
  next: VerificationState,
): boolean {
  if (current === next) return false;
  if (current === 'APPROVED') return next !== 'EXPIRED';
  if (current === 'EXPIRED') return next !== 'ACTION_REQUIRED';
  if (current === 'DECLINED') return next === 'SESSION_CREATED' || next === 'AWAITING_USER';
  return false;
}

export type TransitionVerdict = 'apply' | 'stale' | 'regression';

/**
 * Decides whether a provider transition may overwrite the stored case. Two independent
 * guards: an event older than the last applied sync is stale (webhooks arrive out of
 * order), and a terminal state is not regressed by a duplicate/older delivery. Risk is
 * updated separately, so a stale status never discards newer screening evidence.
 */
export function transitionVerdict(input: {
  current: VerificationState;
  next: VerificationState;
  lastSyncedAt: Date | null;
  occurredAt: Date;
  /** Tolerated clock skew between provider event time and our sync time. */
  skewMs?: number;
}): TransitionVerdict {
  const skew = input.skewMs ?? 5_000;
  if (
    input.lastSyncedAt !== null &&
    input.occurredAt.getTime() < input.lastSyncedAt.getTime() - skew
  ) {
    return 'stale';
  }
  if (isOutOfOrder(input.current, input.next)) return 'regression';
  return 'apply';
}

export type RiskState = 'NOT_ASSESSED' | 'CLEAR' | 'REVIEW' | 'FLAGGED';

/**
 * Normalises the provider's AML outcome. No AML step means NOT_ASSESSED, which is
 * not a clearance. An ambiguous match is REVIEW, never an automatic finding.
 */
export function riskFromAml(aml: AmlOutcome | null | undefined): RiskState {
  if (!aml) return 'NOT_ASSESSED';
  if (aml === 'CLEAR') return 'CLEAR';
  if (aml === 'IN_REVIEW') return 'REVIEW';
  return 'FLAGGED';
}

export function riskRequiresHumanReview(risk: RiskState): boolean {
  return risk === 'REVIEW' || risk === 'FLAGGED';
}

export function riskBlocksFunds(risk: RiskState): boolean {
  return risk === 'REVIEW' || risk === 'FLAGGED';
}

/** A provider decision is usable for money only when it is approved and risk-clear. */
export function isFundsCleared(
  state: VerificationState,
  risk: RiskState,
): boolean {
  return state === 'APPROVED' && risk === 'CLEAR';
}

/** Maps an internal state onto the legacy KycStatus vocabulary used by older surfaces. */
export function legacyOutcomeForState(
  state: VerificationState,
): 'VERIFIED' | 'REJECTED' | 'IN_REVIEW' | 'PENDING' {
  if (state === 'APPROVED') return 'VERIFIED';
  if (state === 'DECLINED') return 'REJECTED';
  if (state === 'IN_REVIEW') return 'IN_REVIEW';
  return 'PENDING';
}

/** Identity is verified by an approved individual case even before AML completes. */
export function isIdentityCleared(state: VerificationState): boolean {
  return state === 'APPROVED';
}

/** How many attempts a case has had in a rolling window is policy, not storage. */
export function attemptsExceeded(
  attemptsInWindow: number,
  maxAttempts: number,
): boolean {
  return attemptsInWindow >= maxAttempts;
}

export function stateLabel(state: VerificationState): string {
  switch (state) {
    case 'NOT_STARTED':
      return 'Not started';
    case 'SESSION_CREATED':
      return 'Ready to begin';
    case 'AWAITING_USER':
      return 'Verification in progress';
    case 'SUBMITTED':
      return 'Submitted for review';
    case 'IN_REVIEW':
      return 'Under review';
    case 'APPROVED':
      return 'Approved';
    case 'DECLINED':
      return 'Unsuccessful';
    case 'ACTION_REQUIRED':
      return 'Additional information required';
    case 'EXPIRED':
      return 'Session expired';
    case 'CANCELLED':
      return 'Cancelled';
    case 'ERROR':
      return 'Temporary verification issue';
  }
}
