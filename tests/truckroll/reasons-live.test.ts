import { describe, expect, it } from 'vitest';
import { checkPlan } from '@/lib/dispatch/check';
import { Plan, type Reason } from '@/lib/dispatch/contract';
import { skipWithoutSolver, solveRaw } from './helpers';
import { randomProblem } from './random-problems';

// The checker re-derives every unassigned reason (PRD §5). This proves the strict rule doesn't reject honest solver
// output: 40 seeded crowded days (pins, positions, re-plan starts, tight windows) through the live solver, each plan
// checked, with all three reasons occurring across the set.
describe.skipIf(skipWithoutSolver)('unassigned reasons on random days (live solver)', () => {
  it('40 seeded days: every plan passes the checker, and all three reasons occur', () => {
    const seen = new Set<Reason>();
    const failures: unknown[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      const problem = randomProblem(seed);
      const plan = Plan.parse(JSON.parse(solveRaw(problem)));
      for (const u of plan.unassigned) for (const r of u.reasons) seen.add(r);
      const res = checkPlan(problem, plan);
      if (!res.ok) failures.push({ seed, errors: res.errors });
    }
    expect(failures).toEqual([]);
    expect([...seen].sort()).toEqual(['no-skill', 'no-window-fit', 'over-capacity']);
  }, 120_000);
});
