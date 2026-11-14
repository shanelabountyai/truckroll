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
