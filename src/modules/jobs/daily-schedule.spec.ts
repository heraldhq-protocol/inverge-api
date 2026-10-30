import { msUntilNextUtc } from './daily-schedule';

describe('msUntilNextUtc', () => {
  it('waits until tomorrow when the time has already passed today', () => {
    const now = new Date('2026-10-30T05:00:00.000Z');

    expect(msUntilNextUtc(now, 3, 0)).toBe(22 * 3_600_000);
  });

  it('waits the remaining time when the time is still ahead today', () => {
    const now = new Date('2026-10-30T02:00:00.000Z');

    expect(msUntilNextUtc(now, 3, 0)).toBe(3_600_000);
  });

  it('is due immediately at the scheduled minute', () => {
    const now = new Date('2026-10-30T03:00:00.000Z');

    expect(msUntilNextUtc(now, 3, 0)).toBe(0);
  });

  it('rolls over the month boundary', () => {
    const now = new Date('2026-10-31T22:00:00.000Z');

    expect(msUntilNextUtc(now, 3, 0)).toBe(5 * 3_600_000);
  });

  it('rejects a time that is not on the clock', () => {
    expect(() => msUntilNextUtc(new Date(), 24, 0)).toThrow(RangeError);
  });
});
