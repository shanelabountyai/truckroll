import { beforeEach, describe, expect, it, vi } from 'vitest';
import { planDay } from '@/app/o/[org]/dispatch/actions';
import { dbSystem as db } from '@/core/db/system';
import { checkPlan } from '@/lib/dispatch/check';
import * as solver from '@/lib/dispatch/solver-client';
import { resetAuthTables, signInAs } from '../helpers/auth';
import { NavSignal } from '../helpers/next';
import { addMember, makeOrg } from '../helpers/org';
import type { Plan, Reason } from '@/lib/dispatch/contract';
import { seedFixtureDay, translatedGolden, type Seeded } from './dispatch-db';
import { fixtures } from './helpers';

// TR-02: a plan the checker rejects is never persisted. The solver is stubbed so each case controls exactly what
// "the solver" returns; the real solver's plans are covered by the cross-language tests and the e2e.
vi.mock('@/lib/dispatch/solver-client', async (orig) => ({ ...(await orig<typeof solver>()), solveProblem: vi.fn() }));
const solve = vi.mocked(solver.solveProblem);

const FIX = '03-demo-day';
let slug: string;
let seeded: Seeded;
let orgId: string;

beforeEach(async () => {
  await resetAuthTables();
  solve.mockReset();
  const org = await makeOrg('shop');
  [slug, orgId] = [org.slug, org.id];
  const admin = await addMember(org.id, 'admin', 'dispatch@example.test');
  seeded = await seedFixtureDay(org.id, FIX);
  await signInAs(admin.id, { mfa: true });
});

async function run(): Promise<{ error?: string; redirected?: string }> {
  try {
    const r = await planDay(slug, { date: seeded.date });
    return (r ?? {}) as { error?: string };
  } catch (e) {
    if (e instanceof NavSignal && e.kind === 'redirect') return { redirected: e.to };
    throw e;
  }
}

const counts = async () => ({
  plans: await db.dispatchPlan.count({ where: { orgId } }),
  stops: await db.planStop.count({ where: { orgId } }),
  scheduled: await db.job.count({ where: { orgId, status: 'scheduled' } }),
});
const NOTHING = { plans: 0, stops: 0, scheduled: 0 };

/** Every stop taken off its route and listed unassigned with `reason`; routes and objective otherwise consistent. */
function dropAll(p: Plan, reason: Reason): Plan {
  const problem = fixtures.find((f) => f.name === FIX)!.problem;
  const shiftStart = new Map(problem.techs.map((t) => [seeded.tech.get(t.id)!, t.shiftStart]));
  const emergencies = new Set(problem.jobs.filter((j) => j.priority === 'emergency').map((j) => seeded.job.get(j.id)!));
  const dropped = p.routes.flatMap((r) => r.stops.map((s) => s.jobId));
  for (const r of p.routes) Object.assign(r, { stops: [], lunch: null, returnDriveMin: 0, returnAt: shiftStart.get(r.techId)! });
  p.unassigned = [...p.unassigned, ...dropped.map((jobId) => ({ jobId, reasons: [reason] }))];
  p.objective = { unassignedEmergencies: p.unassigned.filter((u) => emergencies.has(u.jobId)).length, lateMin: 0, driveMin: 0 };
  return p;
}

describe('TR-02: a plan the checker rejects is never persisted', () => {
  const planted: [string, (p: ReturnType<typeof translatedGolden>) => unknown, string][] = [
    ['a stop on a tech without the skill', (p) => {
      // move every stop of the first route that needs install onto a repair/maintenance-only tech
      const narrow = seeded.techByName.get('Muskogee Two')!;
      const from = p.routes.find((r) => r.techId !== narrow && r.stops.length)!;
      p.routes.find((r) => r.techId === narrow)!.techId = from.techId;
      from.techId = narrow;
      return p;
    }, 'skill'],
    ['a drive that does not match distance.ts', (p) => { p.routes.find((r) => r.stops.length)!.stops[0]!.driveMin += 1; return p; }, 'drive-mismatch'],
    ['a job left out entirely', (p) => { p.routes.find((r) => r.stops.length)!.stops.pop(); return p; }, 'missing-job'],
    ['output that is not a plan at all', () => ({ hello: 'world' }), 'invalid-plan'],
    // PR #1 review must-fix 2: a plan that drops jobs it had room for is refused, whatever reason it claims.
    ['every job dropped as over-capacity', (p) => dropAll(p, 'over-capacity'), 'droppable-job'],
    ['every job dropped with a made-up no-window-fit', (p) => dropAll(p, 'no-window-fit'), 'reason'],
  ];

  it.each(planted)('%s → refused, nothing written, rejection audited', async (_, mutate, code) => {
    solve.mockResolvedValueOnce(mutate(translatedGolden(FIX, seeded)));
    const r = await run();
    expect(r.error).toMatch(/failed the checks/);
    expect(r.error).toContain(code);
    expect(await counts()).toEqual(NOTHING);
    const audit = await db.auditEvent.findMany({ where: { orgId, action: 'dispatch.plan_rejected' } });
    expect(audit).toHaveLength(1);
    expect((audit[0]!.data as { codes: string[] }).codes).toContain(code);
  });

  it('negative control: the same golden plan, unmodified, is saved with its stops and statuses', async () => {
    const golden = translatedGolden(FIX, seeded);
    solve.mockResolvedValueOnce(golden);
    const r = await run();
    expect(r.redirected).toBe(`/o/${slug}/dispatch?date=${seeded.date}&saved=1`);
    const stopCount = golden.routes.reduce((n, x) => n + x.stops.length, 0);
    expect(await counts()).toEqual({ plans: 1, stops: stopCount, scheduled: stopCount });
    expect(await db.auditEvent.count({ where: { orgId, action: 'dispatch.plan_saved' } })).toBe(1);
  });

  it('the solver being down writes nothing', async () => {
    solve.mockRejectedValueOnce(new solver.SolverUnavailable('not reachable'));
    const r = await run();
    expect(r.error).toMatch(/planner is unavailable/);
    expect(await counts()).toEqual(NOTHING);
  });

  it('a job changed while the solver ran → nothing saved', async () => {
    solve.mockImplementationOnce(async () => {
      await db.job.updateMany({ where: { orgId, ref: 'J01' }, data: { durationMin: 99 } });
      return translatedGolden(FIX, seeded);
    });
    const r = await run();
    expect(r.error).toMatch(/Jobs changed while planning/);
    expect(await counts()).toEqual(NOTHING);
  });

  it('every persisted plan passes the checker against its own stored problem', async () => {
    solve.mockResolvedValueOnce(translatedGolden(FIX, seeded));
    await run();
    solve.mockResolvedValueOnce({ nope: 1 });
    await run();
    const plans = await db.dispatchPlan.findMany({ where: { orgId } });
    expect(plans).toHaveLength(1);
    for (const p of plans) expect(checkPlan(p.problem, p.plan).errors).toEqual([]);
  });
});
