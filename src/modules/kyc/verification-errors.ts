import type {
  VerificationEvaluation,
  VerificationFacts,
} from './verification-policy';
import type { VerificationState } from './verification-status';

// Stable, machine-readable verification failures. The web maps these to copy; the API
// never invents a new string inline, so a client can switch on `code` without matching
// prose. They are additive: existing values do not change meaning.

export const VERIFICATION_ERROR_CODES = [
  'VERIFICATION_REQUIRED',
  'VERIFICATION_IN_PROGRESS',
  'VERIFICATION_IN_REVIEW',
  'VERIFICATION_ACTION_REQUIRED',
  'VERIFICATION_DECLINED',
  'VERIFICATION_EXPIRED',
  'VERIFICATION_PROVIDER_ERROR',
  'VERIFICATION_COMPLIANCE_HOLD',
  'VERIFICATION_BUSINESS_PROFILE_REQUIRED',
  'VERIFICATION_ACCOUNT_TYPE_MISMATCH',
  'VERIFICATION_ATTEMPTS_EXCEEDED',
  'VERIFICATION_UNAVAILABLE',
  'CONTRIBUTION_THRESHOLD_EXCEEDED',
  'CONTRIBUTION_CAMPAIGN_NOT_FUNDABLE',
] as const;

export type VerificationErrorCode = (typeof VERIFICATION_ERROR_CODES)[number];

export interface VerificationFailure {
  code: VerificationErrorCode;
  message: string;
  blockers: string[];
}

const ACTIVE_STATES: readonly VerificationState[] = [
  'SESSION_CREATED',
  'AWAITING_USER',
  'SUBMITTED',
  'IN_REVIEW',
  'ACTION_REQUIRED',
];

function anyState(
  facts: VerificationFacts,
  predicate: (state: VerificationState) => boolean,
): boolean {
  return [facts.individual, facts.business].some(
    (entry) => entry !== null && predicate(entry.state),
  );
}

/**
 * Chooses the single code a gate should return. Precedence is deliberate: a compliance
 * hold outranks an in-flight session, and a provider error outranks a retry so support
 * sees the actionable cause.
 */
export function verificationFailure(
  facts: VerificationFacts,
  evaluation: VerificationEvaluation,
  options: { complianceHold: boolean },
): VerificationFailure | null {
  if (evaluation.eligible && !options.complianceHold) return null;

  const blockers = [
    ...evaluation.blockers,
    ...(options.complianceHold ? ['A compliance review is open on this account'] : []),
  ];

  // The account type decides which missing prerequisite is actionable.
  if (facts.accountType === 'BUSINESS' && !facts.business?.registered) {
    return {
      code: 'VERIFICATION_BUSINESS_PROFILE_REQUIRED',
      message: 'Add your registered business details before continuing',
      blockers,
    };
  }

  if (options.complianceHold) {
    return {
      code: 'VERIFICATION_COMPLIANCE_HOLD',
      message: 'This account is under compliance review',
      blockers,
    };
  }
  if (anyState(facts, (state) => state === 'ERROR')) {
    return {
      code: 'VERIFICATION_PROVIDER_ERROR',
      message: 'Verification is temporarily unavailable. Try again shortly.',
      blockers,
    };
  }
  if (anyState(facts, (state) => state === 'IN_REVIEW' || state === 'SUBMITTED')) {
    return {
      code: 'VERIFICATION_IN_REVIEW',
      message: 'Verification is still under review',
      blockers,
    };
  }
  if (anyState(facts, (state) => state === 'ACTION_REQUIRED')) {
    return {
      code: 'VERIFICATION_ACTION_REQUIRED',
      message: 'Additional information is required to complete verification',
      blockers,
    };
  }
  if (anyState(facts, (state) => state === 'DECLINED')) {
    return {
      code: 'VERIFICATION_DECLINED',
      message: 'Verification was not successful',
      blockers,
    };
  }
  if (anyState(facts, (state) => state === 'EXPIRED')) {
    return {
      code: 'VERIFICATION_EXPIRED',
      message: 'The verification session expired. Start a new one.',
      blockers,
    };
  }
  if (anyState(facts, (state) => ACTIVE_STATES.includes(state))) {
    return {
      code: 'VERIFICATION_IN_PROGRESS',
      message: 'Verification has not been completed yet',
      blockers,
    };
  }
  return {
    code: 'VERIFICATION_REQUIRED',
    message: 'Identity and AML verification are required',
    blockers,
  };
}

export function isVerificationErrorCode(
  value: unknown,
): value is VerificationErrorCode {
  return (
    typeof value === 'string' &&
    (VERIFICATION_ERROR_CODES as readonly string[]).includes(value)
  );
}
