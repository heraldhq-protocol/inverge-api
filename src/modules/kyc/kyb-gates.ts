// Pure business (KYB) eligibility logic — the business analogue of kyc-gates.ts. A business is
// funds-eligible (may create AND back campaigns) on KYB VERIFIED + business AML CLEAR, with no
// separate personal KYC for the representative (KYB already verifies directors/UBOs).

export interface BusinessVerification {
  kybStatus: string; // KycStatus vocabulary, reused
  amlStatus: string; // AmlStatus
}

export function isBusinessVerified(b: BusinessVerification): boolean {
  return b.kybStatus === 'VERIFIED';
}

export function isBusinessFundsEligible(b: BusinessVerification): boolean {
  return b.kybStatus === 'VERIFIED' && b.amlStatus === 'CLEAR';
}

// Human-readable blockers (empty ⇒ eligible).
export function businessFundsReasons(b: BusinessVerification): string[] {
  const reasons: string[] = [];
  if (b.kybStatus !== 'VERIFIED') {
    reasons.push(
      b.kybStatus === 'REJECTED'
        ? 'Business verification was declined'
        : 'Business verification (KYB) is required',
    );
  }
  if (b.amlStatus === 'FLAGGED') reasons.push('AML screening flagged this business');
  else if (b.amlStatus === 'IN_REVIEW') reasons.push('AML screening is under review');
  else if (b.amlStatus === 'NOT_SCREENED') reasons.push('AML screening is required');
  return reasons;
}
