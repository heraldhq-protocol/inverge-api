/**
 * Reconciliation backoff for a submitted-but-unverified deployment.
 *
 * The worker runs every 30 seconds, but it must not poll a cluster at that rate
 * for an attempt that stays unverifiable for an hour. The delay grows
 * exponentially per failed look, is capped, and carries jitter so a batch of
 * attempts submitted together does not synchronise into bursts.
 *
 * Pure: the clock and the random source are injected, so the schedule is
 * unit-testable without waiting.
 */

export const RECONCILE_BASE_DELAY_MS = 30_000;
export const RECONCILE_MAX_DELAY_MS = 30 * 60_000;
/** First look after submission: a landed transaction is usually visible by then. */
export const FIRST_RECONCILE_DELAY_MS = 30_000;
/** Manual-review cadence for an attempt that needs an operator, not more polling. */
export const MANUAL_REVIEW_DELAY_MS = 5 * 60_000;
/** After this many attempts an operator, not the worker, owns the outcome. */
export const RECONCILE_MAX_ATTEMPTS = 20;

const MAX_EXPONENT = 6;

export function reconcileDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(Math.trunc(attempt), 0), MAX_EXPONENT);
  const base = Math.min(RECONCILE_BASE_DELAY_MS * 2 ** exponent, RECONCILE_MAX_DELAY_MS);
  const jitterBound = Math.min(5_000, Math.floor(base * 0.2));
  const jitter = Math.floor(random() * jitterBound);
  return Math.min(base + jitter, RECONCILE_MAX_DELAY_MS);
}

export function nextReconcileAt(
  attempts: number,
  now: Date = new Date(),
  random: () => number = Math.random,
): Date {
  return new Date(now.getTime() + reconcileDelayMs(attempts, random));
}
