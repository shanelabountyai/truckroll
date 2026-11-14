import { describe, expect, it } from 'vitest';
import { driveMatrix, driveMinutes, haversineMiles } from '@/lib/dispatch/distance';

const MUSKOGEE = { lat: 35.7479, lng: -95.3697 };
const TAHLEQUAH = { lat: 35.9154, lng: -94.97 };

describe('distance (D-01)', () => {
  it('same point is zero minutes', () => {
    expect(driveMinutes(MUSKOGEE, MUSKOGEE)).toBe(0);
  });
  it('Muskogee shop to Tahlequah shop: ~25.2 straight miles (hand-computed: 11.57 mi N, 22.41 mi E), ×1.35 at 45 mph, rounded up', () => {
    const miles = haversineMiles(MUSKOGEE, TAHLEQUAH);
    expect(miles).toBeGreaterThan(25.0);
    expect(miles).toBeLessThan(25.4);
    expect(driveMinutes(MUSKOGEE, TAHLEQUAH)).toBe(Math.ceil(((miles * 1.35) / 45) * 60 - 1e-9));
    expect(driveMinutes(MUSKOGEE, TAHLEQUAH)).toBe(46); // 25.20 × 1.35 ÷ 45 × 60 = 45.4
  });
  it('is symmetric and never negative', () => {
    const pts = [MUSKOGEE, TAHLEQUAH, { lat: 35.6, lng: -95.5 }, { lat: 36.0, lng: -94.9 }];
    const m = driveMatrix(pts);
    for (let i = 0; i < pts.length; i++) for (let j = 0; j < pts.length; j++) {
      expect(m[i]![j]).toBe(m[j]![i]);
      expect(m[i]![j]).toBeGreaterThanOrEqual(0);
    }
  });
  it('rounds up: a few hundred metres is one minute, not zero', () => {
    expect(driveMinutes(MUSKOGEE, { lat: MUSKOGEE.lat + 0.001, lng: MUSKOGEE.lng })).toBe(1);
  });
});
