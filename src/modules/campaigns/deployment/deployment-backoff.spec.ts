import {
  MANUAL_REVIEW_DELAY_MS,
  RECONCILE_BASE_DELAY_MS,
  RECONCILE_MAX_ATTEMPTS,
  RECONCILE_MAX_DELAY_MS,
  nextReconcileAt,
  reconcileDelayMs,
} from './deployment-backoff';

describe('reconcileDelayMs', () => {
  it('starts at the base delay and doubles per attempt', () => {
    // #given a deterministic random source
    const random = () => 0;

    // #when the delay is computed
    // #then the first polls are 30s, 60s and 120s apart
    expect(reconcileDelayMs(0, random)).toBe(RECONCILE_BASE_DELAY_MS);
    expect(reconcileDelayMs(1, random)).toBe(RECONCILE_BASE_DELAY_MS * 2);
    expect(reconcileDelayMs(2, random)).toBe(RECONCILE_BASE_DELAY_MS * 4);
  });

  it('never exceeds the cap, however many attempts have run', () => {
    // #given an attempt count far beyond the cap
    // #when the delay is computed with maximal jitter
    // #then the result is capped
    expect(reconcileDelayMs(50, () => 1)).toBe(RECONCILE_MAX_DELAY_MS);
    expect(reconcileDelayMs(99, () => 0)).toBe(RECONCILE_MAX_DELAY_MS);
  });

  it('adds bounded jitter so attempts do not synchronise', () => {
    // #given the same attempt with different random draws
    const low = reconcileDelayMs(0, () => 0);
    const high = reconcileDelayMs(0, () => 0.999);

    // #when compared
    // #then the spread is bounded and non-negative
    expect(high).toBeGreaterThan(low);
    expect(high - low).toBeLessThanOrEqual(5_000);
  });

  it('treats a negative attempt as the first poll', () => {
    expect(reconcileDelayMs(-3, () => 0)).toBe(RECONCILE_BASE_DELAY_MS);
  });
});

describe('nextReconcileAt', () => {
  it('returns an absolute timestamp after the delay', () => {
    // #given a fixed clock
    const now = new Date('2026-10-24T10:00:00Z');

    // #when scheduled from the first attempt
    const next = nextReconcileAt(0, now, () => 0);

    // #then it is exactly one base delay later
    expect(next.toISOString()).toBe('2026-10-24T10:00:30.000Z');
  });

  it('keeps a manual-review interval separate from the poll cap', () => {
    // #given the operator cadence
    // #when compared with the automatic cap
    // #then it is shorter, so a human is not the only slow path
    expect(MANUAL_REVIEW_DELAY_MS).toBeLessThan(RECONCILE_MAX_DELAY_MS);
    expect(RECONCILE_MAX_ATTEMPTS).toBeGreaterThan(0);
  });
});
