import { describe, expect, it } from 'vitest';
import { checkPinConflict, checkPlan } from '@/lib/dispatch/check';
import { Problem, type PinConflictEntry, type ProblemInput } from '@/lib/dispatch/contract';
import { describePinConflicts, pinConflicts } from '@/lib/dispatch/pins';
import { skipWithoutSolver, solveResult } from './helpers';

// D-37 (Shane, 2026-11-14): pinned jobs are never dropped or moved. Pins that can't all be honoured give no plan but a
// pin-conflict naming each pin at fault; the checker derives that list itself and accepts the solver's only if it matches.

type JobIn = ProblemInput['jobs'][number];
type TechIn = ProblemInput['techs'][number];
const HOME = { lat: 35.7479, lng: -95.3697 };
const tech = (id: string, o: Partial<TechIn> = {}): TechIn => ({
  id,
  name: `Tech ${id}`,
  skills: ['repair', 'maintenance'],
  shiftStart: 480,
  shiftEnd: 1020,
  home: HOME,
  lunch: { earliest: 690, latest: 780 },
  maxJobs: 3,
  ...o,
});
const job = (id: string, o: Partial<JobIn> = {}): JobIn => ({
  id,
  customer: `Customer ${id}`,
  address: `${id} Example Rd, Synthetic OK`,
  location: { lat: 35.75229, lng: -95.29273 },
  windowStart: 480,
  windowEnd: 960,
  durationMin: 60,
  priority: 'standard',
  skill: 'repair',
  ...o,
});
const problem = (techs: TechIn[], jobs: JobIn[]): ProblemInput => ({ version: 1, date: '2026-11-16', techs, jobs });
const c = (code: PinConflictEntry['code'], jobId: string, techId = 'T1'): PinConflictEntry => ({ code, jobId, techId });

const CONFLICTS: [string, ProblemInput, PinConflictEntry[]][] = [
  ['pinned to a tech without the skill', problem([tech('T1'), tech('T2', { skills: ['install'] })], [job('J1', { skill: 'install', pin: { techId: 'T1' } })]), [c('no-skill', 'J1')]],
  // The pre-existing crash: a position past maxJobs used to abort OR-Tools. Now it is a pin-conflict.
  ['pin position 3 on a tech who takes 2 jobs', problem([tech('T1', { maxJobs: 2 })], [job('J1', { pin: { techId: 'T1', position: 3 } }), job('J2'), job('J3')]), [c('position-over-capacity', 'J1')]],
  ['pin position 9 on a tech who takes 8 jobs, alone on the day', problem([tech('T1', { maxJobs: 8 })], [job('J1', { pin: { techId: 'T1', position: 9 } })]), [c('position-over-capacity', 'J1')]],
  ['two jobs pinned to the same position', problem([tech('T1')], [job('J1', { pin: { techId: 'T1', position: 1 } }), job('J2', { pin: { techId: 'T1', position: 1 } })]), [c('position-taken', 'J1'), c('position-taken', 'J2')]],
  ['more pins than maxJobs', problem([tech('T1', { maxJobs: 1 })], [job('J1', { pin: { techId: 'T1' } }), job('J2', { pin: { techId: 'T1' } })]), [c('over-capacity', 'J1'), c('over-capacity', 'J2')]],
  ['a pin on a tech who takes no jobs', problem([tech('T1', { maxJobs: 0 })], [job('J1', { pin: { techId: 'T1' } })]), [c('over-capacity', 'J1')]],
  ['a pin the tech cannot reach inside its window', problem([tech('T1')], [job('J1', { windowStart: 300, windowEnd: 330, pin: { techId: 'T1' } })]), [c('no-window-fit', 'J1')]],
  [
    'two pins that each fit alone but not together inside their windows',
    problem([tech('T1'), tech('T2')], [job('J1', { windowStart: 540, windowEnd: 555, pin: { techId: 'T1' } }), job('J2', { windowStart: 540, windowEnd: 555, pin: { techId: 'T1' } }), job('J3')]),
    [c('infeasible-together', 'J1'), c('infeasible-together', 'J2')],
  ],
  ['a pin at position 2 with nothing to go first', problem([tech('T1')], [job('J1', { pin: { techId: 'T1', position: 2 } })]), [c('infeasible-together', 'J1')]],
  [
    'every kind of static conflict at once, in the solver order',
    problem(
      [tech('T1', { maxJobs: 1 }), tech('T2', { skills: ['install'] })],
      [job('A', { skill: 'install', pin: { techId: 'T1', position: 2 } }), job('B', { pin: { techId: 'T1', position: 2 } }), job('C', { windowStart: 300, windowEnd: 300, pin: { techId: 'T1' } })],
    ),
    [c('no-skill', 'A'), c('position-over-capacity', 'A'), c('position-over-capacity', 'B'), c('no-window-fit', 'C'), c('position-taken', 'A'), c('position-taken', 'B'), c('over-capacity', 'A'), c('over-capacity', 'B'), c('over-capacity', 'C')],
  ],
];

const HONOURABLE: [string, ProblemInput][] = [
  ['a pin at position 2 with an unpinned job to go first', problem([tech('T1')], [job('J1', { pin: { techId: 'T1', position: 2 } }), job('J2', { windowStart: 480, windowEnd: 600 })])],
  ['pins on two techs, one positioned', problem([tech('T1'), tech('T2')], [job('J1', { pin: { techId: 'T1', position: 1 } }), job('J2', { pin: { techId: 'T2' } }), job('J3'), job('J4')])],
];

describe('pin conflicts: the checker’s own derivation (no Python)', () => {
  it.each(CONFLICTS)('%s', (_, p, want) => {
    expect(pinConflicts(Problem.parse(p))).toEqual(want);
  });
  it.each(HONOURABLE)('honourable: %s', (_, p) => {
    expect(pinConflicts(Problem.parse(p))).toEqual([]);
  });

  it('checkPinConflict accepts exactly the right list and rejects anything else', () => {
    const [, p, want] = CONFLICTS[0]!;
    const answer = (pins: PinConflictEntry[]) => ({ error: 'pin-conflict', pins, detail: 'x' });
    expect(checkPinConflict(p, answer(want))).toEqual({ ok: true, errors: [] });
    expect(checkPinConflict(p, answer([c('no-window-fit', 'J1')])).errors.map((e) => e.code)).toEqual(['invalid-pin-conflict']);
    expect(checkPinConflict(p, answer([...want, c('over-capacity', 'J1')])).ok).toBe(false);
    expect(checkPinConflict(p, { error: 'pin-conflict', pins: [] }).errors.map((e) => e.code)).toEqual(['invalid-pin-conflict']);
    // a pin-conflict for a day whose pins can all be honoured is a solver bug, never accepted
    const [, ok] = HONOURABLE[0]!;
    const res = checkPinConflict(ok, answer([c('infeasible-together', 'J1')]));
    expect(res.ok).toBe(false);
    expect(res.errors[0]!.message).toMatch(/every pin can be honoured/);
  });

  it('no plan is valid for a problem with a pin conflict → pin-conflict (plus the pin-dropped it would need)', () => {
    const [, p] = CONFLICTS[0]!;
    const plan = { version: 1, date: '2026-11-16', routes: [{ techId: 'T1', stops: [], lunch: null, returnDriveMin: 0, returnAt: 480 }, { techId: 'T2', stops: [], lunch: null, returnDriveMin: 0, returnAt: 480 }], unassigned: [{ jobId: 'J1', reasons: ['no-skill'] }], objective: { unassignedEmergencies: 0, lateMin: 0, driveMin: 0 }, stoppedBy: 'trivial' };
    expect(checkPlan(p, plan).errors.map((e) => e.code).sort()).toEqual(['pin-conflict', 'pin-dropped']);
  });

  it('describes each conflict in a plain sentence with the tech’s name', () => {
    const [, p, want] = CONFLICTS[1]!;
    expect(describePinConflicts(Problem.parse(p), want)).toEqual(['J1 is pinned to Tech T1 at #3, but Tech T1 takes at most 2 jobs.']);
  });
});

describe.skipIf(skipWithoutSolver)('pin conflicts through the live solver (cli.py, the POST /solve code path)', () => {
  it.each(CONFLICTS)('%s → pin-conflict, verified by the checker', (_, p, want) => {
    const r = solveResult(p);
    if (!('pinConflict' in r)) throw new Error(`expected a pin-conflict, got a plan: ${r.raw}`);
    expect(r.pinConflict.pins).toEqual(want);
    expect(checkPinConflict(p, r.pinConflict)).toEqual({ ok: true, errors: [] });
    expect(solveResult(p).raw).toBe(r.raw); // TR-04 holds for the error too
  });

  it.each(HONOURABLE)('honourable: %s → a plan with every pin where it was pinned', (_, p) => {
    const r = solveResult(p);
    if (!('plan' in r)) throw new Error(`expected a plan, got ${r.raw}`);
    expect(checkPlan(p, r.plan).errors).toEqual([]);
    for (const j of p.jobs.filter((x) => x.pin)) {
      const route = r.plan.routes.find((x) => x.techId === j.pin!.techId)!;
      const stop = route.stops.find((s) => s.jobId === j.id);
      expect(stop).toBeDefined();
      if (j.pin!.position) expect(stop!.seq).toBe(j.pin!.position);
    }
  });
});
