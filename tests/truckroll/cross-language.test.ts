import { describe, expect, it } from 'vitest';
import { checkPlan } from '@/lib/dispatch/check';
import { Plan } from '@/lib/dispatch/contract';
import { driveMatrix } from '@/lib/dispatch/distance';
import { expectationFailures, fixturePoints, fixtures, pythonDriveMatrix, skipWithoutSolver, solveRaw } from './helpers';

// Phase 1 gate: every fixture through the Python solver (solver/cli.py, the POST /solve code path) and then the TS
// checker. The solver is never trusted (D-03).
describe.skipIf(skipWithoutSolver)('cross-language: solver → checker', () => {
  it.each(fixtures.map((f) => [f.name, f]))('%s: plan passes the checker and meets expectations', (_, f) => {
    const plan = Plan.parse(JSON.parse(solveRaw(f.problem, f.timeLimitMs)));
    const res = checkPlan(f.problem, plan);
    expect(res.errors).toEqual([]);
    expect(expectationFailures(f.expect, plan)).toEqual([]);
    expect(['local-optimum', 'solution-limit', 'trivial']).toContain(plan.stoppedBy);
  });

  it.each(fixtures.map((f) => [f.name, f]))('%s: TS and Python drive matrices agree to the minute', (_, f) => {
    const pts = fixturePoints(f.problem);
    expect(pythonDriveMatrix(pts)).toEqual(driveMatrix(pts));
  });

  it('TS and Python agree on 2,500 random pairs across the bounding box', () => {
    let s = 7;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pts = Array.from({ length: 50 }, () => ({ lat: 35.55 + rnd() * 0.5, lng: -95.55 + rnd() * 0.7 }));
    expect(pythonDriveMatrix(pts)).toEqual(driveMatrix(pts));
  });
});
