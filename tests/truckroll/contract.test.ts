import { describe, expect, it } from 'vitest';
import { Plan, Problem, SolveRequest } from '@/lib/dispatch/contract';
import { fixtures, goldenPlan } from './helpers';

describe('contract', () => {
  it('has at least 12 fixtures, including infeasible ones of every reason and a pinned job', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(12);
    const reasons = new Set(fixtures.flatMap((f) => [...Object.values(f.expect.unassigned ?? {}).flat(), ...Object.keys(f.expect.unassignedCounts ?? {})]));
    expect([...reasons].sort()).toEqual(['no-skill', 'no-window-fit', 'over-capacity']);
    expect(fixtures.some((f) => f.problem.jobs.some((j) => j.pin))).toBe(true);
  });
  it.each(fixtures.map((f) => [f.name, f]))('%s parses as a Problem and its golden plan as a Plan', (_, f) => {
    expect(Problem.safeParse(f.problem).success).toBe(true);
    expect(SolveRequest.safeParse({ problem: f.problem, timeLimitMs: f.timeLimitMs }).success).toBe(true);
    expect(Plan.safeParse(goldenPlan(f.name)).success).toBe(true);
  });
  const base = fixtures[0]!.problem;
  const t0 = base.techs[0]!;
  it.each([
    ['lunch outside the shift', { ...base, techs: [{ ...t0, lunch: { earliest: 400, latest: 700 } }] }],
    ['shift ends before it starts', { ...base, techs: [{ ...t0, shiftEnd: t0.shiftStart }] }],
    ['duplicate tech id', { ...base, techs: [t0, t0] }],
    ['pin to an unknown tech', { ...base, jobs: [{ ...base.jobs[0]!, pin: { techId: 'nobody' } }] }],
    ['unknown skill', { ...base, jobs: [{ ...base.jobs[0]!, skill: 'plumbing' }] }],
    ['extra field', { ...base, extra: 1 }],
    ['fractional minute', { ...base, jobs: [{ ...base.jobs[0]!, durationMin: 30.5 }] }],
  ])('rejects %s', (_, problem) => {
    expect(Problem.safeParse(problem).success).toBe(false);
  });
});
