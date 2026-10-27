import {
  isFundsCleared,
  legacyOutcomeForState,
  mapDiditStatus,
  riskFromAml,
  transitionVerdict,
} from './verification-status';

describe('mapDiditStatus', () => {
  it.each([
    ['Not Started', 'SESSION_CREATED'],
    ['In Progress', 'AWAITING_USER'],
    ['Awaiting User', 'AWAITING_USER'],
    ['Approved', 'APPROVED'],
    ['Declined', 'DECLINED'],
    ['In Review', 'IN_REVIEW'],
    ['Resubmitted', 'ACTION_REQUIRED'],
    ['Expired', 'EXPIRED'],
    ['Abandoned', 'EXPIRED'],
    ['Kyc Expired', 'EXPIRED'],
  ])('maps %s to %s', (provider, state) => {
    expect(mapDiditStatus(provider)).toEqual({ providerStatus: provider, state });
  });

  it('never maps an unknown string to a permissive state', () => {
    expect(mapDiditStatus('Approved ')).toEqual({
      providerStatus: null,
      state: 'ERROR',
    });
    expect(mapDiditStatus(undefined).state).toBe('ERROR');
  });
});

describe('riskFromAml', () => {
  it('treats absent screening as unassessed, not clear', () => {
    expect(riskFromAml(null)).toBe('NOT_ASSESSED');
    expect(riskFromAml('CLEAR')).toBe('CLEAR');
    expect(riskFromAml('IN_REVIEW')).toBe('REVIEW');
    expect(riskFromAml('FLAGGED')).toBe('FLAGGED');
  });
});

describe('isFundsCleared', () => {
  it('requires an approval and a clear screening', () => {
    expect(isFundsCleared('APPROVED', 'CLEAR')).toBe(true);
    expect(isFundsCleared('APPROVED', 'NOT_ASSESSED')).toBe(false);
    expect(isFundsCleared('IN_REVIEW', 'CLEAR')).toBe(false);
  });
});

describe('transitionVerdict', () => {
  const now = new Date('2026-10-27T10:00:00Z');

  it('applies a newer event', () => {
    expect(
      transitionVerdict({
        current: 'AWAITING_USER',
        lastSyncedAt: new Date('2026-10-27T09:55:00Z'),
        next: 'APPROVED',
        occurredAt: now,
      }),
    ).toBe('apply');
  });

  it('drops an event older than the last applied sync', () => {
    expect(
      transitionVerdict({
        current: 'APPROVED',
        lastSyncedAt: new Date('2026-10-27T10:00:00Z'),
        next: 'DECLINED',
        occurredAt: new Date('2026-10-27T09:00:00Z'),
      }),
    ).toBe('stale');
  });

  it('does not regress an approval with a duplicate decline', () => {
    expect(
      transitionVerdict({
        current: 'APPROVED',
        lastSyncedAt: null,
        next: 'DECLINED',
        occurredAt: now,
      }),
    ).toBe('regression');
  });

  it('allows an approval to become expired (Kyc Expired)', () => {
    expect(
      transitionVerdict({
        current: 'APPROVED',
        lastSyncedAt: null,
        next: 'EXPIRED',
        occurredAt: now,
      }),
    ).toBe('apply');
  });
});

describe('legacyOutcomeForState', () => {
  it('projects the internal state onto the legacy vocabulary', () => {
    expect(legacyOutcomeForState('APPROVED')).toBe('VERIFIED');
    expect(legacyOutcomeForState('DECLINED')).toBe('REJECTED');
    expect(legacyOutcomeForState('IN_REVIEW')).toBe('IN_REVIEW');
    expect(legacyOutcomeForState('ACTION_REQUIRED')).toBe('PENDING');
  });
});
