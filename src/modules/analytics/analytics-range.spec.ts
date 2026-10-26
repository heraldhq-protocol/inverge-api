import {
  analyticsBucketKey,
  analyticsBucketKeys,
  parseAnalyticsRange,
  rateOrNull,
} from './analytics-range';

const NOW = new Date('2026-10-25T12:00:00.000Z');

describe('parseAnalyticsRange', () => {
  it('defaults to the last 30 UTC days ending today', () => {
    // #given no range parameters
    // #when the range is parsed
    const range = parseAnalyticsRange({}, NOW);

    // #then the window is inclusive and ends today
    expect(range).toMatchObject({
      from: '2026-09-26',
      to: '2026-10-25',
      days: 30,
      interval: 'day',
    });
    expect(range.start.toISOString()).toBe('2026-09-26T00:00:00.000Z');
    expect(range.endExclusive.toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });

  it('accepts a single UTC day', () => {
    // #given the same day for both ends
    // #when the range is parsed
    const range = parseAnalyticsRange(
      { from: '2026-10-25', to: '2026-10-25' },
      NOW,
    );

    // #then the window is one day long
    expect(range.days).toBe(1);
    expect(range.start.toISOString()).toBe('2026-10-25T00:00:00.000Z');
    expect(range.endExclusive.toISOString()).toBe('2026-10-26T00:00:00.000Z');
  });

  it('rejects a future end date', () => {
    // #given a date after the current UTC day
    // #when the range is parsed
    // #then it is refused rather than clamped
    expect(() =>
      parseAnalyticsRange({ to: '2026-10-26' }, NOW),
    ).toThrow('to must not be in the future');
  });

  it('rejects an inverted range', () => {
    // #given a start after the end
    // #when the range is parsed
    // #then it is refused
    expect(() =>
      parseAnalyticsRange({ from: '2026-10-20', to: '2026-10-10' }, NOW),
    ).toThrow('from must be before or equal to to');
  });

  it('rejects a range longer than 366 days', () => {
    // #given a window one day over the cap
    // #when the range is parsed
    // #then it is refused
    expect(() =>
      parseAnalyticsRange({ from: '2025-10-24', to: '2026-10-25' }, NOW),
    ).toThrow('range is limited to 366 days');
  });

  it('accepts exactly 366 days', () => {
    // #given the maximum window
    // #when the range is parsed
    const range = parseAnalyticsRange(
      { from: '2025-10-25', to: '2026-10-25' },
      NOW,
    );

    // #then the boundary is inclusive
    expect(range.days).toBe(366);
  });

  it('rejects an unknown interval', () => {
    // #given an interval outside the closed list
    // #when the range is parsed
    // #then it is refused
    expect(() => parseAnalyticsRange({ interval: 'hour' }, NOW)).toThrow(
      'interval must be day, week or month',
    );
  });

  it('rejects an impossible calendar date', () => {
    // #given a date that rolls over into March
    // #when the range is parsed
    // #then it is refused
    expect(() => parseAnalyticsRange({ from: '2026-02-30' }, NOW)).toThrow(
      'day is not a calendar date',
    );
  });
});

describe('analyticsBucketKey', () => {
  it('uses the UTC day for daily buckets', () => {
    expect(analyticsBucketKey(new Date('2026-10-25T23:59:59.000Z'), 'day')).toBe(
      '2026-10-25',
    );
  });

  it('uses the UTC month for monthly buckets', () => {
    expect(
      analyticsBucketKey(new Date('2026-10-31T23:59:59.000Z'), 'month'),
    ).toBe('2026-10');
  });

  it('starts weekly buckets on Monday', () => {
    // #given a Sunday
    // #when the bucket key is computed
    // #then it belongs to the preceding Monday
    expect(analyticsBucketKey(new Date('2026-10-25T12:00:00.000Z'), 'week')).toBe(
      '2026-10-19',
    );
  });

  it('keeps Monday in its own bucket', () => {
    expect(analyticsBucketKey(new Date('2026-10-19T00:00:00.000Z'), 'week')).toBe(
      '2026-10-19',
    );
  });
});

describe('analyticsBucketKeys', () => {
  it('returns every daily bucket in order', () => {
    // #given a three-day range
    const range = parseAnalyticsRange(
      { from: '2026-10-23', to: '2026-10-25' },
      NOW,
    );

    // #when the keys are expanded
    // #then each day appears once
    expect(analyticsBucketKeys(range)).toEqual([
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
    ]);
  });

  it('collapses daily rows into one key per week', () => {
    // #given a range spanning two weeks
    const range = parseAnalyticsRange(
      { from: '2026-10-12', to: '2026-10-25', interval: 'week' },
      NOW,
    );

    // #when the keys are expanded
    // #then the weeks are deduplicated in order
    expect(analyticsBucketKeys(range)).toEqual(['2026-10-12', '2026-10-19']);
  });

  it('returns month keys in order', () => {
    // #given a range crossing a month boundary
    const range = parseAnalyticsRange(
      { from: '2026-09-30', to: '2026-10-02', interval: 'month' },
      NOW,
    );

    // #when the keys are expanded
    // #then September and October appear once each
    expect(analyticsBucketKeys(range)).toEqual(['2026-09', '2026-10']);
  });
});

describe('rateOrNull', () => {
  it('returns null for a zero denominator', () => {
    expect(rateOrNull(0, 0)).toBeNull();
  });

  it('returns null for a negative denominator', () => {
    expect(rateOrNull(5, -1)).toBeNull();
  });

  it('rounds a rate to two decimal places', () => {
    expect(rateOrNull(1, 3)).toBe(33.33);
  });

  it('returns 100 for a complete conversion', () => {
    expect(rateOrNull(8, 8)).toBe(100);
  });
});
