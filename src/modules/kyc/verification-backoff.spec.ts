import { isReconcileExhausted, reconcileDelayMs } from './verification-backoff';

describe('reconcileDelayMs', () => {
  it('grows exponentially and stays inside the ceiling', () => {
    const first = reconcileDelayMs({ attempts: 1, baseMs: 1_000, maxMs: 60_000, random: () => 1 });
    const third = reconcileDelayMs({ attempts: 3, baseMs: 1_000, maxMs: 60_000, random: () => 1 });
    expect(first).toBe(1_000);
    expect(third).toBe(4_000);
  });

  it('applies jitter without exceeding the ceiling', () => {
    const delay = reconcileDelayMs({ attempts: 5, baseMs: 1_000, maxMs: 5_000, random: () => 0 });
    expect(delay).toBe(2_500);
  });

  it('never returns zero', () => {
    expect(reconcileDelayMs({ attempts: 1, baseMs: 1, maxMs: 1, random: () => 0 })).toBe(1_000);
  });
});

describe('isReconcileExhausted', () => {
  it('escalates at the configured maximum', () => {
    expect(isReconcileExhausted(4, 5)).toBe(false);
    expect(isReconcileExhausted(5, 5)).toBe(true);
  });
});
