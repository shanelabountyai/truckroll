import { describe, expect, it } from 'vitest';
import { fixtures, skipWithoutSolver, solveRaw } from './helpers';

// TR-04: same problem + same time limit → byte-identical plan JSON.
const reorderKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(reorderKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reorderKeys(x)])) : v;

describe.skipIf(skipWithoutSolver)('TR-04 determinism', () => {
  it.each(fixtures.map((f) => [f.name, f]))('%s: two solves are byte-identical, even with the request keys reordered', (_, f) => {
    const a = solveRaw(f.problem, f.timeLimitMs);
    const b = solveRaw(f.problem, f.timeLimitMs);
    const c = solveRaw(reorderKeys(f.problem) as typeof f.problem, f.timeLimitMs);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});

// PR #1 review must-fix 1, with a real clock (no fake): the cap only ever turns a plan into "no plan" (exit 3 /
// HTTP 503), never into a different plan. So under any cap: the reference bytes or the time-limit error.
describe.skipIf(skipWithoutSolver)('TR-04 with a cap that bites', () => {
  const demo = fixtures.find((f) => f.name === '03-demo-day')!;
  it('03-demo-day at 100–1000 ms: identical bytes or time-limit, never a different plan', () => {
    const ref = solveRaw(demo.problem, demo.timeLimitMs);
    for (const ms of [100, 100, 300, 1000]) {
      let got: string | null = null;
      try {
        got = solveRaw(demo.problem, ms);
      } catch (e) {
        expect(String(e)).toMatch(/solver exited 3: time-limit/);
      }
      if (got !== null) expect(got).toBe(ref);
    }
  }, 60_000);
});
