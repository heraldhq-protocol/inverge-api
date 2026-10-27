import type {
  AmlStatus,
  KycStatus,
  RiskOutcome,
  VerificationCase,
  VerificationStatus,
} from '../../generated/prisma/client';
import type {
  CaseFacts,
  VerificationFacts,
} from './verification-policy';
import {
  type VerificationState,
  riskFromAml,
  type RiskState,
} from './verification-status';

// Pure projections from stored rows to policy facts. Legacy rows written before the
// case model existed are treated as a single completed case so an already-verified
// account is not asked to verify again. Nothing here trusts a browser or a redirect:
// the only sources are persisted provider-derived statuses.

type CaseRow = Pick<
  VerificationCase,
  'status' | 'riskOutcome' | 'features' | 'providerStatus'
>;

export function caseFacts(row: CaseRow | null | undefined): CaseFacts | null {
  if (!row) return null;
  return {
    features: row.features,
    providerStatus: row.providerStatus,
    risk: row.riskOutcome as RiskState,
    state: row.status as VerificationState,
  };
}

export function legacyIndividualFacts(user: {
  kycStatus: KycStatus;
  amlStatus: AmlStatus;
}): CaseFacts | null {
  if (user.kycStatus === 'NOT_REQUIRED') return null;
  const state: VerificationState =
    user.kycStatus === 'VERIFIED'
      ? 'APPROVED'
      : user.kycStatus === 'REJECTED'
        ? 'DECLINED'
        : 'AWAITING_USER';
  return {
    features: [
      'ID_VERIFICATION',
      ...(user.amlStatus !== 'NOT_SCREENED' ? ['AML'] : []),
    ],
    providerStatus: legacyProviderLabel(state),
    risk: legacyAmlRisk(user.amlStatus),
    state,
  };
}

export function legacyBusinessFacts(business: {
  kybStatus: KycStatus;
  amlStatus: AmlStatus;
}): CaseFacts {
  const state: VerificationState =
    business.kybStatus === 'VERIFIED'
      ? 'APPROVED'
      : business.kybStatus === 'REJECTED'
        ? 'DECLINED'
        : business.kybStatus === 'PENDING'
          ? 'AWAITING_USER'
          : 'NOT_STARTED';
  return {
    features: ['KYB_REGISTRY', 'KYB_DOCUMENTS', 'KYB_KEY_PEOPLE', 'AML'],
    providerStatus: legacyProviderLabel(state),
    risk: legacyAmlRisk(business.amlStatus),
    state,
  };
}

function legacyAmlRisk(status: AmlStatus): RiskState {
  if (status === 'CLEAR') return 'CLEAR';
  if (status === 'IN_REVIEW') return 'REVIEW';
  if (status === 'FLAGGED') return 'FLAGGED';
  return 'NOT_ASSESSED';
}

function legacyProviderLabel(state: VerificationState): string | null {
  if (state === 'APPROVED') return 'Approved';
  if (state === 'DECLINED') return 'Declined';
  if (state === 'AWAITING_USER') return 'In Progress';
  return null;
}

export function buildFacts(input: {
  accountType: 'INDIVIDUAL' | 'BUSINESS';
  individualCase: CaseRow | null;
  businessCase: CaseRow | null;
  user: { kycStatus: KycStatus; amlStatus: AmlStatus };
  business: { kybStatus: KycStatus; amlStatus: AmlStatus; id: string } | null;
}): VerificationFacts {
  const individual =
    caseFacts(input.individualCase) ?? legacyIndividualFacts(input.user);
  const business = input.business
    ? {
        ...(caseFacts(input.businessCase) ??
          legacyBusinessFacts(input.business)),
        registered: true,
      }
    : null;
  return {
    accountType: input.accountType,
    business,
    individual,
  };
}

/** The state a status screen should show when two cases disagree. */
export function overallState(facts: VerificationFacts): VerificationState {
  const relevant: CaseFacts[] = [];
  if (facts.individual) relevant.push(facts.individual);
  if (facts.business) relevant.push(facts.business);
  if (relevant.length === 0) return 'NOT_STARTED';

  const order: VerificationState[] = [
    'IN_REVIEW',
    'ACTION_REQUIRED',
    'SUBMITTED',
    'AWAITING_USER',
    'SESSION_CREATED',
    'ERROR',
    'DECLINED',
    'EXPIRED',
    'CANCELLED',
    'NOT_STARTED',
  ];
  for (const state of order) {
    if (relevant.some((entry) => entry.state === state)) return state;
  }
  if (relevant.every((entry) => entry.state === 'APPROVED')) return 'APPROVED';
  return 'ACTION_REQUIRED';
}

export function riskFromDecision(
  aml: 'CLEAR' | 'IN_REVIEW' | 'FLAGGED' | null | undefined,
): RiskOutcome {
  return riskFromAml(aml) as RiskOutcome;
}

export function verificationStatusFromRisk(
  risk: RiskOutcome,
): VerificationStatus | null {
  return null;
}
