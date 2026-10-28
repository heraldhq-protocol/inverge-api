import {
  evaluateCampaignReviewGates,
  type CampaignReviewGateInput,
} from './campaign-review.preconditions';

const baseInput = (
  overrides: Partial<CampaignReviewGateInput> = {},
): CampaignReviewGateInput => ({
  campaignId: 'cmp_1',
  creatorId: 'usr_creator',
  applicationFeeChargeId: 'fee_1',
  creator: { kycStatus: 'VERIFIED', amlStatus: 'CLEAR' },
  business: null,
  applicationFee: {
    id: 'fee_1',
    userId: 'usr_creator',
    purpose: 'APPLICATION_FEE',
    status: 'SUCCEEDED',
    metadata: { campaignId: 'cmp_1' },
  },
  ...overrides,
});

describe('campaign review preconditions (FR-103 + FR-311)', () => {
  it('passes with verified identity and a successful application fee', () => {
    const gates = evaluateCampaignReviewGates(baseInput());
    expect(gates.eligible).toBe(true);
    expect(gates.blockers).toEqual([]);
    expect(gates.checks).toHaveLength(2);
    expect(gates.checks.every((c) => c.satisfied)).toBe(true);
  });

  it('blocks an unverified creator but still reports the fee separately', () => {
    const gates = evaluateCampaignReviewGates(
      baseInput({
        creator: { kycStatus: 'PENDING', amlStatus: 'NOT_SCREENED' },
      }),
    );
    expect(gates.eligible).toBe(false);
    expect(gates.blockers.join(' ')).toMatch(/Identity verification/);
    expect(gates.blockers.join(' ')).not.toMatch(/Application fee/);
    expect(
      gates.checks.find((c) => c.key === 'application_fee')?.satisfied,
    ).toBe(true);
  });

  it('accepts a verified business when the individual is not verified', () => {
    const gates = evaluateCampaignReviewGates(
      baseInput({
        creator: { kycStatus: 'NOT_REQUIRED', amlStatus: 'NOT_SCREENED' },
        business: { kybStatus: 'VERIFIED', amlStatus: 'CLEAR' },
      }),
    );
    expect(gates.eligible).toBe(true);
    expect(gates.checks[0].detail).toMatch(/Business/);
  });

  it('reports both personal and business blockers when neither path passes', () => {
    const gates = evaluateCampaignReviewGates(
      baseInput({
        creator: { kycStatus: 'REJECTED', amlStatus: 'FLAGGED' },
        business: { kybStatus: 'PENDING', amlStatus: 'IN_REVIEW' },
      }),
    );
    expect(gates.eligible).toBe(false);
    const text = gates.blockers.join(' ');
    expect(text).toMatch(/Creator: Identity verification was declined/);
    expect(text).toMatch(/Business: Business verification \(KYB\) is required/);
  });

  it('blocks when no application fee is linked', () => {
    const gates = evaluateCampaignReviewGates(
      baseInput({ applicationFeeChargeId: null, applicationFee: null }),
    );
    expect(gates.eligible).toBe(false);
    expect(gates.blockers).toContain(
      'Application fee (FR-311) has not been paid',
    );
  });

  it('blocks a pending application fee', () => {
    const gates = evaluateCampaignReviewGates(
      baseInput({
        applicationFee: {
          id: 'fee_1',
          userId: 'usr_creator',
          purpose: 'APPLICATION_FEE',
          status: 'PENDING',
        },
      }),
    );
    expect(gates.eligible).toBe(false);
    expect(gates.blockers.join(' ')).toMatch(/is pending/);
  });

  it('blocks a fee paid by a different account', () => {
    const gates = evaluateCampaignReviewGates(
      baseInput({
        applicationFee: {
          id: 'fee_1',
          userId: 'usr_someone_else',
          purpose: 'APPLICATION_FEE',
          status: 'SUCCEEDED',
        },
      }),
    );
    expect(gates.eligible).toBe(false);
    expect(gates.blockers.join(' ')).toMatch(/not paid by the campaign creator/);
  });

  it('blocks a charge that is not an application fee', () => {
    const gates = evaluateCampaignReviewGates(
      baseInput({
        applicationFee: {
          id: 'fee_1',
          userId: 'usr_creator',
          purpose: 'BOOST',
          status: 'SUCCEEDED',
        },
      }),
    );
    expect(gates.eligible).toBe(false);
    expect(gates.blockers).toContain(
      'Linked charge is not an application fee (FR-311)',
    );
  });

  it('blocks a fee explicitly bound to another campaign', () => {
    const gates = evaluateCampaignReviewGates(
      baseInput({
        applicationFee: {
          id: 'fee_1',
          userId: 'usr_creator',
          purpose: 'APPLICATION_FEE',
          status: 'SUCCEEDED',
          metadata: { campaignId: 'cmp_other' },
        },
      }),
    );
    expect(gates.eligible).toBe(false);
    expect(gates.blockers.join(' ')).toMatch(/belongs to another campaign/);
  });

  it('accepts a fee explicitly bound to this campaign', () => {
    const gates = evaluateCampaignReviewGates(
      baseInput({
        applicationFee: {
          id: 'fee_1',
          userId: 'usr_creator',
          purpose: 'APPLICATION_FEE',
          status: 'SUCCEEDED',
          metadata: { campaignId: 'cmp_1' },
        },
      }),
    );
    expect(gates.eligible).toBe(true);
  });

  it('blocks a successful fee that is not bound to any campaign', () => {
    const gates = evaluateCampaignReviewGates(
      baseInput({
        applicationFee: {
          id: 'fee_1',
          userId: 'usr_creator',
          purpose: 'APPLICATION_FEE',
          status: 'SUCCEEDED',
          metadata: undefined,
        },
      }),
    );
    expect(gates.eligible).toBe(false);
    expect(gates.blockers).toContain(
      'Application fee (FR-311) is not bound to this campaign',
    );
  });
});
