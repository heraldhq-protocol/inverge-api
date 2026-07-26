import {
  AmlOutcome,
  KycOutcome,
  KycPurpose,
  purposeRequiresAml,
} from '../../ports/kyc/kyc-provider.port';

// Pure eligibility logic shared by the service, guards and tests. Two distinct bars:
//   - identity-verified: KYC passed. Enough for the idea-validation VERIFIED pre-pledge tier.
//   - funds-eligible: KYC passed AND AML is CLEAR. Required before handling money — campaign
//     creators (FR-103) and backers over the threshold (FR-104).

export interface UserVerification {
  kycStatus: string; // KycStatus
  amlStatus: string; // AmlStatus
}

export function isIdentityVerified(u: UserVerification): boolean {
  return u.kycStatus === 'VERIFIED';
}

export function isFundsEligible(u: UserVerification): boolean {
  return u.kycStatus === 'VERIFIED' && u.amlStatus === 'CLEAR';
}

// The single KYC blocker line (null ⇒ identity is verified).
function kycReason(u: UserVerification): string | null {
  if (u.kycStatus === 'VERIFIED') return null;
  return u.kycStatus === 'REJECTED'
    ? 'Identity verification was declined'
    : 'Identity verification (KYC) is required';
}

// Human-readable list of what still blocks funds-eligibility (empty ⇒ eligible).
export function fundsEligibilityReasons(u: UserVerification): string[] {
  const reasons: string[] = [];
  const kyc = kycReason(u);
  if (kyc) reasons.push(kyc);
  if (u.amlStatus === 'FLAGGED') reasons.push('AML screening flagged this account');
  else if (u.amlStatus === 'IN_REVIEW') reasons.push('AML screening is under review');
  else if (u.amlStatus === 'NOT_SCREENED') reasons.push('AML screening is required');
  return reasons;
}

// Whether a given purpose is satisfied for a user.
export function purposeEligible(purpose: KycPurpose, u: UserVerification): boolean {
  return purposeRequiresAml(purpose) ? isFundsEligible(u) : isIdentityVerified(u);
}

export function purposeReasons(purpose: KycPurpose, u: UserVerification): string[] {
  if (purposeRequiresAml(purpose)) return fundsEligibilityReasons(u);
  const kyc = kycReason(u);
  return kyc ? [kyc] : [];
}

// FR-104: a backer may fund without KYC until their cumulative funding would exceed the
// threshold; the pledge that crosses it (and everything after) requires funds-eligibility.
export function backerFundingRequiresKyc(
  cumulativeUsd: number,
  nextAmountUsd: number,
  thresholdUsd: number,
): boolean {
  return cumulativeUsd + nextAmountUsd > thresholdUsd;
}

// ── provider-outcome → persisted enum mappers ────────────────────────────────────────
// KycStatus has no IN_REVIEW state; a borderline identity result stays PENDING until it
// resolves either way. The full provider status is retained in the raw decision + events.
export function kycOutcomeToStatus(o: KycOutcome): 'PENDING' | 'VERIFIED' | 'REJECTED' {
  if (o === 'VERIFIED') return 'VERIFIED';
  if (o === 'REJECTED') return 'REJECTED';
  return 'PENDING'; // PENDING | IN_REVIEW
}

export function amlOutcomeToStatus(
  o: AmlOutcome,
): 'CLEAR' | 'IN_REVIEW' | 'FLAGGED' {
  return o;
}
