import { describe, expect, it } from 'vitest';
import { checkPlan, type CheckCode } from '@/lib/dispatch/check';
import { LUNCH_MINUTES, Problem, type Job, type Plan, type Reason, type Route, type Tech } from '@/lib/dispatch/contract';
import { driveMinutes } from '@/lib/dispatch/distance';
import type { Fixture } from '../../scripts/truckroll/gen-fixtures';
import { expectationFailures, fixtures, goldenPlan } from './helpers';

// The oracle against committed golden plans (no Python needed), then planted defects: each must be caught by its code.
const fx = (name: string) => fixtures.find((f) => f.name === name)!;
const clone = (p: Plan): Plan => structuredClone(p);
const codes = (problem: unknown, plan: Plan) => checkPlan(problem, plan).errors.map((e) => e.code);

/** Earliest-start timing of a stop order with lunch in gap `gap`, taken as early as allowed (PHASE1_PLAN "Model"). */
const timeRoute = (t: Tech, order: Job[], gap: number | null): Route => {
  const s0 = t.start ?? { point: t.home, at: t.shiftStart };
  let free = s0.at;
  let pos = s0.point;
  let lunch: Route['lunch'] = null;
  const place = (d: number, ws: number | null) => {
    const ls = Math.max(free, t.lunch.earliest, s0.at);
    const arrival = ls <= free + d ? free + d + LUNCH_MINUTES : free + d;
    let ready = ls > free + d ? Math.max(arrival, ls + LUNCH_MINUTES) : arrival;
    if (ws !== null) ready = Math.max(ready, ws);
    return { ls, arrival, ready };
  };
  const stops = order.map((j, i) => {
    const d = driveMinutes(pos, j.location);
    let arrival = free + d;
    let start = Math.max(arrival, j.windowStart);
    if (gap === i) {
      const p = place(d, j.windowStart);
      lunch = { start: p.ls, end: p.ls + LUNCH_MINUTES, afterSeq: i };
      [arrival, start] = [p.arrival, p.ready];
    }
    free = start + j.durationMin;
    pos = j.location;
    return { jobId: j.id, seq: i + 1, driveMin: d, arrival, start, end: free, slackMin: start - arrival, lateMin: Math.max(0, start - j.windowEnd) };
  });
  const back = driveMinutes(pos, t.home);
  let returnAt = free + back;
  if (gap === order.length) {
    const p = place(back, null);
    lunch = { start: p.ls, end: p.ls + LUNCH_MINUTES, afterSeq: order.length };
    returnAt = p.arrival;
  }
  return { techId: t.id, stops, lunch, returnDriveMin: back, returnAt };
};

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

  // D-36 (Shane, 2026-11-14): no lateness. The would-be-late job, put on the route anyway with honest times, is caught.
  it('a stop that starts after its window ends → too-late, and nothing else', () => {
    const f = fx('13-would-be-late');
    const problem = Problem.parse(f.problem);
    const golden = goldenPlan(f.name);
    const t = problem.techs[0]!;
    const order = ['J1', 'J2'].map((id) => problem.jobs.find((j) => j.id === id)!);
    const late = timeRoute(t, order, order.length); // J1 at 09:00, J2 straight after it (past 09:15), lunch at the end
    expect(late.stops[1]!.lateMin).toBeGreaterThan(0);
    const plan: Plan = { ...golden, routes: [late], unassigned: [], objective: { ...golden.objective, lateMin: late.stops[1]!.lateMin, driveMin: late.returnDriveMin + late.stops.reduce((a, s) => a + s.driveMin, 0) } };
    const res = checkPlan(f.problem, plan);
    expect(res.errors.map((e) => [e.code, e.jobId])).toEqual([['too-late', late.stops[1]!.jobId]]);
  });

  it('a would-be-late job left unassigned → passes, and its over-capacity reason is verified', () => {
    const f = fx('13-would-be-late');
    const golden = goldenPlan(f.name);
    expect(golden.unassigned).toEqual([{ jobId: expect.any(String), reasons: ['over-capacity'] }]);
    expect(golden.objective.lateMin).toBe(0);
    expect(checkPlan(f.problem, golden).errors).toEqual([]);
    // the same plan claiming the job can't be done alone in its window is rejected: it can
    const wrong = clone(golden);
    wrong.unassigned[0]!.reasons = ['no-window-fit'];
    expect(codes(f.problem, wrong)).toEqual(['reason']);
  });

  it('a false no-skill reason → reason', () => {
    const f = fx('09-impossible-window');
    const plan = clone(goldenPlan(f.name));
    plan.unassigned[0]!.reasons = ['no-skill'];
    expect(codes(f.problem, plan)).toContain('reason');
  });

  // PR #1 review, must-fix 2: a plan that drops work it could have done must not pass.
  it('dropping every job of the demo day with a made-up reason → droppable-job / reason, never ok', () => {
    const f = fx('03-demo-day');
    const plan = clone(goldenPlan(f.name));
    const all = plan.routes.flatMap((r) => r.stops.map((s) => s.jobId));
    for (const r of plan.routes) {
      r.stops = [];
      r.lunch = null;
      r.returnDriveMin = 0;
      r.returnAt = r.techId ? f.problem.techs.find((t) => t.id === r.techId)!.shiftStart : 0;
    }
    plan.unassigned = all.map((jobId, i) => ({ jobId, reasons: [i % 2 ? 'over-capacity' : 'no-window-fit'] }));
    plan.objective = { unassignedEmergencies: f.problem.jobs.filter((j) => j.priority === 'emergency').length, lateMin: 0, driveMin: 0 };
    const res = checkPlan(f.problem, plan);
    expect(res.ok).toBe(false);
    const byCode = (c: CheckCode) => res.errors.filter((e) => e.code === c).length;
    expect(byCode('droppable-job') + byCode('reason')).toBe(all.length); // every dropped job is called out
  });

  it('a pinned job dropped as over-capacity when its tech has room → pin-dropped (D-37)', () => {
    const f = fx('11-pinned-job');
    const plan = clone(goldenPlan(f.name));
    const q = plan.routes.find((r) => r.techId === 'Q1')!;
    const idx = q.stops.findIndex((s) => s.jobId === 'J1');
    // The route's times no longer line up after the splice either (other codes); the point here is J1's own verdict.
    q.stops.splice(idx, 1);
    plan.unassigned.push({ jobId: 'J1', reasons: ['over-capacity'] });
    expect(codes(f.problem, plan)).toContain('pin-dropped');
  });

  it('the wrong reason for a job no one can do alone → reason', () => {
    const f = fx('09-impossible-window');
    const plan = clone(goldenPlan(f.name));
    plan.unassigned[0]!.reasons = ['over-capacity'];
    expect(codes(f.problem, plan)).toContain('reason');
  });

  it('garbage in → invalid-plan / invalid-problem, never a throw', () => {
    expect(codes(fx('01-single-job').problem, { nope: true } as unknown as Plan)).toEqual(['invalid-plan']);
    expect(checkPlan({ version: 2 }, goldenPlan('01-single-job')).errors.map((e) => e.code)).toEqual(['invalid-problem']);
  });
});

// Phase 3, D-41: a re-plan for a tech who already took lunch owes none on the rest of the route.
describe('lunchTaken (re-plan)', () => {
  it('the golden plan passes with no lunch on T1; without lunchTaken the same plan is lunch-missing', () => {
    const f = fx('17-replan-lunch-taken');
    expect(codes(f.problem, goldenPlan(f.name))).toEqual([]);
    const owed = structuredClone(f.problem);
    delete owed.techs[0]!.lunchTaken;
    expect(codes(owed, goldenPlan(f.name))).toContain('lunch-missing');
  });
});

// PR #1 review must-fix 2, with plans that are otherwise valid (empty routes, or the route re-timed without the job), so
// only the unassigned verdicts can fail them: a made-up reason is `reason`, a false `over-capacity` is `droppable-job`.
describe('checker rejects plans that drop jobs (otherwise-valid plans)', () => {
  const DROP_CODES = ['droppable-job', 'reason', 'pin-dropped'];
  const REASONS = ['no-skill', 'no-window-fit', 'over-capacity'] as const;
  const objectiveOf = (problem: Problem, routes: Plan['routes'], unassigned: Plan['unassigned']): Plan['objective'] => ({
    unassignedEmergencies: unassigned.filter((u) => problem.jobs.find((j) => j.id === u.jobId)?.priority === 'emergency').length,
    lateMin: routes.reduce((a, r) => a + r.stops.reduce((b, s) => b + s.lateMin, 0), 0),
    driveMin: routes.reduce((a, r) => a + r.returnDriveMin + r.stops.reduce((b, s) => b + s.driveMin, 0), 0),
  });
  const dropAll = (f: Fixture, reason: Reason): Plan => {
    const problem = Problem.parse(f.problem);
    const routes = problem.techs.map((t) => ({ techId: t.id, stops: [], lunch: null, returnDriveMin: 0, returnAt: t.start?.at ?? t.shiftStart }));
    const unassigned = problem.jobs.map((j) => ({ jobId: j.id, reasons: [reason] }));
    return { version: 1, date: problem.date, routes, unassigned, objective: objectiveOf(problem, routes, unassigned), stoppedBy: 'local-optimum' };
  };
  /** The golden plan with one job taken off its route, re-timed so only the unassigned verdicts can be wrong. */
  const dropOne = (f: Fixture, jobId: string, reason: Reason): Plan => {
    const golden = goldenPlan(f.name);
    const problem = Problem.parse(f.problem);
    const jobs = new Map(problem.jobs.map((j) => [j.id, j]));
    const r = golden.routes.find((x) => x.stops.some((s) => s.jobId === jobId))!;
    const t = problem.techs.find((x) => x.id === r.techId)!;
    const order = r.stops.filter((s) => s.jobId !== jobId).map((s) => jobs.get(s.jobId)!);
    for (const g of order.length ? [...order.keys(), order.length] : [null]) {
      const routes = golden.routes.map((y) => (y.techId === t.id ? timeRoute(t, order, g) : y));
      const unassigned = [...golden.unassigned, { jobId, reasons: [reason] }];
      const plan: Plan = { ...golden, routes, unassigned, objective: objectiveOf(problem, routes, unassigned) };
      if (checkPlan(f.problem, plan).errors.every((e) => DROP_CODES.includes(e.code))) return plan;
    }
    throw new Error(`could not re-time ${t.id} without ${jobId}`);
  };
  const verdict = (f: Fixture, plan: Plan, jobId: string) => {
    const res = checkPlan(f.problem, plan);
    return { ok: res.ok, onlyDropCodes: res.errors.every((e) => DROP_CODES.includes(e.code)), jobFlagged: res.errors.some((e) => e.jobId === jobId) };
  };

  it.each(REASONS)('every demo-day job dropped as %s → rejected, each job flagged, nothing else wrong', (reason) => {
    const f = fx('03-demo-day');
    const res = checkPlan(f.problem, dropAll(f, reason));
    expect(res.ok).toBe(false);
    expect(res.errors.every((e) => DROP_CODES.includes(e.code))).toBe(true);
    expect(new Set(res.errors.map((e) => e.jobId)).size).toBe(f.problem.jobs.length);
  });

  it.each(REASONS)('an emergency dropped although it fits, claimed %s → rejected', (reason) => {
    const f = fx('05-emergency-first');
    const golden = goldenPlan(f.name);
    const em = golden.routes.flatMap((r) => r.stops).map((s) => f.problem.jobs.find((j) => j.id === s.jobId)!).find((j) => j.priority === 'emergency')!;
    const plan = dropOne(f, em.id, reason);
    expect(plan.objective.unassignedEmergencies).toBe(golden.objective.unassignedEmergencies + 1);
    expect(verdict(f, plan, em.id)).toEqual({ ok: false, onlyDropCodes: true, jobFlagged: true });
  });

  // D-37: a pinned job is never dropped, whatever the reason; the plan is otherwise valid, so only pin-dropped fires.
  it.each(REASONS)('a pinned job dropped with %s → pin-dropped, nothing else', (reason) => {
    const f = fx('11-pinned-job');
    const pinned = f.problem.jobs.find((j) => j.pin)!;
    const res = checkPlan(f.problem, dropOne(f, pinned.id, reason));
    expect(res.errors.map((e) => [e.code, e.jobId])).toEqual([['pin-dropped', pinned.id]]);
  });

  it('a pinned job dropped even when its tech is full → pin-dropped (pins outrank emergencies)', () => {
    const f = fx('16-pin-never-dropped');
    const plan = dropOne(f, 'J1', 'over-capacity');
    expect(codes(f.problem, plan)).toContain('pin-dropped');
  });

  it('control: the golden over-capacity plan still passes', () => {
    expect(checkPlan(fx('10-over-capacity').problem, goldenPlan('10-over-capacity')).errors).toEqual([]);
  });
});
