import {
  businessFundsReasons,
  isBusinessFundsEligible,
  isBusinessVerified,
} from './kyb-gates';

const B = (kyb: string, aml = 'NOT_SCREENED') => ({ kybStatus: kyb, amlStatus: aml });

describe('business (KYB) eligibility', () => {
  it('verified needs KYB VERIFIED', () => {
    expect(isBusinessVerified(B('VERIFIED'))).toBe(true);
    expect(isBusinessVerified(B('PENDING'))).toBe(false);
  });

  it('funds-eligible needs KYB VERIFIED AND AML CLEAR', () => {
    expect(isBusinessFundsEligible(B('VERIFIED', 'CLEAR'))).toBe(true);
    expect(isBusinessFundsEligible(B('VERIFIED', 'NOT_SCREENED'))).toBe(false);
    expect(isBusinessFundsEligible(B('VERIFIED', 'FLAGGED'))).toBe(false);
    expect(isBusinessFundsEligible(B('PENDING', 'CLEAR'))).toBe(false);
  });

  it('reasons use business wording', () => {
    expect(businessFundsReasons(B('VERIFIED', 'CLEAR'))).toEqual([]);
    expect(businessFundsReasons(B('PENDING', 'NOT_SCREENED'))).toEqual([
      'Business verification (KYB) is required',
      'AML screening is required',
    ]);
    expect(businessFundsReasons(B('REJECTED', 'CLEAR'))).toEqual([
      'Business verification was declined',
    ]);
    expect(businessFundsReasons(B('VERIFIED', 'FLAGGED'))).toEqual([
      'AML screening flagged this business',
    ]);
  });
});
