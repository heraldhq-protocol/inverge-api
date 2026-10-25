/**
 * UTC day arithmetic for analytics aggregation and retention. Kept pure so the
 * boundary (and the month arithmetic) is tested without a clock or a database.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parses `YYYY-MM-DD` as a real UTC calendar day, rejecting rollovers. */
export function utcDayRange(day: string): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error('day must be YYYY-MM-DD');
  }
  const [year, month, date] = day.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, date));
  if (
    start.getUTCFullYear() !== year ||
    start.getUTCMonth() !== month - 1 ||
    start.getUTCDate() !== date
  ) {
    throw new Error('day is not a calendar date');
  }
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** The UTC day key of an instant, used to pick yesterday's roll-up. */
export function utcDayKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

export function previousUtcDay(instant: Date): string {
  return utcDayKey(new Date(instant.getTime() - DAY_MS));
}

export interface RetentionCutoffs {
  /** Raw events received before this instant are deleted. */
  eventsBefore: Date;
  /** Aggregate days before this midnight are deleted. */
  aggregatesBefore: Date;
}

/**
 * Raw events keep `rawDays`; aggregates keep `aggregateMonths` whole months plus
 * the current month. The aggregate cutoff is the first day of the oldest kept
 * month so a partial month is never half-deleted.
 */
export function retentionCutoffs(
  now: Date,
  rawDays: number,
  aggregateMonths: number,
): RetentionCutoffs {
  return {
    eventsBefore: new Date(now.getTime() - rawDays * DAY_MS),
    aggregatesBefore: new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - aggregateMonths, 1),
    ),
  };
}
