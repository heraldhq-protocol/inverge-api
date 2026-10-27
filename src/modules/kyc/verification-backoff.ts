// Reconciliation backoff policy. Pure so the timing is testable without a clock and
// identical in the worker and the scheduler. A missed webhook is retried with bounded
// exponential backoff plus jitter; after the configured attempts the case is escalated
// to a human instead of being retried forever.

export interface BackoffInput {
  /** 1-based attempt that just failed. */
  attempts: number;
  baseMs: number;
  maxMs: number;
  /** Injected for determinism in tests; defaults to Math.random at the call site. */
  random: () => number;
}

export const RECONCILE_BASE_DELAY_MS = 60_000;
export const RECONCILE_MAX_DELAY_MS = 60 * 60_000;

/** Full-jitter exponential backoff: a retry storm cannot synchronise. */
export function reconcileDelayMs(input: BackoffInput): number {
  const attempt = Math.max(1, Math.trunc(input.attempts));
  const exponent = Math.min(attempt - 1, 10);
  const ceiling = Math.min(
    input.maxMs,
    input.baseMs * 2 ** exponent,
  );
  const jittered = ceiling * (0.5 + input.random() * 0.5);
  return Math.max(1_000, Math.round(jittered));
}

export function isReconcileExhausted(
  attempts: number,
  maxAttempts: number,
): boolean {
  return attempts >= maxAttempts;
}

/** Attempts-left label for support; never exposes provider payloads. */
export function reconcileStateLabel(
  attempts: number,
  maxAttempts: number,
): 'PENDING' | 'RETRYING' | 'EXHAUSTED' {
  if (attempts <= 0) return 'PENDING';
  return isReconcileExhausted(attempts, maxAttempts) ? 'EXHAUSTED' : 'RETRYING';
}
