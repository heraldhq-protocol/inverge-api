/**
 * Milliseconds from `now` to the next occurrence of `hour:minute` UTC.
 *
 * The daily jobs used to be BullMQ repeatable jobs with a cron pattern, which is
 * evaluated in UTC. Scheduling them in-process keeps the same wall-clock
 * behaviour, so this helper is the contract between the two: a job that used to
 * run at `0 3 * * *` now runs `msUntilNextUtc(now, 3, 0)` later.
 */
export function msUntilNextUtc(now: Date, hour: number, minute: number): number {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new RangeError(`Invalid UTC time ${hour}:${minute}`);
  }

  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hour,
      minute,
      0,
      0,
    ),
  );

  // `<=` and not `<`: at exactly 03:00:00.000 the run is due now, not tomorrow.
  if (next.getTime() < now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return next.getTime() - now.getTime();
}
