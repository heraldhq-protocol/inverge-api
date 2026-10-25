/**
 * UTC range and bucket arithmetic for analytics reads. Kept pure so the boundary
 * (inclusive days, week start, month keys) is tested without a clock or a database.
 */

import { utcDayKey, utcDayRange } from './analytics-time';

export type AnalyticsInterval = 'day' | 'week' | 'month';

export interface AnalyticsRange {
  from: string;
  to: string;
  days: number;
  start: Date;
  endExclusive: Date;
  interval: AnalyticsInterval;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;
const INTERVALS: AnalyticsInterval[] = ['day', 'week', 'month'];

export interface AnalyticsRangeInput {
  from?: string;
  to?: string;
  interval?: string;
}

/**
 * Parses an inclusive UTC day range. Defaults to the last 30 days ending today.
 * The end is clamped to today so a future date cannot create an empty window with
 * a misleading zero denominator.
 */
export function parseAnalyticsRange(
  input: AnalyticsRangeInput,
  now: Date,
): AnalyticsRange {
  const today = utcDayKey(now);
  const requestedTo = input.to ?? today;
  const to = utcDayRange(requestedTo);
  const todayRange = utcDayRange(today);
  if (to.start.getTime() > todayRange.start.getTime()) {
    throw new Error('to must not be in the future');
  }

  const defaultFrom = utcDayKey(
    new Date(to.start.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS),
  );
  const requestedFrom = input.from ?? defaultFrom;
  const from = utcDayRange(requestedFrom);
  if (from.start.getTime() > to.start.getTime()) {
    throw new Error('from must be before or equal to to');
  }

  const days = Math.round((to.start.getTime() - from.start.getTime()) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new Error(`range is limited to ${MAX_RANGE_DAYS} days`);
  }

  const interval = (input.interval ?? 'day') as AnalyticsInterval;
  if (!INTERVALS.includes(interval)) {
    throw new Error('interval must be day, week or month');
  }

  return {
    from: requestedFrom,
    to: requestedTo,
    days,
    start: from.start,
    endExclusive: to.end,
    interval,
  };
}

/**
 * Bucket key for a UTC day. Week buckets start on Monday; month buckets use
 * `YYYY-MM`. The key is a string so it can be a response map key without a
 * timezone-dependent Date round-trip.
 */
export function analyticsBucketKey(
  day: Date,
  interval: AnalyticsInterval,
): string {
  const key = utcDayKey(day);
  if (interval === 'day') return key;
  if (interval === 'month') return key.slice(0, 7);

  const weekday = (day.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - weekday),
  );
  return utcDayKey(monday);
}

/** Every bucket key in the range, in order, so a chart can render zeroes. */
export function analyticsBucketKeys(range: AnalyticsRange): string[] {
  const keys: string[] = [];
  for (
    let time = range.start.getTime();
    time < range.endExclusive.getTime();
    time += DAY_MS
  ) {
    const key = analyticsBucketKey(new Date(time), range.interval);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys;
}

/** Null-safe rate; a zero denominator is unknown, not 0%. */
export function rateOrNull(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}
