import { describe, expect, it } from 'vitest';
import { checkPinConflict, checkPlan } from '@/lib/dispatch/check';
import { Plan, type Reason } from '@/lib/dispatch/contract';
import { skipWithoutSolver, solveResult } from './helpers';
import { randomProblem } from './random-problems';

// The checker re-derives every unassigned reason (PRD §5). This proves the strict rule doesn't reject honest solver
// output: 40 seeded crowded days (pins, positions, re-plan starts, tight windows) through the live solver. Each answer
// is checked: a plan by checkPlan (no lateness, D-36; no pin dropped or moved, D-37), and a pin-conflict, when the
// day's pins can't all be honoured, by checkPinConflict. All three reasons must occur across the set.
describe.skipIf(skipWithoutSolver)('unassigned reasons on random days (live solver)', () => {
  it('40 seeded days: every answer passes the checker, and all three reasons occur', () => {
    const seen = new Set<Reason>();
    const failures: unknown[] = [];
    let plans = 0;
    let conflicts = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const problem = randomProblem(seed);
      const r = solveResult(problem);
      if ('pinConflict' in r) {
        conflicts++;
        const res = checkPinConflict(problem, r.pinConflict);
        if (!res.ok) failures.push({ seed, errors: res.errors });
        continue;
      }
      plans++;
      const plan = Plan.parse(r.plan);
      for (const u of plan.unassigned) for (const x of u.reasons) seen.add(x);
      const res = checkPlan(problem, plan);
      if (!res.ok) failures.push({ seed, errors: res.errors });
    }
    expect(failures).toEqual([]);
    expect(plans).toBeGreaterThanOrEqual(20); // 26 today: most days still get a plan
    expect(conflicts).toBeGreaterThanOrEqual(1); // and the pin-conflict path is exercised too (14 today)
    expect([...seen].sort()).toEqual(['no-skill', 'no-window-fit', 'over-capacity']);
  }, 120_000);
});
