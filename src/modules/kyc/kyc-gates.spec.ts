import {
  amlOutcomeToStatus,
  backerFundingRequiresKyc,
  fundsEligibilityReasons,
  isFundsEligible,
  isIdentityVerified,
  kycOutcomeToStatus,
  purposeEligible,
  purposeReasons,
} from './kyc-gates';

const V = (kyc: string, aml = 'NOT_SCREENED') => ({ kycStatus: kyc, amlStatus: aml });

describe('identity vs funds eligibility', () => {
  it('identity-verified needs only KYC VERIFIED', () => {
    expect(isIdentityVerified(V('VERIFIED'))).toBe(true);
    expect(isIdentityVerified(V('PENDING'))).toBe(false);
  });

  it('funds-eligible needs KYC VERIFIED AND AML CLEAR', () => {
    expect(isFundsEligible(V('VERIFIED', 'CLEAR'))).toBe(true);
    expect(isFundsEligible(V('VERIFIED', 'NOT_SCREENED'))).toBe(false);
    expect(isFundsEligible(V('VERIFIED', 'FLAGGED'))).toBe(false);
    expect(isFundsEligible(V('PENDING', 'CLEAR'))).toBe(false);
  });

  it('lists the blocking reasons', () => {
    expect(fundsEligibilityReasons(V('VERIFIED', 'CLEAR'))).toEqual([]);
    expect(fundsEligibilityReasons(V('PENDING', 'NOT_SCREENED'))).toEqual([
      'Identity verification (KYC) is required',
      'AML screening is required',
    ]);
    expect(fundsEligibilityReasons(V('VERIFIED', 'FLAGGED'))).toEqual([
      'AML screening flagged this account',
    ]);
    expect(fundsEligibilityReasons(V('REJECTED', 'CLEAR'))).toEqual([
      'Identity verification was declined',
    ]);
  });
});

describe('purposeEligible', () => {
  it('idea validation needs identity only; funds purposes need AML too', () => {
    const v = V('VERIFIED', 'NOT_SCREENED');
    expect(purposeEligible('IDEA_VALIDATION', v)).toBe(true);
    expect(purposeEligible('CAMPAIGN_CREATOR', v)).toBe(false);
    expect(purposeEligible('BACKER_THRESHOLD', v)).toBe(false);
    const cleared = V('VERIFIED', 'CLEAR');
    expect(purposeEligible('CAMPAIGN_CREATOR', cleared)).toBe(true);
  });

  it('purposeReasons is empty for a satisfied identity-only purpose', () => {
    expect(purposeReasons('IDEA_VALIDATION', V('VERIFIED'))).toEqual([]);
    expect(purposeReasons('IDEA_VALIDATION', V('PENDING'))).toEqual([
      'Identity verification (KYC) is required',
    ]);
    expect(purposeReasons('IDEA_VALIDATION', V('REJECTED'))).toEqual([
      'Identity verification was declined',
    ]);
  });
});

describe('backerFundingRequiresKyc (FR-104)', () => {
  it('is false while cumulative + next stays within the threshold', () => {
    expect(backerFundingRequiresKyc(0, 100, 200)).toBe(false);
    expect(backerFundingRequiresKyc(150, 50, 200)).toBe(false); // exactly at the threshold
  });

  it('is true for the pledge that crosses the threshold', () => {
    expect(backerFundingRequiresKyc(150, 51, 200)).toBe(true);
    expect(backerFundingRequiresKyc(200, 1, 200)).toBe(true);
  });
});

describe('outcome → persisted status mappers', () => {
  it('folds IN_REVIEW into PENDING (KycStatus has no review state)', () => {
    expect(kycOutcomeToStatus('VERIFIED')).toBe('VERIFIED');
    expect(kycOutcomeToStatus('REJECTED')).toBe('REJECTED');
    expect(kycOutcomeToStatus('IN_REVIEW')).toBe('PENDING');
    expect(kycOutcomeToStatus('PENDING')).toBe('PENDING');
  });

  it('passes AML outcomes straight through', () => {
    expect(amlOutcomeToStatus('CLEAR')).toBe('CLEAR');
    expect(amlOutcomeToStatus('IN_REVIEW')).toBe('IN_REVIEW');
    expect(amlOutcomeToStatus('FLAGGED')).toBe('FLAGGED');
  });
});
