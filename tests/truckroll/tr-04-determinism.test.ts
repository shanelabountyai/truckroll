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
// Since hard windows (D-36) the demo day solves in ~60 ms, under the 100 ms minimum cap, so the cap must bite on a
// heavier day: the demo day three times over (72 jobs).
describe.skipIf(skipWithoutSolver)('TR-04 with a cap that bites', () => {
  const demo = fixtures.find((f) => f.name === '03-demo-day')!;
  const x3 = { ...demo.problem, techs: demo.problem.techs.map((t) => ({ ...t, maxJobs: 50 })), jobs: [0, 1, 2].flatMap((k) => demo.problem.jobs.map((j) => ({ ...j, id: `${j.id}-${k}` }))) };
  it('demo day ×3 at 100–1000 ms: identical bytes or time-limit, never a different plan; 100 ms always bites', () => {
    const ref = solveRaw(x3, demo.timeLimitMs);
    let bit = 0;
    for (const ms of [100, 100, 300, 1000]) {
      let got: string | null = null;
      try {
        got = solveRaw(x3, ms);
      } catch (e) {
        expect(String(e)).toMatch(/solver exited 3: time-limit/);
        bit++;
      }
      if (got !== null) expect(got).toBe(ref);
    }
    expect(bit).toBeGreaterThanOrEqual(2);
  }, 60_000);
});

// Re-checked after D-36 / D-37 (hard windows, mandatory pins changed the model): the demo day, ten solves in a row.
describe.skipIf(skipWithoutSolver)('TR-04: the demo day, 10 solves in a row', () => {
  it('03-demo-day: 10 byte-identical plans', () => {
    const demo = fixtures.find((f) => f.name === '03-demo-day')!;
    const runs = Array.from({ length: 10 }, () => solveRaw(demo.problem, demo.timeLimitMs));
    expect(new Set(runs).size).toBe(1);
  }, 60_000);
});
