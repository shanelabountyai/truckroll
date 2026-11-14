import { describe, expect, it } from 'vitest';
import { checkPlan } from '@/lib/dispatch/check';
import { Plan } from '@/lib/dispatch/contract';
import { fixtures, goldenPlan, skipWithoutSolver, solveRaw } from './helpers';

// TR-01: no stop is assigned to a tech lacking the job's required skill.
function skillViolations(f: (typeof fixtures)[number], plan: Plan): string[] {
  const techs = new Map(f.problem.techs.map((t) => [t.id, t]));
  const jobs = new Map(f.problem.jobs.map((j) => [j.id, j]));
  return plan.routes.flatMap((r) => r.stops.filter((s) => !techs.get(r.techId)!.skills.includes(jobs.get(s.jobId)!.skill)).map((s) => `${r.techId}:${s.jobId}`));
}

describe('TR-01 skills', () => {
  it('negative control: a plan with a wrong-skill stop is caught by both the direct scan and the checker', () => {
    const f = fixtures.find((x) => x.name === '02-skill-split')!;
    const plan = structuredClone(goldenPlan(f.name));
    const [a, b] = plan.routes;
    [a!.techId, b!.techId] = [b!.techId, a!.techId];
    expect(skillViolations(f, plan).length).toBeGreaterThan(0);
    expect(checkPlan(f.problem, plan).errors.some((e) => e.code === 'skill')).toBe(true);
  });

  it.each(fixtures.map((f) => [f.name, f]))('%s golden plan: no wrong-skill stop', (_, f) => {
    expect(skillViolations(f, goldenPlan(f.name))).toEqual([]);
  });

  it.skipIf(skipWithoutSolver).each(fixtures.map((f) => [f.name, f]))('%s live solver plan: no wrong-skill stop', (_, f) => {
    expect(skillViolations(f, Plan.parse(JSON.parse(solveRaw(f.problem, f.timeLimitMs))))).toEqual([]);
  });
});
