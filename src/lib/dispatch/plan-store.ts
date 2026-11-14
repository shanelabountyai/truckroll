import { audit } from '@/core/audit';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import type { Prisma } from '@/generated/prisma/client';
import { checkPinConflict, checkPlan } from './check';
import { PinConflictError, Problem, type PinConflictEntry, type Plan, type ProblemInput } from './contract';
import { describePinConflicts, pinConflicts } from './pins';
import { dayOf } from './time';

// The database side of planning (Phase 2): build a solver Problem from an org's day, and save a plan only after the
// checker passed it (TR-02). Everything here runs inside the caller's withOrg transaction.

/**
 * The org's dispatch lock, held to the end of the caller's transaction. Every dispatch write takes it, so planDay's
 * "did the day change while the solver ran?" re-read and its save are atomic against concurrent edits (D-28).
 */
export async function lockDispatch(tx: Tx, orgId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`truckroll:dispatch:${orgId}`}, 0))) AS l`;
}

/** Jobs a plan covers: everything on the day not already underway or finished (re-plan freezing is Phase 3). */
export const PLANNABLE = ['unscheduled', 'scheduled'] as const;

export async function buildProblem(tx: Tx, orgId: string, date: string): Promise<ProblemInput> {
  const day = dayOf(date);
  const [techs, jobs] = await Promise.all([
    tx.technician.findMany({ where: { orgId }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
    tx.job.findMany({ where: { orgId, date: day, status: { in: [...PLANNABLE] } }, orderBy: [{ ref: 'asc' }, { id: 'asc' }] }),
  ]);
  const problem: ProblemInput = {
    version: 1,
    date,
    techs: techs.map((t) => ({
      id: t.id,
      name: t.name,
      skills: t.skills as ProblemInput['techs'][number]['skills'],
      shiftStart: t.shiftStart,
      shiftEnd: t.shiftEnd,
      home: { lat: t.homeLat, lng: t.homeLng },
      lunch: { earliest: t.lunchEarliest, latest: t.lunchLatest },
      maxJobs: t.maxJobs,
    })),
    jobs: jobs.map((j) => ({
      id: j.id,
      customer: j.customer,
      address: j.address,
      location: { lat: j.lat, lng: j.lng },
      windowStart: j.windowStart,
      windowEnd: j.windowEnd,
      durationMin: j.durationMin,
      skill: j.skill as ProblemInput['jobs'][number]['skill'],
      priority: j.priority,
      ...(j.pinTechId ? { pin: { techId: j.pinTechId, ...(j.pinPosition ? { position: j.pinPosition } : {}) } } : {}),
    })),
  };
  const parsed = Problem.safeParse(problem);
  if (!parsed.success) throw new Refused(`This day can't be planned yet: ${parsed.error.issues[0]?.message ?? 'invalid data'}.`);
  if (!problem.jobs.length) throw new Refused('No jobs to plan on this day.');
  if (!problem.techs.length) throw new Refused('Add a technician first.');
  return problem;
}

export type SaveResult = { ok: true; planId: string } | { ok: false; codes: string[]; pinConflict?: string };

/**
 * D-37: pinned jobs are never dropped or moved, so when the day's pins can't all be kept there is no plan. One
 * message for the dispatcher naming each pin to change, with job numbers. Null when the pins are fine.
 */
export async function pinConflictMessage(tx: Tx, orgId: string, problem: ProblemInput, pins?: PinConflictEntry[]): Promise<string | null> {
  const parsed = Problem.parse(problem);
  const list = pins ?? pinConflicts(parsed);
  if (!list.length) return null;
  const refs = new Map((await tx.job.findMany({ where: { orgId, id: { in: list.map((p) => p.jobId) } }, select: { id: true, ref: true } })).map((j) => [j.id, j.ref]));
  const lines = describePinConflicts(parsed, list, (id) => `Job ${refs.get(id) ?? id}`);
  return `This day can't be planned: pinned jobs are never moved or dropped, and these pins can't all be kept. ${[...new Set(lines)].join(' ')} Change or remove those pins, then plan again. Nothing was saved.`;
}

/**
 * TR-02: the checker decides. A rejected plan writes nothing but an audit row naming the checker's codes.
 * An accepted one writes the plan, its stops and the job statuses together.
 */
export async function savePlanIfValid(tx: Tx, ctx: OrgCtx, problem: ProblemInput, solverOutput: unknown): Promise<SaveResult> {
  // D-37: the solver's pin-conflict answer (no plan). Verified, never trusted: it must name exactly the pins the checker
  // finds at fault. Either way nothing is saved but the audit row.
  const conflict = PinConflictError.safeParse(solverOutput);
  if (conflict.success) {
    const verdict = checkPinConflict(problem, conflict.data);
    const codes = verdict.ok ? ['pin-conflict'] : ['invalid-pin-conflict'];
    await audit(ctx, 'dispatch.plan_rejected', { targetType: 'day', targetId: problem.date, data: { codes, pins: conflict.data.pins.slice(0, 20), errors: verdict.errors.map((e) => e.message) } }, tx);
    if (!verdict.ok) return { ok: false, codes };
    return { ok: false, codes, pinConflict: (await pinConflictMessage(tx, ctx.orgId, problem, conflict.data.pins))! };
  }
  const res = checkPlan(problem, solverOutput);
  if (!res.ok || !res.metrics) {
    const codes = [...new Set(res.errors.map((e) => e.code))].sort();
    await audit(ctx, 'dispatch.plan_rejected', { targetType: 'day', targetId: problem.date, data: { codes, errors: res.errors.slice(0, 20).map((e) => e.message) } }, tx);
    return { ok: false, codes };
  }
  const plan = solverOutput as Plan; // checkPlan parsed it with the zod schema
  const day = dayOf(problem.date);
  const saved = await tx.dispatchPlan.create({
    data: {
      ...inOrg(ctx),
      date: day,
      createdById: ctx.userId,
      problem: problem as unknown as Prisma.InputJsonValue,
      plan: plan as unknown as Prisma.InputJsonValue,
      metrics: res.metrics as unknown as Prisma.InputJsonValue,
      driveMin: plan.objective.driveMin,
      lateMin: plan.objective.lateMin,
      unassignedCount: plan.unassigned.length,
      stoppedBy: plan.stoppedBy,
    },
  });
  const stops = plan.routes.flatMap((r) =>
    r.stops.map((s) => ({ ...inOrg(ctx), planId: saved.id, techId: r.techId, jobId: s.jobId, seq: s.seq, arrival: s.arrival, start: s.start, end: s.end, driveMin: s.driveMin, slackMin: s.slackMin, lateMin: s.lateMin })),
  );
  if (stops.length) await tx.planStop.createMany({ data: stops });
  const routed = stops.map((s) => s.jobId);
  const planned = problem.jobs.map((j) => j.id);
  await tx.job.updateMany({ where: { ...inOrg(ctx), id: { in: routed } }, data: { status: 'scheduled' } });
  await tx.job.updateMany({ where: { ...inOrg(ctx), id: { in: planned.filter((id) => !routed.includes(id)) } }, data: { status: 'unscheduled' } });
  await audit(ctx, 'dispatch.plan_saved', { targetType: 'dispatchPlan', targetId: saved.id, data: { date: problem.date, stops: stops.length, unassigned: plan.unassigned.length } }, tx);
  return { ok: true, planId: saved.id };
}

/** The newest saved plan for a day, or null. */
export async function currentPlan(tx: Tx, orgId: string, date: string) {
  return tx.dispatchPlan.findFirst({ where: { orgId, date: dayOf(date) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
}
