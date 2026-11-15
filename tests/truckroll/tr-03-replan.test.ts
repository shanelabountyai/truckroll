import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { insertEmergency, planDay, replanDay } from '@/app/o/[org]/dispatch/actions';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system';
import { checkPlan } from '@/lib/dispatch/check';
import type { Plan } from '@/lib/dispatch/contract';
import { buildProblem, savePlanIfValid } from '@/lib/dispatch/plan-store';
import * as solver from '@/lib/dispatch/solver-client';
import { dayOf } from '@/lib/dispatch/time';
import { resetAuthTables } from '../helpers/auth';
import { NavSignal } from '../helpers/next';
import { actAs, addMember, makeOrg } from '../helpers/org';
import { seedFixtureDay, translatedGolden, type Seeded } from './dispatch-db';
import { requireSolver, ROOT } from './helpers';
import { AS_OF, EMERGENCY, PINS, STATUS } from './replan-scenario';

// TR-03: a re-plan never moves a pinned job, nor a job that is on site or done (nor en route / can't complete, D-39).
// The 10:40 scenario of replan-scenario.ts, end to end through the server actions and the database. The solver is the
// real one where it runs (CI starts it before vitest and sets TRUCKROLL_REQUIRE_SOLVER=1, so there these never skip);
// planted solver answers are stubbed per test.
vi.mock('@/lib/dispatch/solver-client', async (orig) => {
  const real = await orig<typeof solver>();
  return { ...real, solveProblem: vi.fn(real.solveProblem) };
});
const solve = vi.mocked(solver.solveProblem);
const realSolve = (await vi.importActual<typeof solver>('@/lib/dispatch/solver-client')).solveProblem;
const SOLVER = (process.env.SOLVER_URL || solver.DEFAULT_SOLVER_URL).replace(/\/+$/, '');
const solverUp = await fetch(`${SOLVER}/health`).then((r) => r.ok, () => false);
if (requireSolver && !solverUp) throw new Error(`TRUCKROLL_REQUIRE_SOLVER=1 but no solver service at ${SOLVER}`);

const FIX = '03-demo-day';
let slug: string;
let orgId: string;
let seeded: Seeded;
let basePlanId: string;
let adminId: string;

const emergencyForm = { date: '2026-11-16', asOf: '10:40', ref: EMERGENCY.id, customer: EMERGENCY.customer, address: EMERGENCY.address, lat: EMERGENCY.location.lat, lng: EMERGENCY.location.lng, windowEnd: '12:40', durationMin: EMERGENCY.durationMin, skill: EMERGENCY.skill };

beforeEach(async () => {
  await resetAuthTables();
  solve.mockReset();
  solve.mockImplementation(realSolve);
  const org = await makeOrg('shop');
  [slug, orgId] = [org.slug, org.id];
  adminId = (await addMember(org.id, 'admin', 'dispatch@example.test')).id;
  seeded = await seedFixtureDay(org.id, FIX);
  for (const [ref, pin] of Object.entries(PINS))
    await db.job.update({ where: { id: seeded.job.get(ref)! }, data: { pinTechId: seeded.tech.get(pin.techId)!, pinPosition: pin.position ?? null } });
  // The day as planned (the golden plan honours both pins), then the work started by 10:40.
  const ctx = await actAs(adminId, slug);
  const res = await withOrg(ctx, async (tx) => savePlanIfValid(tx, ctx, await buildProblem(tx, orgId, seeded.date), translatedGolden(FIX, seeded)));
  if (!res.ok) throw new Error(`seed plan refused: ${res.codes}`);
  basePlanId = res.planId;
  for (const [ref, st] of Object.entries(STATUS)) await db.job.update({ where: { id: seeded.job.get(ref)! }, data: { status: st.status } });
});

async function call(fn: () => Promise<unknown>): Promise<{ error?: string; redirected?: string }> {
  try {
    return ((await fn()) ?? {}) as { error?: string };
  } catch (e) {
    if (e instanceof NavSignal && e.kind === 'redirect') return { redirected: e.to };
    throw e;
  }
}

const plans = () => db.dispatchPlan.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
const stopsOf = (planId: string) => db.planStop.findMany({ where: { orgId, planId }, orderBy: [{ techId: 'asc' }, { seq: 'asc' }] });
const started = Object.keys(STATUS);

/** The committed solver re-plan of the scenario, onto this test's rows (`e1040` = the emergency's row id). */
function translatedReplan(e1040: string): Plan {
  const g = JSON.parse(readFileSync(join(ROOT, 'fixtures/replan/demo-1040.plan.json'), 'utf8')) as Plan;
  const job = (id: string) => (id === EMERGENCY.id ? e1040 : seeded.job.get(id)!);
  for (const r of g.routes) {
    r.techId = seeded.tech.get(r.techId)!;
    for (const st of r.stops) st.jobId = job(st.jobId);
  }
  for (const u of g.unassigned) u.jobId = job(u.jobId);
  return g;
}

/** TR-03 on what is in the database: started stops identical, pins on their tech and position. */
async function expectTr03(newPlanId: string) {
  const before = new Map((await stopsOf(basePlanId)).map((s) => [s.jobId, s]));
  const after = new Map((await stopsOf(newPlanId)).map((s) => [s.jobId, s]));
  for (const ref of started) {
    const id = seeded.job.get(ref)!;
    const [b, a] = [before.get(id)!, after.get(id)];
    expect(a, `${ref} kept`).toBeDefined();
    expect({ techId: a!.techId, arrival: a!.arrival, start: a!.start, end: a!.end }, ref).toEqual({ techId: b.techId, arrival: b.arrival, start: b.start, end: b.end });
    expect((await db.job.findUniqueOrThrow({ where: { id } })).status, `${ref} status`).toBe(STATUS[ref]!.status);
  }
  // Started stops come first on each tech, in their old order.
  for (const techId of seeded.tech.values()) {
    const mine = [...after.values()].filter((s) => s.techId === techId).sort((x, y) => x.seq - y.seq);
    const k = mine.filter((s) => started.some((ref) => seeded.job.get(ref) === s.jobId)).length;
    expect(mine.slice(0, k).every((s) => started.some((ref) => seeded.job.get(ref) === s.jobId))).toBe(true);
  }
  const j10 = after.get(seeded.job.get('J10')!)!;
  expect([j10.techId, j10.seq]).toEqual([seeded.tech.get('Q1'), 4]);
  expect(after.get(seeded.job.get('J05')!)!.techId).toBe(seeded.tech.get('M1'));
}

describe.skipIf(!solverUp)('TR-03 with the real solver: the 10:40 emergency', () => {
  it('lands on a route; started jobs and pins are exactly where they were', async () => {
    const r = await call(() => insertEmergency(slug, emergencyForm));
    expect(r.error).toBeUndefined();
    expect(r.redirected).toBe(`/o/${slug}/dispatch?date=${seeded.date}&replanned=1040`);
    const all = await plans();
    expect(all).toHaveLength(2);
    const p = all[1]!;
    expect([p.asOf, p.basePlanId]).toEqual([AS_OF, basePlanId]);
    const e = await db.job.findFirstOrThrow({ where: { orgId, ref: EMERGENCY.id } });
    expect([e.priority, e.status, e.windowStart]).toEqual(['emergency', 'scheduled', AS_OF]);
    expect(await db.planStop.count({ where: { planId: p.id, jobId: e.id } })).toBe(1);
    await expectTr03(p.id);
    // The solver's part passed the checker against the stored re-plan problem (TR-02 for re-plans).
    expect(checkPlan(p.problem, p.solved).errors).toEqual([]);
    expect(await db.auditEvent.count({ where: { orgId, action: 'dispatch.replan_saved' } })).toBe(1);
  });

  it('the same day re-planned twice gives the same plan (TR-04)', async () => {
    await call(() => insertEmergency(slug, emergencyForm));
    expect((await call(() => replanDay(slug, { date: seeded.date, asOf: '10:40' }))).error).toBeUndefined();
    const [, first, second] = await plans();
    // Re-planned from the first re-plan's merged day: the same open work and starts, so the same problem and plan.
    expect(JSON.stringify(second!.problem)).toBe(JSON.stringify(first!.problem));
    expect(second!.plan).toEqual(first!.plan);
  });
});

describe('TR-03 against planted solver answers: refused, nothing written', () => {
  const planted: [string, (p: Plan) => unknown, string][] = [
    ['the pinned J10 moved off its position', (p) => {
      const q1 = p.routes.find((r) => r.techId === seeded.tech.get('Q1'))!;
      q1.stops[0]!.seq = 2; // J10 is the only open stop on Q1, pinned to its day position 4 (= 1 after 3 started)
      return p;
    }, 'pin-position'],
    ['a started job planned again', (p) => {
      const m2 = p.routes.find((r) => r.techId === seeded.tech.get('M2'))!;
      m2.stops.push({ ...m2.stops.at(-1)!, jobId: seeded.job.get('J11')!, seq: m2.stops.length + 1 });
      return p;
    }, 'unknown-job'],
    ['the emergency dropped with a made-up reason', (p) => {
      const e = p.routes.flatMap((r) => r.stops).find((s) => ![...seeded.job.values()].includes(s.jobId))!;
      for (const r of p.routes) r.stops = r.stops.filter((s) => s.jobId !== e.jobId);
      p.unassigned.push({ jobId: e.jobId, reasons: ['no-window-fit'] });
      return p;
    }, 'reason'],
    ['a false pin-conflict', () => ({ error: 'pin-conflict', pins: [{ code: 'no-window-fit', jobId: seeded.job.get('J10')!, techId: seeded.tech.get('Q1')! }], detail: 'made up' }), 'invalid-pin-conflict'],
  ];

  it.each(planted)('%s → %s', async (_, mutate, code) => {
    solve.mockImplementationOnce(async () => {
      const e = await db.job.findFirstOrThrow({ where: { orgId, ref: EMERGENCY.id } });
      return mutate(translatedReplan(e.id));
    });
    const r = await call(() => insertEmergency(slug, emergencyForm));
    expect(r.error).toContain('Emergency job E1040 was added, but the re-plan didn’t go through');
    expect(r.error).toContain(code);
    expect((await plans()).map((p) => p.id)).toEqual([basePlanId]);
    const audit = await db.auditEvent.findMany({ where: { orgId, action: 'dispatch.replan_rejected' } });
    expect(audit).toHaveLength(1);
    expect((audit[0]!.data as { codes: string[] }).codes).toContain(code);
    // The emergency is on the board, unassigned, for the dispatcher to act on.
    expect((await db.job.findFirstOrThrow({ where: { orgId, ref: EMERGENCY.id } })).status).toBe('unscheduled');
  });

  it('control: the committed re-plan, unmodified, is saved and keeps TR-03', async () => {
    solve.mockImplementationOnce(async () => translatedReplan((await db.job.findFirstOrThrow({ where: { orgId, ref: EMERGENCY.id } })).id));
    const r = await call(() => insertEmergency(slug, emergencyForm));
    expect(r.redirected).toContain('replanned=1040');
    const all = await plans();
    expect(all).toHaveLength(2);
    await expectTr03(all[1]!.id);
  });
});

describe('re-plan refusals', () => {
  it('a pin whose day position is already filled by started work → the pins message, solver not called (D-43)', async () => {
    await db.job.update({ where: { id: seeded.job.get('J10')! }, data: { pinPosition: 2 } });
    const r = await call(() => replanDay(slug, { date: seeded.date, asOf: '10:40' }));
    expect(r.error).toMatch(/pinned jobs are never moved or dropped/);
    expect(r.error).toContain("Job J10 is pinned to Tahlequah One at #2, but Tahlequah One's first 3 stop(s) have already started.");
    expect(solve).not.toHaveBeenCalled();
    expect(await plans()).toHaveLength(1);
  });

  it('a pin the rest of the day can’t hold → the same pin-conflict message as Plan the day', async () => {
    await db.technician.update({ where: { id: seeded.tech.get('Q1')! }, data: { maxJobs: 3 } }); // all 3 used by started work
    const r = await call(() => replanDay(slug, { date: seeded.date, asOf: '10:40' }));
    expect(r.error).toMatch(/can't be re-planned: pinned jobs are never moved or dropped/);
    expect(r.error).toContain('Job J10 is pinned to Tahlequah One');
    expect(solve).not.toHaveBeenCalled();
    expect(await plans()).toHaveLength(1);
  });

  it('Plan the day is refused once work has started (D-42)', async () => {
    const r = await call(() => planDay(slug, { date: seeded.date }));
    expect(r.error).toMatch(/Work has started on this day/);
    expect(await plans()).toHaveLength(1);
  });

  it('no plan yet → told to plan first', async () => {
    await db.dispatchPlan.deleteMany({ where: { orgId } });
    await db.job.updateMany({ where: { orgId }, data: { status: 'unscheduled' } });
    expect((await call(() => replanDay(slug, { date: seeded.date, asOf: '10:40' }))).error).toMatch(/Plan the day first/);
  });

  it('a status changed while the solver ran → nothing saved', async () => {
    solve.mockImplementationOnce(async () => {
      await db.job.update({ where: { id: seeded.job.get('J07')! }, data: { status: 'en_route' } });
      return { nope: 1 };
    });
    const r = await call(() => replanDay(slug, { date: seeded.date, asOf: '10:40' }));
    expect(r.error).toMatch(/The day changed while re-planning/);
    expect(await plans()).toHaveLength(1);
  });

  it('the solver being down: the emergency is kept on the board, nothing else changes', async () => {
    solve.mockRejectedValueOnce(new solver.SolverUnavailable('not reachable'));
    const r = await call(() => insertEmergency(slug, emergencyForm));
    expect(r.error).toMatch(/E1040 was added, but the re-plan didn’t go through: The planner is unavailable/);
    expect(await plans()).toHaveLength(1);
    expect(await db.job.count({ where: { orgId, date: dayOf(seeded.date), ref: EMERGENCY.id } })).toBe(1);
  });
});
