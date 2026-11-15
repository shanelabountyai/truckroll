import { describe, expect, it } from 'vitest';
import { addDays, instantAt, localMinuteOn } from '@/lib/dispatch/time';

// Phase 4 (demo seed actual times): instantAt is the inverse of localMinuteOn in America/Chicago, DST days included.
describe('instantAt', () => {
  it('a November weekday: 10:40 local is 16:40 UTC (CST)', () => expect(instantAt('2026-11-16', 640).toISOString()).toBe('2026-11-16T16:40:00.000Z'));
  it('a July day: 10:40 local is 15:40 UTC (CDT)', () => expect(instantAt('2026-07-16', 640).toISOString()).toBe('2026-07-16T15:40:00.000Z'));
  it.each(['2026-03-08', '2026-11-01', '2026-11-16', '2027-01-01'])('round-trips every 7th minute of %s that exists on the wall clock', (day) => {
    for (let m = 0; m < 24 * 60; m += 7) {
      if (day === '2026-03-08' && m >= 120 && m < 180) continue; // 02:00–02:59 does not exist that night
      expect(localMinuteOn(instantAt(day, m), day)).toBe(m);
    }
  });
  it('addDays crosses months and years', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });
});
