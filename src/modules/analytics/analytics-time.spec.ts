import {
  previousUtcDay,
  retentionCutoffs,
  utcDayKey,
  utcDayRange,
} from './analytics-time';

describe('utcDayRange', () => {
  it('returns a half-open UTC day', () => {
    const { start, end } = utcDayRange('2026-10-21');

    expect(start.toISOString()).toBe('2026-10-21T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-22T00:00:00.000Z');
  });

  it('rejects a malformed day', () => {
    expect(() => utcDayRange('21-10-2026')).toThrow(/YYYY-MM-DD/);
  });

  it('rejects a calendar rollover', () => {
    expect(() => utcDayRange('2026-02-30')).toThrow(/calendar date/);
  });
});

describe('day keys', () => {
  it('formats the UTC day of an instant', () => {
    expect(utcDayKey(new Date('2026-10-22T23:59:59.000Z'))).toBe('2026-10-22');
  });

  it('returns the previous UTC day across a month boundary', () => {
    expect(previousUtcDay(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-10-31');
  });
});

describe('retentionCutoffs', () => {
  it('uses whole months for the aggregate cutoff', () => {
    const cutoffs = retentionCutoffs(new Date('2026-10-22T00:00:00.000Z'), 90, 25);

    expect(cutoffs.eventsBefore.toISOString()).toBe('2026-07-24T00:00:00.000Z');
    expect(cutoffs.aggregatesBefore.toISOString()).toBe('2024-09-01T00:00:00.000Z');
  });
});
