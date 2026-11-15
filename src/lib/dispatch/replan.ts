import { Plan, Problem, type Job, type PinConflictEntry, type Point, type Route, type Stop, type Tech } from './contract';
import { driveMinutes } from './distance';

// Phase 3: the mid-day re-plan (PRD §3 "Re-plan", TR-03). Pure: (the whole day, its current plan, job statuses, a
// cut-off time) → a solver Problem for what is still open, and back: the solver's checked plan → the merged day.
// Started work is never sent to the solver and comes back exactly as it was; pins go through the solver's own pin
// rules (D-37). checkReplan re-verifies the merged day without trusting the merge (D-03). docs/truckroll/PHASE3_PLAN.md.

export const JOB_STATUSES = ['unscheduled', 'scheduled', 'en_route', 'on_site', 'done', 'cant_complete'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
/** Started or finished work: kept where it is by a re-plan. TR-03 names on site and done; D-39 adds the other two. */
export const FROZEN: readonly JobStatus[] = ['en_route', 'on_site', 'done', 'cant_complete'];
/** A tech's current job: at most one per tech (setJobStatus enforces it). */
export const ACTIVE: readonly JobStatus[] = ['en_route', 'on_site'];
export const isFrozen = (s: JobStatus) => FROZEN.includes(s);
/** D-44: the moves a technician (or the dispatcher) can make on a stop. `can't complete` needs a note. */
export const NEXT_STATUS: Record<JobStatus, JobStatus[]> = {
  unscheduled: [],
  scheduled: ['en_route', 'on_site'],
  en_route: ['on_site', 'cant_complete'],
  on_site: ['done', 'cant_complete'],
  done: [],
  cant_complete: [],
};
export const STATUS_LABEL: Record<JobStatus, string> = { unscheduled: 'unscheduled', scheduled: 'scheduled', en_route: 'en route', on_site: 'on site', done: 'done', cant_complete: 'can’t complete' };

/** What a re-plan needs to know about a job beyond the contract: its status, and actual times on the plan's day. */
export interface JobState {
  status: JobStatus;
  /** Minutes after midnight the tech marked it on site / done (or can't complete), when that happened on the plan's day. */
  onSiteMin?: number | null;
  doneMin?: number | null;
}

export interface ReplanInput {
  /** The whole day: every tech, every job (any status), pins as the dispatcher set them (positions count the whole day). */
  day: Problem;
  /** The day's current saved plan (a whole-day plan or an earlier re-plan's merged day). */
  base: Plan;
  status: Record<string, JobState>;
  /** The cut-off, minutes after midnight (D-38). */
  asOf: number;
}

export interface TechStart {
  techId: string;
  /** Started stops, in the order the base plan has them, with the base plan's numbers (seq renumbered on merge). */
  frozen: Stop[];
  point: Point;
  /** When the tech is free at `point` (may be at or past shift end: then the tech takes no more jobs). */
  freeAt: number;
  lunchTaken: boolean;
  /** The base plan's lunch, kept on the merged route when it was taken before the cut-off. */
  takenLunch: Route['lunch'];
}

export interface ReplanBuild {
  asOf: number;
  /** What goes to the solver: open jobs only, techs starting where their statuses put them. */
  problem: Problem;
  techs: TechStart[];
  /** Pins whose position is already filled by started work (D-43): no solve, the dispatcher is told. */
  conflicts: PinConflictEntry[];
}

export class ReplanError extends Error {}

const sortBySeq = (a: Stop, b: Stop) => a.seq - b.seq;

/** D-40: where and when a tech is free, from their started stops on the base plan (no GPS). */
function techStart(t: Tech, route: Route | undefined, jobs: Map<string, Job>, status: Record<string, JobState>, asOf: number): TechStart {
  const frozen = (route?.stops ?? []).filter((s) => isFrozen(status[s.jobId]?.status ?? 'scheduled')).sort(sortBySeq);
  let point: Point = t.home;
  let at = t.shiftStart;
  const active = [...frozen].reverse().find((s) => ACTIVE.includes(status[s.jobId]!.status));
  const last = active ?? frozen[frozen.length - 1];
  if (last) {
    const j = jobs.get(last.jobId)!;
    const st = status[last.jobId]!;
    point = j.location;
    if (st.status === 'on_site') at = (st.onSiteMin ?? last.start) + j.durationMin;
    else if (st.status === 'en_route') at = Math.max(Math.max(asOf, last.arrival), j.windowStart) + j.durationMin;
    else at = st.doneMin ?? last.end;
  }
  at = Math.max(at, asOf, t.shiftStart);
  // D-41: a lunch the base plan started before the cut-off is taken; one still in progress ends before the tech is free.
  const lunch = route?.lunch ?? null;
  const lunchTaken = !!lunch && lunch.start < asOf;
  if (lunch && lunchTaken && lunch.end > at) at = lunch.end;
  return { techId: t.id, frozen, point, freeAt: at, lunchTaken, takenLunch: lunchTaken ? lunch : null };
}

/** Build the re-plan problem. Throws ReplanError when the day's state can't be re-planned (explained to the dispatcher). */
export function buildReplan(input: ReplanInput): ReplanBuild {
  const { day, base, status, asOf } = input;
  if (!Number.isInteger(asOf) || asOf < 0 || asOf > 24 * 60) throw new ReplanError('The re-plan time must be a time of day.');
  if (base.date !== day.date) throw new ReplanError('The current plan is for another day.');
  const jobs = new Map(day.jobs.map((j) => [j.id, j]));
  const routes = new Map(base.routes.map((r) => [r.techId, r]));
  const onBase = new Set(base.routes.flatMap((r) => r.stops.map((s) => s.jobId)));
  for (const j of day.jobs) {
    const s = status[j.id]?.status ?? 'unscheduled';
    if (isFrozen(s) && !onBase.has(j.id)) throw new ReplanError(`Job ${j.id} is underway but not on the current plan, so it can't be kept in place.`);
  }
  const techs = day.techs.map((t) => techStart(t, routes.get(t.id), jobs, status, asOf));
  const byTech = new Map(techs.map((s) => [s.techId, s]));
  const conflicts: PinConflictEntry[] = [];

  const problemTechs: Tech[] = day.techs.map((t) => {
    const s = byTech.get(t.id)!;
    const left = Math.max(0, t.maxJobs - s.frozen.length);
    // A tech free only at or after shift end takes no more jobs (the contract wants start.at inside the shift).
    if (s.freeAt >= t.shiftEnd) return { ...t, start: undefined, lunchTaken: undefined, maxJobs: 0 };
    return { ...t, maxJobs: left, start: { point: s.point, at: s.freeAt }, ...(s.lunchTaken ? { lunchTaken: true } : {}) };
  });
  const problemJobs: Job[] = [];
  for (const j of day.jobs) {
    if (isFrozen(status[j.id]?.status ?? 'unscheduled')) continue;
    if (!j.pin) {
      problemJobs.push(j);
      continue;
    }
    const k = byTech.get(j.pin.techId)?.frozen.length ?? 0;
    if (j.pin.position === undefined) {
      problemJobs.push(j);
      continue;
    }
    const rel = j.pin.position - k;
    if (rel < 1) {
      // D-43: the pinned position of the day is already taken by started work.
      conflicts.push({ code: 'position-taken', jobId: j.id, techId: j.pin.techId });
      problemJobs.push({ ...j, pin: { techId: j.pin.techId } });
    } else problemJobs.push({ ...j, pin: { techId: j.pin.techId, position: rel } });
  }
  const problem = Problem.parse({
    version: 1,
    date: day.date,
    techs: problemTechs.map((t) => JSON.parse(JSON.stringify(t)) as Tech), // drops undefined keys, so the JSON is canonical
    jobs: problemJobs,
  });
  return { asOf, problem, techs, conflicts };
}

/** The solver's checked plan for the open work → the merged day: started stops first, then the new ones. */
export function mergeReplan(build: ReplanBuild, solved: Plan): Plan {
  const solvedRoutes = new Map(solved.routes.map((r) => [r.techId, r]));
  const homes = new Map(build.problem.techs.map((t) => [t.id, t.home]));
  const routes: Route[] = build.techs.map((s) => {
    const k = s.frozen.length;
    const r = solvedRoutes.get(s.techId);
    const frozen = s.frozen.map((st, i) => ({ ...st, seq: i + 1 }));
    const fresh = (r?.stops ?? []).map((st) => ({ ...st, seq: st.seq + k }));
    let lunch: Route['lunch'] = null;
    if (r?.lunch) lunch = { ...r.lunch, afterSeq: r.lunch.afterSeq + k };
    else if (s.takenLunch) lunch = { ...s.takenLunch, afterSeq: s.frozen.filter((f) => f.seq <= s.takenLunch!.afterSeq).length };
    let returnDriveMin: number;
    let returnAt: number;
    if (r && r.stops.length) [returnDriveMin, returnAt] = [r.returnDriveMin, r.returnAt];
    else {
      returnDriveMin = driveMinutes(s.point, homes.get(s.techId)!);
      returnAt = Math.min(24 * 60, s.freeAt + returnDriveMin);
    }
    return { techId: s.techId, stops: [...frozen, ...fresh], lunch, returnDriveMin, returnAt };
  });
  const driveMin = routes.reduce((n, r) => n + r.returnDriveMin + r.stops.reduce((m, st) => m + st.driveMin, 0), 0);
  const lateMin = routes.reduce((n, r) => n + r.stops.reduce((m, st) => m + st.lateMin, 0), 0);
  return {
    version: 1,
    date: solved.date,
    routes,
    unassigned: solved.unassigned,
    objective: { unassignedEmergencies: solved.objective.unassignedEmergencies, lateMin, driveMin },
    stoppedBy: solved.stoppedBy,
  };
}

export type ReplanCheckCode = 'invalid-plan' | 'route' | 'frozen-moved' | 'pin-moved' | 'pin-dropped' | 'missing-job' | 'duplicate-job' | 'unknown-job' | 'tail-mismatch';
export interface ReplanCheckError {
  code: ReplanCheckCode;
  message: string;
  jobId?: string;
  techId?: string;
}

const SAME = ['jobId', 'arrival', 'start', 'end', 'driveMin', 'slackMin', 'lateMin'] as const;

/**
 * TR-03, verified on the merged day without trusting mergeReplan: every started stop is still on its tech, in the same
 * order, with the same times, ahead of all new work; every pinned job that hasn't started is on its tech at its day
 * position; every job of the day appears exactly once; the new work is exactly the plan the checker passed.
 */
export function checkReplan(input: ReplanInput, build: ReplanBuild, solved: Plan, mergedIn: unknown): ReplanCheckError[] {
  const parsed = Plan.safeParse(mergedIn);
  if (!parsed.success) return [{ code: 'invalid-plan', message: parsed.error.message }];
  const merged = parsed.data;
  const errors: ReplanCheckError[] = [];
  const err = (code: ReplanCheckCode, message: string, ids: { jobId?: string; techId?: string } = {}) => errors.push({ code, message, ...ids });
  const routes = new Map<string, Route>();
  for (const r of merged.routes) {
    if (routes.has(r.techId)) err('route', `two routes for ${r.techId}`, { techId: r.techId });
    routes.set(r.techId, r);
  }
  for (const t of input.day.techs) if (!routes.has(t.id)) err('route', `no route for ${t.id}`, { techId: t.id });
  if (merged.routes.length !== input.day.techs.length) err('route', `${merged.routes.length} routes for ${input.day.techs.length} techs`);

  // Started work: re-derived from the base plan and the statuses, not taken from `build`.
  const frozenOf = new Map<string, Stop[]>();
  for (const r of input.base.routes) frozenOf.set(r.techId, r.stops.filter((s) => isFrozen(input.status[s.jobId]?.status ?? 'scheduled')).sort(sortBySeq));
  for (const [techId, frozen] of frozenOf) {
    const r = routes.get(techId);
    frozen.forEach((f, i) => {
      const got = r?.stops[i];
      if (!got || got.seq !== i + 1 || SAME.some((k) => got[k] !== f[k]))
        err('frozen-moved', `started job ${f.jobId} must stay stop ${i + 1} on ${techId} with its times`, { jobId: f.jobId, techId });
    });
  }

  const where = new Map<string, { techId: string; seq: number }[]>();
  for (const r of merged.routes) for (const s of r.stops) where.set(s.jobId, [...(where.get(s.jobId) ?? []), { techId: r.techId, seq: s.seq }]);
  const unassigned = new Map<string, number>();
  for (const u of merged.unassigned) unassigned.set(u.jobId, (unassigned.get(u.jobId) ?? 0) + 1);
  const dayJobs = new Map(input.day.jobs.map((j) => [j.id, j]));
  for (const id of [...where.keys(), ...unassigned.keys()]) if (!dayJobs.has(id)) err('unknown-job', `job ${id} is not on this day`, { jobId: id });
  for (const j of input.day.jobs) {
    const n = (where.get(j.id)?.length ?? 0) + (unassigned.get(j.id) ?? 0);
    if (n === 0) err('missing-job', `job ${j.id} is neither routed nor unassigned`, { jobId: j.id });
    if (n > 1) err('duplicate-job', `job ${j.id} appears ${n} times`, { jobId: j.id });
    const frozen = isFrozen(input.status[j.id]?.status ?? 'unscheduled');
    if (frozen && unassigned.has(j.id)) err('frozen-moved', `started job ${j.id} was left unassigned`, { jobId: j.id });
    if (!j.pin || frozen) continue;
    const at = where.get(j.id)?.[0];
    if (!at) err('pin-dropped', `pinned job ${j.id} is not on a route`, { jobId: j.id, techId: j.pin.techId });
    else if (at.techId !== j.pin.techId) err('pin-moved', `pinned job ${j.id} is on ${at.techId}, pinned to ${j.pin.techId}`, { jobId: j.id, techId: at.techId });
    else if (j.pin.position !== undefined && at.seq !== j.pin.position)
      err('pin-moved', `pinned job ${j.id} is stop ${at.seq}, pinned at ${j.pin.position}`, { jobId: j.id, techId: at.techId });
  }

  // The new work is exactly the checked plan, shifted behind the started stops.
  const solvedRoutes = new Map(solved.routes.map((r) => [r.techId, r]));
  for (const s of build.techs) {
    const r = routes.get(s.techId);
    const want = (solvedRoutes.get(s.techId)?.stops ?? []).map((st) => ({ ...st, seq: st.seq + s.frozen.length }));
    const got = r?.stops.slice(frozenOf.get(s.techId)?.length ?? 0) ?? [];
    const same = got.length === want.length && got.every((g, i) => g.seq === want[i]!.seq && SAME.every((k) => g[k] === want[i]![k]));
    if (!same) err('tail-mismatch', `${s.techId}'s new stops are not the checked plan's`, { techId: s.techId });
  }
  const key = (u: Plan['unassigned'][number]) => `${u.jobId}:${u.reasons.join(',')}`;
  if (merged.unassigned.map(key).join(' ') !== solved.unassigned.map(key).join(' ')) err('tail-mismatch', 'unassigned jobs differ from the checked plan');
  return errors;
}
