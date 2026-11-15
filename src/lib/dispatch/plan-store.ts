import { audit } from '@/core/audit';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import type { Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import type { Prisma } from '@/generated/prisma/client';
import { checkPinConflict, checkPlan } from './check';
import { PinConflictError, Plan as PlanSchema, Problem, type PinConflictEntry, type Plan, type ProblemInput } from './contract';
import { computeMetrics, type PlanMetrics } from './metrics';
import { describePinConflicts, pinConflicts } from './pins';
import { buildReplan, checkReplan, FROZEN, mergeReplan, ReplanError, type JobState, type ReplanBuild, type ReplanInput } from './replan';
import { dayOf, hhmm, localMinuteOn } from './time';

// The database side of planning (Phase 2): build a solver Problem from an org's day, and save a plan only after the
// checker passed it (TR-02). Everything here runs inside the caller's withOrg transaction.

/**
 * The org's dispatch lock, held to the end of the caller's transaction. Every dispatch write takes it, so planDay's
 * "did the day change while the solver ran?" re-read and its save are atomic against concurrent edits (D-28).
 */
export async function lockDispatch(tx: Tx, orgId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`truckroll:dispatch:${orgId}`}, 0))) AS l`;
}

/** Jobs a whole-day plan covers: everything on the day not already underway or finished (a re-plan keeps those, Phase 3). */
export const PLANNABLE = ['unscheduled', 'scheduled'] as const;

type TechRow = Awaited<ReturnType<Tx['technician']['findMany']>>[number];
type JobRow = Awaited<ReturnType<Tx['job']['findMany']>>[number];

function toProblem(date: string, techs: TechRow[], jobs: JobRow[]): ProblemInput {
  return {
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
}

const loadTechs = (tx: Tx, orgId: string) => tx.technician.findMany({ where: { orgId }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });

export async function buildProblem(tx: Tx, orgId: string, date: string): Promise<ProblemInput> {
  const day = dayOf(date);
  const [techs, jobs] = await Promise.all([
    loadTechs(tx, orgId),
    tx.job.findMany({ where: { orgId, date: day, status: { in: [...PLANNABLE] } }, orderBy: [{ ref: 'asc' }, { id: 'asc' }] }),
  ]);
  const problem = toProblem(date, techs, jobs);
  const parsed = Problem.safeParse(problem);
  if (!parsed.success) throw new Refused(`This day can't be planned yet: ${parsed.error.issues[0]?.message ?? 'invalid data'}.`);
  if (!problem.jobs.length) throw new Refused('No jobs to plan on this day.');
  if (!problem.techs.length) throw new Refused('Add a technician first.');
  return problem;
}

/** D-42: once any job on the day is underway or finished, only a re-plan may save over it (TR-03). */
export async function startedJobs(tx: Tx, orgId: string, date: string): Promise<number> {
  return tx.job.count({ where: { orgId, date: dayOf(date), status: { in: [...FROZEN] } } });
}

export interface ReplanState {
  input: ReplanInput;
  build: ReplanBuild;
  basePlanId: string;
  refs: Map<string, string>;
}

/**
 * Phase 3: everything a re-plan of `date` as of `asOf` needs, read from the database: the whole day (every job, any
 * status), the current plan, statuses with actual times on that day (D-40). Pure re-plan logic is in replan.ts.
 */
export async function loadReplan(tx: Tx, orgId: string, date: string, asOf: number): Promise<ReplanState> {
  const [techs, jobs, current] = await Promise.all([
    loadTechs(tx, orgId),
    tx.job.findMany({ where: { orgId, date: dayOf(date) }, orderBy: [{ ref: 'asc' }, { id: 'asc' }] }),
    currentPlan(tx, orgId, date),
  ]);
  if (!current) throw new Refused('There is no plan for this day yet. Plan the day first, then re-plan.');
  if (!techs.length) throw new Refused('Add a technician first.');
  const parsed = Problem.safeParse(toProblem(date, techs, jobs));
  if (!parsed.success) throw new Refused(`This day can't be re-planned: ${parsed.error.issues[0]?.message ?? 'invalid data'}.`);
  const base = PlanSchema.safeParse(current.plan);
  if (!base.success) throw new Refused('The current plan could not be read. Plan the day again.');
  const status: Record<string, JobState> = {};
  for (const j of jobs) status[j.id] = { status: j.status, onSiteMin: localMinuteOn(j.onSiteAt, date), doneMin: localMinuteOn(j.doneAt, date) };
  const input: ReplanInput = { day: parsed.data, base: base.data, status, asOf };
  try {
    return { input, build: buildReplan(input), basePlanId: current.id, refs: new Map(jobs.map((j) => [j.id, j.ref])) };
  } catch (e) {
    if (e instanceof ReplanError) throw new Refused(e.message);
    throw e;
  }
}

/** The dispatcher's message when a re-plan's pins can't all be kept (D-37, D-43). Null when they can. */
export function replanPinMessage(state: ReplanState, pins?: PinConflictEntry[]): string | null {
  const { build, input, refs } = state;
  const list = pins ?? (build.conflicts.length ? build.conflicts : pinConflicts(build.problem));
  if (!list.length) return null;
  const label = (id: string) => `Job ${refs.get(id) ?? id}`;
  const started = new Map(build.techs.map((t) => [t.techId, t.frozen.length]));
  const names = new Map(input.day.techs.map((t) => [t.id, t.name]));
  const lines = list.map((c) => {
    const dayPin = input.day.jobs.find((j) => j.id === c.jobId)?.pin;
    if (build.conflicts.length && c.code === 'position-taken')
      return `${label(c.jobId)} is pinned to ${names.get(c.techId) ?? c.techId} at #${dayPin?.position}, but ${names.get(c.techId) ?? c.techId}'s first ${started.get(c.techId)} stop(s) have already started.`;
    return describePinConflicts(build.problem, [c], label)[0]!;
  });
  return `This day can't be re-planned: pinned jobs are never moved or dropped, and these pins can't all be kept. ${[...new Set(lines)].join(' ')} In a re-plan, positions and capacity count only what is left of each technician's day. Change or remove those pins, then re-plan. Nothing was saved.`;
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
  const saved = await persistPlan(tx, ctx, { problem, plan, metrics: res.metrics, openJobs: problem.jobs.map((j) => j.id) });
  await audit(ctx, 'dispatch.plan_saved', { targetType: 'dispatchPlan', targetId: saved, data: { date: problem.date, stops: countStops(plan), unassigned: plan.unassigned.length } }, tx);
  return { ok: true, planId: saved };
}

const countStops = (plan: Plan) => plan.routes.reduce((n, r) => n + r.stops.length, 0);

/** Writes a checked plan: the DispatchPlan row, its stops, and `scheduled`/`unscheduled` for the jobs it planned. */
async function persistPlan(
  tx: Tx,
  ctx: OrgCtx,
  x: { problem: ProblemInput | Problem; plan: Plan; metrics: PlanMetrics; openJobs: string[]; asOf?: number; basePlanId?: string; solved?: Plan },
): Promise<string> {
  const { problem, plan } = x;
  const saved = await tx.dispatchPlan.create({
    data: {
      ...inOrg(ctx),
      date: dayOf(problem.date),
      createdById: ctx.userId,
      problem: problem as unknown as Prisma.InputJsonValue,
      plan: plan as unknown as Prisma.InputJsonValue,
      metrics: x.metrics as unknown as Prisma.InputJsonValue,
      driveMin: plan.objective.driveMin,
      lateMin: plan.objective.lateMin,
      unassignedCount: plan.unassigned.length,
      stoppedBy: plan.stoppedBy,
      asOf: x.asOf ?? null,
      basePlanId: x.basePlanId ?? null,
      ...(x.solved ? { solved: x.solved as unknown as Prisma.InputJsonValue } : {}),
    },
  });
  const stops = plan.routes.flatMap((r) =>
    r.stops.map((s) => ({ ...inOrg(ctx), planId: saved.id, techId: r.techId, jobId: s.jobId, seq: s.seq, arrival: s.arrival, start: s.start, end: s.end, driveMin: s.driveMin, slackMin: s.slackMin, lateMin: s.lateMin })),
  );
  if (stops.length) await tx.planStop.createMany({ data: stops });
  // Only the jobs this plan was asked to plan change status; started work keeps the technician's status (TR-03).
  const routed = new Set(stops.map((s) => s.jobId));
  const open = x.openJobs;
  await tx.job.updateMany({ where: { ...inOrg(ctx), id: { in: open.filter((id) => routed.has(id)) } }, data: { status: 'scheduled' } });
  await tx.job.updateMany({ where: { ...inOrg(ctx), id: { in: open.filter((id) => !routed.has(id)) } }, data: { status: 'unscheduled' } });
  return saved.id;
}

/**
 * Phase 3, TR-02 + TR-03 for re-plans: the solver's answer for the open work must pass checkPlan against the re-plan
 * problem, and the merged day must pass checkReplan (started stops and pins untouched). Only then is anything written.
 */
export async function saveReplanIfValid(tx: Tx, ctx: OrgCtx, state: ReplanState, solverOutput: unknown): Promise<SaveResult & { emergencies?: { placed: string[]; unplaced: string[] } }> {
  const { build, input } = state;
  const target = { targetType: 'day', targetId: input.day.date };
  const conflict = PinConflictError.safeParse(solverOutput);
  if (conflict.success) {
    const verdict = checkPinConflict(build.problem, conflict.data);
    const codes = verdict.ok ? ['pin-conflict'] : ['invalid-pin-conflict'];
    await audit(ctx, 'dispatch.replan_rejected', { ...target, data: { asOf: build.asOf, codes, pins: conflict.data.pins.slice(0, 20), errors: verdict.errors.map((e) => e.message) } }, tx);
    if (!verdict.ok) return { ok: false, codes };
    return { ok: false, codes, pinConflict: replanPinMessage(state, conflict.data.pins)! };
  }
  const res = checkPlan(build.problem, solverOutput);
  if (!res.ok) {
    const codes = [...new Set(res.errors.map((e) => e.code))].sort();
    await audit(ctx, 'dispatch.replan_rejected', { ...target, data: { asOf: build.asOf, codes, errors: res.errors.slice(0, 20).map((e) => e.message) } }, tx);
    return { ok: false, codes };
  }
  const solved = solverOutput as Plan;
  const merged = mergeReplan(build, solved);
  const errors = checkReplan(input, build, solved, merged);
  if (errors.length) {
    const codes = [...new Set(errors.map((e) => e.code))].sort();
    await audit(ctx, 'dispatch.replan_rejected', { ...target, data: { asOf: build.asOf, codes, errors: errors.slice(0, 20).map((e) => e.message) } }, tx);
    return { ok: false, codes };
  }
  const metrics = computeMetrics(input.day, merged);
  const planId = await persistPlan(tx, ctx, { problem: build.problem, plan: merged, metrics, openJobs: build.problem.jobs.map((j) => j.id), asOf: build.asOf, basePlanId: state.basePlanId, solved });
  const emergencyIds = build.problem.jobs.filter((j) => j.priority === 'emergency').map((j) => j.id);
  const unplaced = new Set(merged.unassigned.map((u) => u.jobId));
  const emergencies = { placed: emergencyIds.filter((id) => !unplaced.has(id)), unplaced: emergencyIds.filter((id) => unplaced.has(id)) };
  await audit(ctx, 'dispatch.replan_saved', {
    targetType: 'dispatchPlan',
    targetId: planId,
    data: { date: input.day.date, asOf: hhmm(build.asOf), basePlanId: state.basePlanId, stops: countStops(merged), unassigned: merged.unassigned.length, emergenciesPlaced: emergencies.placed.length, emergenciesUnplaced: emergencies.unplaced.length },
  }, tx);
  return { ok: true, planId, emergencies };
}

/** The newest saved plan for a day, or null. */
export async function currentPlan(tx: Tx, orgId: string, date: string) {
  return tx.dispatchPlan.findFirst({ where: { orgId, date: dayOf(date) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
}
