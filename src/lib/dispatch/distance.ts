import type { Point } from './contract';

// D-01: haversine × road factor at an average speed, rounded up to whole minutes. Ported 1:1 in solver/distance.py;
// the cross-language test proves the two agree to the minute on every fixture pair. Keep the operation order identical.
export const EARTH_RADIUS_MI = 3958.8;
export const ROAD_FACTOR = 1.35;
export const AVG_MPH = 45;
// libm results can differ in the last bit between V8 and CPython; without this a value a hair above an integer could
// round up in one language and not the other.
const EPS = 1e-9;

const rad = (deg: number) => (deg * Math.PI) / 180;

export function haversineMiles(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const sLat = Math.sin(dLat / 2);
  const sLng = Math.sin(dLng / 2);
  const h = sLat * sLat + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * sLng * sLng;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function driveMinutes(a: Point, b: Point): number {
  if (a.lat === b.lat && a.lng === b.lng) return 0;
  const minutes = ((haversineMiles(a, b) * ROAD_FACTOR) / AVG_MPH) * 60;
  return Math.max(0, Math.ceil(minutes - EPS));
}

/** Matrix over points in the order given (used by tests to compare with the solver's matrix). */
export function driveMatrix(points: Point[]): number[][] {
  return points.map((a) => points.map((b) => driveMinutes(a, b)));
}
