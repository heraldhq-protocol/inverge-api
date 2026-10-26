import {
  DEPLOYMENT_OBJECTION_WINDOW_DAYS,
  evaluateDeploymentReadiness,
  percentToBps,
  type ReadinessCampaign,
} from './campaign-readiness';

const NOW = new Date('2026-10-24T00:00:00Z');
const FUTURE = new Date('2026-12-01T00:00:00Z');

function campaign(overrides: Partial<ReadinessCampaign> = {}): ReadinessCampaign {
  return {
    creatorId: 'user_1',
    deadline: FUTURE,
    id: 'cmp_1',
    milestones: [
      {
        deliverable: 'Ship the pilot',
        evidenceDefinition: { text: 'Signed pilot agreement' },
        expectedAt: new Date('2026-11-15T00:00:00Z'),
        index: 0,
        title: 'Pilot',
        tranchePct: '50.00',
      },
      {
        deliverable: 'Publish the report',
        evidenceDefinition: { text: 'Public report' },
        expectedAt: new Date('2026-11-30T00:00:00Z'),
        index: 1,
        title: 'Report',
        tranchePct: '50.00',
      },
    ],
    objectionWindowDays: DEPLOYMENT_OBJECTION_WINDOW_DAYS,
    status: 'DRAFT',
    story: {
      beneficiaries: 'Farmers',
      location: 'Lagos',
      problem: 'A problem worth solving',
      solution: 'A solution worth funding',
    },
    summary: 'A summary that is long enough to pass validation.',
    targetAmount: '5000.00',
    title: 'Solar cold chain',
    tokenType: 'USDC',
    workingCapitalPct: '20.00',
    ...overrides,
  };
}

function evaluate(overrides: Partial<ReadinessCampaign> = {}, input: { wallet?: string | null; mint?: string | null } = {}) {
  return evaluateDeploymentReadiness({
    campaign: campaign(overrides),
    creatorWallet: input.wallet === undefined ? '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' : input.wallet,
    now: NOW,
    tokenMint: input.mint === undefined ? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' : input.mint,
  });
}

describe('percentToBps', () => {
  it('converts exact percentages to integer basis points', () => {
    // #given a two-decimal percentage
    // #when converted
    // #then no float rounding is involved
    expect(percentToBps('25')).toBe(2_500);
    expect(percentToBps('12.5')).toBe(1_250);
    expect(percentToBps('0.01')).toBe(1);
    expect(percentToBps('100.00')).toBe(10_000);
  });

  it.each(['', '-1', '1.234', 'abc', '100.01'])('rejects %p', (value) => {
    // #given a value that is not an exact percentage
    // #when converted
    // #then it is rejected rather than rounded
    expect(percentToBps(value)).toBeNull();
  });
});

describe('evaluateDeploymentReadiness', () => {
  it('passes a complete USDC draft with a fixed 20% tranche and milestone weights totalling 100%', () => {
    // #given a complete draft
    // #when evaluated
    // #then it is ready and returns the derived basis points
    const result = evaluate();

    expect(result.blockers).toEqual([]);
    expect(result.ready).toBe(true);
    expect(result.workingCapitalBps).toBe(2_000);
    expect(result.trancheBps).toEqual([5_000, 5_000]);
  });

  it('blocks milestone weights that do not total 100% of the remainder', () => {
    // #given milestones that only allocate 80% of the post-tranche pool
    const result = evaluate({
      milestones: [
        { ...campaign().milestones[0]!, tranchePct: '40.00' },
        { ...campaign().milestones[1]!, tranchePct: '40.00' },
      ],
    });

    // #when evaluated
    // #then the milestone-weight invariant is reported
    expect(result.ready).toBe(false);
    expect(result.blockers.join(' ')).toContain('must total exactly 100%');
  });

  it('blocks any working capital other than 20% of the target', () => {
    // #given a 25% working-capital tranche
    const result = evaluate({ workingCapitalPct: '25.00' });

    // #when evaluated
    // #then the fixed rate is enforced, not a band
    expect(result.ready).toBe(false);
    expect(result.blockers.join(' ')).toContain('fixed at 20%');
  });

  it('blocks a settlement asset that is not confirmed for escrow', () => {
    // #given a cNGN campaign
    const result = evaluate({ tokenType: 'CNGN' }, { mint: '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E' });

    // #when evaluated
    // #then only the unconfirmed asset is reported, not a fabricated conversion
    expect(result.ready).toBe(false);
    expect(result.blockers.join(' ')).toContain('confirmed for USDC only');
  });

  it('blocks a campaign whose deadline has passed', () => {
    // #given a deadline in the past
    const result = evaluate({ deadline: new Date('2026-01-01T00:00:00Z') });

    // #when evaluated
    // #then the campaign cannot be deployed
    expect(result.blockers.join(' ')).toContain('deadline has passed');
  });

  it('blocks a milestone without a future date', () => {
    // #given a milestone with no expected date
    const result = evaluate({
      milestones: [
        { ...campaign().milestones[0]!, expectedAt: null },
        campaign().milestones[1]!,
      ],
    });

    // #when evaluated
    // #then the on-chain milestone deadline requirement is reported
    expect(result.blockers.join(' ')).toContain('future submission date');
  });

  it('requires exactly the programme objection window', () => {
    // #given a 14-day window
    const result = evaluate({ objectionWindowDays: 14 });

    // #when evaluated
    // #then deployment is blocked rather than promising a window the programme ignores
    expect(result.blockers.join(' ')).toContain('fixes the objection window at 7 days');
  });

  it('blocks when no wallet or no mint is available', () => {
    // #given a campaign with neither a linked wallet nor a configured mint
    const result = evaluate({}, { mint: null, wallet: null });

    // #when evaluated
    // #then both are named individually
    expect(result.ready).toBe(false);
    expect(result.blockers.join(' ')).toContain('Link a Solana wallet');
    expect(result.blockers.join(' ')).toContain('No settlement mint is configured');
  });

  it('blocks a campaign that is no longer a draft', () => {
    // #given an already-published campaign
    const result = evaluate({ status: 'ACTIVE' });

    // #when evaluated
    // #then the immutability rule blocks a new deployment
    expect(result.blockers.join(' ')).toContain('Only a draft or in-review campaign');
  });
});
