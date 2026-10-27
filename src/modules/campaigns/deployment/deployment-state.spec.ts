import {
  assertDeploymentTransition,
  canTransitionDeployment,
  canTransitionFee,
  classifySubmitOutcome,
  feeSatisfied,
  isOpenDeployment,
  isTerminalDeployment,
  publicationBlockers,
} from './deployment-state';

describe('deployment state machine', () => {
  it('allows the forward path from READY to CONFIRMED', () => {
    // #given a prepared attempt
    // #when it is submitted and verified
    // #then each forward step is legal
    expect(canTransitionDeployment('READY', 'AWAITING_SIGNATURE')).toBe(true);
    expect(canTransitionDeployment('AWAITING_SIGNATURE', 'SUBMITTED')).toBe(true);
    expect(canTransitionDeployment('SUBMITTED', 'CONFIRMING')).toBe(true);
    expect(canTransitionDeployment('CONFIRMING', 'CONFIRMED')).toBe(true);
  });

  it('never lets a confirmed deployment move again', () => {
    // #given a confirmed attempt
    // #when any transition is attempted
    // #then all are rejected
    expect(canTransitionDeployment('CONFIRMED', 'FAILED')).toBe(false);
    expect(canTransitionDeployment('CONFIRMED', 'READY')).toBe(false);
    expect(() => assertDeploymentTransition('CONFIRMED', 'READY')).toThrow(
      'Illegal campaign deployment transition',
    );
  });

  it('lets a failed attempt be retried without inventing a state', () => {
    // #given an attempt that failed on-chain
    // #when the creator retries
    // #then a fresh READY attempt is the only runway
    expect(canTransitionDeployment('FAILED', 'READY')).toBe(true);
  });

  it('treats SUBMITTED as pending, never as failed', () => {
    // #given an unread transaction
    // #when the submit outcome is classified
    // #then the attempt waits for reconciliation rather than reporting failure
    expect(
      classifySubmitOutcome({ accountVerified: false, executionError: null, transactionFound: false }),
    ).toBe('CONFIRMING');
    expect(
      classifySubmitOutcome({ accountVerified: false, executionError: null, transactionFound: true }),
    ).toBe('NEEDS_RECONCILIATION');
    expect(
      classifySubmitOutcome({ accountVerified: true, executionError: null, transactionFound: true }),
    ).toBe('CONFIRMED');
    expect(
      classifySubmitOutcome({
        accountVerified: false,
        executionError: 'InstructionError',
        transactionFound: true,
      }),
    ).toBe('FAILED');
  });

  it('separates open and terminal attempts', () => {
    // #given every status
    // #when classified
    // #then only automatic outcomes are terminal
    expect(isOpenDeployment('CONFIRMING')).toBe(true);
    expect(isOpenDeployment('NEEDS_RECONCILIATION')).toBe(true);
    expect(isTerminalDeployment('FAILED')).toBe(true);
    expect(isTerminalDeployment('CONFIRMED')).toBe(true);
    expect(isTerminalDeployment('CONFIRMING')).toBe(false);
  });
});

describe('fee state machine', () => {
  it('treats a not-required fee as satisfied but never transitionable', () => {
    // #given the not_required policy
    // #when checked and moved
    // #then it satisfies publication but cannot become pending
    expect(feeSatisfied('NOT_REQUIRED')).toBe(true);
    expect(canTransitionFee('NOT_REQUIRED', 'PENDING')).toBe(false);
  });

  it('allows a pending charge to settle or fail', () => {
    expect(canTransitionFee('PENDING', 'CONFIRMED')).toBe(true);
    expect(canTransitionFee('PENDING', 'SUBMITTED')).toBe(true);
    expect(canTransitionFee('PENDING', 'FAILED')).toBe(true);
    expect(canTransitionFee('CONFIRMED', 'PENDING')).toBe(false);
  });
});

describe('publicationBlockers', () => {
  const ready = {
    deploymentStatus: 'CONFIRMED' as const,
    feeStatus: 'NOT_REQUIRED' as const,
    launchedAt: null,
    milestoneCount: 2,
    reviewStatus: 'APPROVED',
    status: 'IN_REVIEW',
    termsHash: 'f'.repeat(64),
  };

  it('returns no blockers for a reviewed, verified campaign', () => {
    expect(publicationBlockers(ready)).toEqual([]);
  });

  it('lists every outstanding reason instead of a generic rejection', () => {
    // #given a draft with no deployment and no review
    const blockers = publicationBlockers({
      ...ready,
      deploymentStatus: null,
      reviewStatus: 'NOT_SUBMITTED',
      status: 'DRAFT',
      termsHash: null,
    });

    // #when evaluated
    // #then each unmet invariant is named
    expect(blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('must be in review'),
        expect.stringContaining('Curation review'),
        expect.stringContaining('not been verified on-chain'),
        expect.stringContaining('no content hash'),
      ]),
    );
  });

  it('blocks publication when the fee is not settled', () => {
    // #given a deployment whose fee failed
    const blockers = publicationBlockers({ ...ready, feeStatus: 'FAILED' });

    // #when evaluated
    // #then the fee lifecycle blocks publication independently
    expect(blockers).toContain('The deployment fee has not been confirmed.');
  });

  it('blocks publishing twice', () => {
    // #given an already-published campaign
    const blockers = publicationBlockers({ ...ready, launchedAt: new Date() });

    // #when evaluated
    // #then the second publication is refused
    expect(blockers).toContain('The campaign is already published.');
  });
});
