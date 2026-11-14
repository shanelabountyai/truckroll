import { describe, expect, it } from 'vitest';
import { checkPlan, type CheckCode } from '@/lib/dispatch/check';
import type { Plan } from '@/lib/dispatch/contract';
import { expectationFailures, fixtures, goldenPlan } from './helpers';

// The oracle against committed golden plans (no Python needed), then planted defects: each must be caught by its code.
const fx = (name: string) => fixtures.find((f) => f.name === name)!;
const clone = (p: Plan): Plan => structuredClone(p);
const codes = (problem: unknown, plan: Plan) => checkPlan(problem, plan).errors.map((e) => e.code);

describe('checker on golden plans', () => {
  it.each(fixtures.map((f) => [f.name, f]))('%s passes and meets its expectations', (_, f) => {
    const plan = goldenPlan(f.name);
    const res = checkPlan(f.problem, plan);
    expect(res.errors).toEqual([]);
    expect(expectationFailures(f.expect, plan)).toEqual([]);
  });
});

describe('checker catches planted defects', () => {
  const demo = fx('03-demo-day');
  const busy = () => {
    const plan = clone(goldenPlan(demo.name));
    const r = plan.routes.find((x) => x.stops.length >= 2)!;
    return { plan, r };
  };
  const cases: [string, CheckCode, () => Plan][] = [
    ['a job dropped from the plan entirely', 'missing-job', () => { const { plan, r } = busy(); r.stops.pop(); return plan; }],
    ['a job routed twice', 'duplicate-job', () => { const { plan, r } = busy(); plan.unassigned.push({ jobId: r.stops[0]!.jobId, reasons: ['over-capacity'] }); return plan; }],
    ['an invented job', 'unknown-job', () => { const plan = clone(goldenPlan(demo.name)); plan.unassigned.push({ jobId: 'ghost', reasons: ['no-skill'] }); return plan; }],
    ['a seq gap', 'seq', () => { const { plan, r } = busy(); r.stops[1]!.seq = 5; return plan; }],
    ['a wrong drive', 'drive-mismatch', () => { const { plan, r } = busy(); r.stops[0]!.driveMin += 1; return plan; }],
    ['an arrival that ignores the drive', 'time-mismatch', () => { const { plan, r } = busy(); r.stops[1]!.arrival -= 1; return plan; }],
    ['a wrong objective', 'objective-mismatch', () => { const plan = clone(goldenPlan(demo.name)); plan.objective.driveMin += 1; return plan; }],
    ['a route for a tech who does not exist', 'unknown-tech', () => { const plan = clone(goldenPlan(demo.name)); plan.routes[0]!.techId = 'ZZ'; return plan; }],
    ['a missing lunch', 'lunch-missing', () => { const { plan, r } = busy(); r.lunch = null; return plan; }],
    ['lunch outside its window', 'lunch-window', () => { const { plan, r } = busy(); r.lunch = { ...r.lunch!, start: 600, end: 630 }; return plan; }],
    ['lunch of the wrong length', 'lunch-window', () => { const { plan, r } = busy(); r.lunch = { ...r.lunch!, end: r.lunch!.start + 20 }; return plan; }],
    ['a wrong date', 'date-mismatch', () => { const plan = clone(goldenPlan(demo.name)); plan.date = '2026-11-17'; return plan; }],
  ];
  it.each(cases)('%s → %s', (_, code, make) => {
    expect(codes(demo.problem, make())).toContain(code);
  });

  it('a start before the window → early-start', () => {
    const f = fx('04-tight-windows');
    const plan = clone(goldenPlan(f.name));
    const s = plan.routes[0]!.stops[0]!;
    s.start = s.arrival;
    s.slackMin = 0;
    s.end = s.start + 60;
    expect(codes(f.problem, plan)).toContain('early-start');
  });

  it('a stop on a tech without the skill → skill (TR-01 negative control)', () => {
    const f = fx('02-skill-split');
    const plan = clone(goldenPlan(f.name));
    const [a, b] = plan.routes;
    // swap the two techs' routes wholesale: same shape, every stop now on the wrong-skilled tech
    [a!.techId, b!.techId] = [b!.techId, a!.techId];
    expect(codes(f.problem, plan)).toContain('skill');
  });

  it('a pinned job on another tech → pin-tech', () => {
    const f = fx('11-pinned-job');
    const plan = clone(goldenPlan(f.name));
    const q = plan.routes.find((r) => r.techId === 'Q1')!;
    const m = plan.routes.find((r) => r.techId === 'M1')!;
    [q.techId, m.techId] = [m.techId, q.techId];
    expect(codes(f.problem, plan)).toContain('pin-tech');
  });

  it('a pinned position not honoured → pin-position', () => {
    const f = fx('12-pinned-position');
    const plan = clone(goldenPlan(f.name));
    const stops = plan.routes[0]!.stops;
    stops.reverse().forEach((s, i) => (s.seq = i + 1));
    expect(codes(f.problem, plan)).toContain('pin-position');
  });

  it('too many stops for maxJobs → capacity', () => {
    const f = fx('07-max-jobs');
    const problem = structuredClone(f.problem);
    problem.techs[0]!.maxJobs = 1;
    expect(codes(problem, goldenPlan(f.name))).toContain('capacity');
  });

  it('home after the shift ends → shift-end', () => {
    const f = fx('10-over-capacity');
    const problem = structuredClone(f.problem);
    problem.techs[0]!.shiftEnd = goldenPlan(f.name).routes[0]!.returnAt - 1;
    problem.techs[0]!.lunch.latest = Math.min(problem.techs[0]!.lunch.latest, problem.techs[0]!.shiftEnd - 30);
    expect(codes(problem, goldenPlan(f.name))).toContain('shift-end');
  });

  it('lateness over the cap → too-late', () => {
    const f = fx('13-late-but-ok');
    expect(codes({ ...f.problem, maxLateMin: 10 }, goldenPlan(f.name))).toContain('too-late');
  });

  it('a false no-skill reason → reason', () => {
    const f = fx('09-impossible-window');
    const plan = clone(goldenPlan(f.name));
    plan.unassigned[0]!.reasons = ['no-skill'];
    expect(codes(f.problem, plan)).toContain('reason');
  });

  it('garbage in → invalid-plan / invalid-problem, never a throw', () => {
    expect(codes(fx('01-single-job').problem, { nope: true } as unknown as Plan)).toEqual(['invalid-plan']);
    expect(checkPlan({ version: 2 }, goldenPlan('01-single-job')).errors.map((e) => e.code)).toEqual(['invalid-problem']);
  });
});
