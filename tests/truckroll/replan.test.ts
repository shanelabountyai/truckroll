import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPlan } from '@/lib/dispatch/check';
import type { Plan } from '@/lib/dispatch/contract';
import { buildReplan, checkReplan, mergeReplan, ReplanError, type ReplanInput } from '@/lib/dispatch/replan';
import { ROOT, skipWithoutSolver, solveRaw, solveResult } from './helpers';
import { AS_OF, EMERGENCY, scenario } from './replan-scenario';

// Phase 3 re-plan, pure (no database): the problem it builds, the merge, and checkReplan (TR-03's verifier). The
// solver's re-plan of the 10:40 scenario is committed (fixtures/replan/demo-1040.plan.json) so the merge and checker
// tests run without Python; the live tests prove the solver still gives exactly those bytes (TR-04) and are required in CI.

const GOLDEN = join(ROOT, 'fixtures/replan/demo-1040.plan.json');
const golden = () => JSON.parse(readFileSync(GOLDEN, 'utf8')) as Plan;
const codes = (input: ReplanInput, solved: Plan, merged: unknown) => checkReplan(input, buildReplan(input), solved, merged).map((e) => e.code);
const route = (p: Plan, techId: string) => p.routes.find((r) => r.techId === techId)!;

describe('buildReplan: the problem a 10:40 re-plan sends to the solver', () => {
  const s = scenario();
  const b = buildReplan(s);
  const tech = (id: string) => b.problem.techs.find((t) => t.id === id)!;

  it('sends only open work: started and finished jobs stay out, the emergency goes in', () => {
    const ids = b.problem.jobs.map((j) => j.id);
    for (const id of ['J11', 'J01', 'J19', 'J02', 'J24', 'J22', 'J06', 'J18', 'J08']) expect(ids).not.toContain(id);
    expect(ids).toContain(EMERGENCY.id);
    expect(ids).toHaveLength(25 - 9);
  });

  it('starts each tech where their statuses put them (D-40)', () => {
    const job = (id: string) => s.day.jobs.find((j) => j.id === id)!;
    // On site at J11 (planned 10:00 start, 60 min): free at 11:00 there.
    expect(tech('M1').start).toEqual({ point: job('J11').location, at: 660 });
    // Nothing started: home, free at the cut-off.
    expect(tech('M2').start).toEqual({ point: s.day.techs.find((t) => t.id === 'M2')!.home, at: AS_OF });
    // Finished J18 at 10:09: at J18, free at the cut-off.
    expect(tech('Q2').start).toEqual({ point: job('J18').location, at: AS_OF });
  });

  it('takes started stops off the capacity', () => {
    expect(tech('M1').maxJobs).toBe(8 - 1);
    expect(tech('M3').maxJobs).toBe(8 - 2);
    expect(tech('Q1').maxJobs).toBe(8 - 3);
    expect(tech('M2').maxJobs).toBe(8);
  });

  it('keeps pins, counting positions from the first stop of the day (D-43)', () => {
    expect(b.problem.jobs.find((j) => j.id === 'J10')!.pin).toEqual({ techId: 'Q1', position: 4 - 3 });
    expect(b.problem.jobs.find((j) => j.id === 'J05')!.pin).toEqual({ techId: 'M1' });
    expect(b.conflicts).toEqual([]);
  });

  it('is deterministic: the same state gives the same JSON (TR-04)', () => {
    expect(JSON.stringify(buildReplan(scenario()).problem)).toBe(JSON.stringify(b.problem));
  });

  it('marks lunch taken when the plan’s lunch began before the cut-off, and waits for a lunch in progress (D-41)', () => {
    const late = buildReplan({ ...scenario(), asOf: 700 }); // Muskogee One's lunch was 11:30–12:00
    const m1 = late.problem.techs.find((t) => t.id === 'M1')!;
    expect(m1.lunchTaken).toBe(true);
    expect(m1.start!.at).toBe(720);
    expect(buildReplan(scenario()).problem.techs.find((t) => t.id === 'M1')!.lunchTaken).toBeUndefined();
  });

  it('gives a tech whose shift is over no more jobs', () => {
    const end = buildReplan({ ...scenario(), asOf: 1020 });
    for (const t of end.problem.techs) {
      expect(t.maxJobs).toBe(0);
      expect(t.start).toBeUndefined();
    }
  });

  it('a pinned position already filled by started work is a pin-conflict, not a moved pin (D-43, D-37)', () => {
    const s2 = scenario();
    s2.day.jobs.find((j) => j.id === 'J10')!.pin = { techId: 'Q1', position: 2 }; // Q1's stops 1–3 have started
    expect(buildReplan(s2).conflicts).toEqual([{ code: 'position-taken', jobId: 'J10', techId: 'Q1' }]);
  });

  it('refuses a day where work is underway on a job the current plan does not have', () => {
    const s3 = scenario();
    s3.status[EMERGENCY.id] = { status: 'on_site' };
    expect(() => buildReplan(s3)).toThrow(ReplanError);
  });
});

describe('mergeReplan + checkReplan on the committed solver re-plan', () => {
  const s = scenario();
  const b = buildReplan(s);
  const solved = golden();
  const merged = mergeReplan(b, solved);

  it('the committed re-plan passes the checker against the re-plan problem', () => {
    expect(checkPlan(b.problem, solved).errors).toEqual([]);
  });

  it('TR-03: started stops untouched (same tech, order, times), pins kept, the emergency placed', () => {
    expect(checkReplan(s, b, solved, merged)).toEqual([]);
    for (const base of s.base.routes) {
      const started = base.stops.filter((st) => s.status[st.jobId]!.status !== 'scheduled');
      const times = (st: Plan['routes'][number]['stops'][number]) => [st.jobId, st.arrival, st.start, st.end, st.driveMin];
      expect(route(merged, base.techId).stops.slice(0, started.length).map(times)).toEqual(started.map(times));
    }
    expect(route(merged, 'Q1').stops.find((st) => st.jobId === 'J10')!.seq).toBe(4);
    expect(route(merged, 'M1').stops.map((st) => st.jobId)).toContain('J05');
    expect(merged.routes.flatMap((r) => r.stops.map((st) => st.jobId))).toContain(EMERGENCY.id);
    expect(merged.unassigned).toEqual([]);
  });

  const planted: [string, (m: Plan) => void, string][] = [
    ['a started stop moved to another tech', (m) => { const st = route(m, 'M1').stops.shift()!; route(m, 'M2').stops.push(st); }, 'frozen-moved'],
    ['a started stop re-timed', (m) => { route(m, 'Q3').stops[0]!.start += 5; }, 'frozen-moved'],
    ['a started stop put behind new work', (m) => { const r = route(m, 'M1'); [r.stops[0], r.stops[1]] = [r.stops[1]!, r.stops[0]!]; }, 'frozen-moved'],
    ['a started stop dropped as unassigned', (m) => { const st = route(m, 'M3').stops.shift()!; m.unassigned.push({ jobId: st.jobId, reasons: ['over-capacity'] }); }, 'frozen-moved'],
    ['a pinned job moved to another position', (m) => { const r = route(m, 'Q1'); r.stops.find((st) => st.jobId === 'J10')!.seq = 5; }, 'pin-moved'],
    ['a pinned job moved to another tech', (m) => { const r = route(m, 'M1'); const i = r.stops.findIndex((st) => st.jobId === 'J05'); const [st] = r.stops.splice(i, 1); route(m, 'M2').stops.push(st!); }, 'pin-moved'],
    ['a pinned job dropped', (m) => { const r = route(m, 'M1'); const i = r.stops.findIndex((st) => st.jobId === 'J05'); r.stops.splice(i, 1); m.unassigned.push({ jobId: 'J05', reasons: ['over-capacity'] }); }, 'pin-dropped'],
    ['the emergency silently left out', (m) => { for (const r of m.routes) r.stops = r.stops.filter((st) => st.jobId !== EMERGENCY.id); }, 'missing-job'],
    ['new work that is not the checked plan', (m) => { route(m, 'Q2').stops.at(-1)!.end += 1; }, 'tail-mismatch'],
    ['not a plan at all', (m) => { (m as unknown as Record<string, unknown>).routes = 'nope'; }, 'invalid-plan'],
  ];
  it.each(planted)('%s → %s', (_, mutate, code) => {
    const m = structuredClone(merged);
    mutate(m);
    expect(codes(s, solved, m)).toContain(code);
  });
});

describe.skipIf(skipWithoutSolver)('the live solver on the 10:40 re-plan (required in CI)', () => {
  it('gives exactly the committed re-plan, byte for byte (TR-04)', () => {
    const b = buildReplan(scenario());
    const raw = solveRaw(b.problem);
    expect(JSON.parse(raw)).toEqual(golden());
    expect(solveRaw(b.problem)).toBe(raw);
  });

  it('a pin outranks an emergency: with the only free slot pinned, the emergency stays unassigned with a verified reason (D-37)', () => {
    // Everyone is full except one slot each on Muskogee One and Tahlequah One, which the pinned J05 and J10 fill.
    const s = scenario();
    for (const t of s.day.techs) {
      const started = s.base.routes.find((r) => r.techId === t.id)!.stops.filter((st) => s.status[st.jobId]!.status !== 'scheduled').length;
      t.maxJobs = started + (t.id === 'M1' || t.id === 'Q1' ? 1 : 0);
    }
    const b = buildReplan(s);
    const r = solveResult(b.problem);
    if (!('plan' in r)) throw new Error(`pin-conflict: ${r.raw}`);
    expect(checkPlan(b.problem, r.plan).errors).toEqual([]);
    const merged = mergeReplan(b, r.plan);
    expect(checkReplan(s, b, r.plan, merged)).toEqual([]);
    expect(route(merged, 'M1').stops.map((st) => st.jobId)).toEqual(['J11', 'J05']);
    expect(merged.unassigned.find((u) => u.jobId === EMERGENCY.id)).toEqual({ jobId: EMERGENCY.id, reasons: ['over-capacity'] });
    expect(merged.objective.unassignedEmergencies).toBe(merged.unassigned.filter((u) => s.day.jobs.find((j) => j.id === u.jobId)!.priority === 'emergency').length);

    // Control: unpin J05 and the emergency takes that slot instead.
    s.day.jobs.find((j) => j.id === 'J05')!.pin = undefined;
    const b2 = buildReplan(s);
    const r2 = solveResult(b2.problem);
    if (!('plan' in r2)) throw new Error('unexpected pin-conflict');
    expect(r2.plan.unassigned.map((u) => u.jobId)).not.toContain(EMERGENCY.id);
  });

  it('a pin that can’t be kept in the re-plan is the same pin-conflict Plan the day gives', () => {
    const s = scenario();
    s.day.jobs.find((j) => j.id === 'J03')!.pin = { techId: 'M1', position: 2 }; // J03 is maintenance 12:00–14:00, M1's slot 2 is J05 12:00–14:00 pinned too
    s.day.jobs.find((j) => j.id === 'J05')!.pin = { techId: 'M1', position: 2 };
    const r = solveResult(buildReplan(s).problem);
    expect('pinConflict' in r && r.pinConflict.pins.map((p) => `${p.jobId}:${p.code}`)).toEqual(['J03:position-taken', 'J05:position-taken']);
  });
});
