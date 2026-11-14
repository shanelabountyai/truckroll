import { LUNCH_MINUTES, Plan, Problem, type Job, type Point, type Route, type Tech } from './contract';
import { driveMinutes } from './distance';
import { computeMetrics, type PlanMetrics } from './metrics';

// The oracle (PRD §5, D-03): validates any plan against its problem without trusting the solver. Recomputes every
// drive with distance.ts and every time from the route model in docs/truckroll/PHASE1_PLAN.md ("Model"). A plan this
// rejects is never persisted (TR-02, Phase 2).

export type CheckCode =
  | 'invalid-problem'
  | 'invalid-plan'
  | 'date-mismatch'
  | 'unknown-tech'
  | 'duplicate-route'
  | 'unknown-job'
  | 'duplicate-job'
  | 'missing-job'
  | 'skill'
  | 'seq'
  | 'capacity'
  | 'drive-mismatch'
  | 'time-mismatch'
  | 'early-start'
  | 'too-late'
  | 'shift-end'
  | 'lunch-missing'
  | 'lunch-window'
  | 'lunch-placement'
  | 'pin-tech'
  | 'pin-position'
  | 'reason'
  | 'objective-mismatch';

export interface CheckError {
  code: CheckCode;
  message: string;
  techId?: string;
  jobId?: string;
}

export interface CheckResult {
  ok: boolean;
  errors: CheckError[];
  metrics: PlanMetrics | null;
}

/** Where and when a tech's route begins: the re-plan override, else home at shift start. */
export function routeStart(t: Tech): { point: Point; at: number } {
  return t.start ?? { point: t.home, at: t.shiftStart };
}

/** Lunch is owed on a non-empty route unless the tech starts after the lunch window has closed (mid-day re-plan). */
export function lunchRequired(t: Tech): boolean {
  return routeStart(t).at <= t.lunch.latest;
}

export function checkPlan(problemInput: unknown, planInput: unknown): CheckResult {
  const pp = Problem.safeParse(problemInput);
  if (!pp.success) return { ok: false, errors: [{ code: 'invalid-problem', message: pp.error.message }], metrics: null };
  const lp = Plan.safeParse(planInput);
  if (!lp.success) return { ok: false, errors: [{ code: 'invalid-plan', message: lp.error.message }], metrics: null };
  const problem = pp.data;
  const plan = lp.data;
  const errors: CheckError[] = [];
  const err = (code: CheckCode, message: string, ids: { techId?: string; jobId?: string } = {}) => errors.push({ code, message, ...ids });

  if (plan.date !== problem.date) err('date-mismatch', `plan date ${plan.date} ≠ problem date ${problem.date}`);
  const techs = new Map(problem.techs.map((t) => [t.id, t]));
  const jobs = new Map(problem.jobs.map((j) => [j.id, j]));

  // Every job exactly once, on a route or unassigned.
  const seen = new Map<string, number>();
  const mark = (jobId: string) => {
    if (!jobs.has(jobId)) err('unknown-job', `job ${jobId} is not in the problem`, { jobId });
    seen.set(jobId, (seen.get(jobId) ?? 0) + 1);
  };
  for (const r of plan.routes) for (const s of r.stops) mark(s.jobId);
  for (const u of plan.unassigned) mark(u.jobId);
  for (const [jobId, n] of seen) if (n > 1 && jobs.has(jobId)) err('duplicate-job', `job ${jobId} appears ${n} times`, { jobId });
  for (const j of problem.jobs) if (!seen.has(j.id)) err('missing-job', `job ${j.id} is neither routed nor unassigned`, { jobId: j.id });

  const routed = new Set<string>();
  let lateTotal = 0;
  let driveTotal = 0;
  for (const r of plan.routes) {
    const t = techs.get(r.techId);
    if (!t) {
      err('unknown-tech', `route for unknown tech ${r.techId}`, { techId: r.techId });
      continue;
    }
    if (routed.has(t.id)) err('duplicate-route', `two routes for tech ${t.id}`, { techId: t.id });
    routed.add(t.id);
    const totals = checkRoute(problem, t, r, jobs, err);
    lateTotal += totals.late;
    driveTotal += totals.drive;
  }

  for (const u of plan.unassigned) {
    const j = jobs.get(u.jobId);
    if (!j) continue;
    if (u.reasons.includes('no-skill')) {
      const candidates = j.pin ? [techs.get(j.pin.techId)!] : problem.techs;
      if (candidates.some((t) => t.skills.includes(j.skill))) err('reason', `job ${j.id} says no-skill but a tech has ${j.skill}`, { jobId: j.id });
    }
  }

  const emergencies = plan.unassigned.filter((u) => jobs.get(u.jobId)?.priority === 'emergency').length;
  const o = plan.objective;
  if (o.unassignedEmergencies !== emergencies || o.lateMin !== lateTotal || o.driveMin !== driveTotal)
    err('objective-mismatch', `objective ${JSON.stringify(o)} ≠ recomputed ${JSON.stringify({ unassignedEmergencies: emergencies, lateMin: lateTotal, driveMin: driveTotal })}`);

  return { ok: errors.length === 0, errors, metrics: computeMetrics(problem, plan) };
}

function checkRoute(
  problem: Problem,
  t: Tech,
  r: Route,
  jobs: Map<string, Job>,
  err: (code: CheckCode, message: string, ids?: { techId?: string; jobId?: string }) => void,
): { late: number; drive: number } {
  const techId = t.id;
  const n = r.stops.length;
  if (n > t.maxJobs) err('capacity', `${n} stops > maxJobs ${t.maxJobs}`, { techId });
  const lunch = r.lunch;
  if (n && lunchRequired(t) && !lunch) err('lunch-missing', 'non-empty route without lunch', { techId });
  if (lunch) {
    const earliest = Math.max(t.lunch.earliest, routeStart(t).at);
    if (lunch.end !== lunch.start + LUNCH_MINUTES) err('lunch-window', `lunch must be ${LUNCH_MINUTES} min`, { techId });
    if (lunch.start < earliest || lunch.start > t.lunch.latest) err('lunch-window', `lunch at ${lunch.start} outside ${earliest}–${t.lunch.latest}`, { techId });
    if (lunch.afterSeq > n) err('lunch-placement', `lunch after seq ${lunch.afterSeq} of ${n}`, { techId });
  }
  const start = routeStart(t);
  let time = start.at; // when the tech is free to leave the current place
  let pos = start.point;
  let late = 0;
  let drive = 0;
  // Travel into the gap after stop `gap` (0 = from the route start). The tech leaves at `time`; if lunch is in this gap and
  // starts before the drive would end, it interrupts the drive (+30); if it starts later, it is eaten on arrival.
  const travel = (gap: number, d: number): number => {
    if (!lunch || lunch.afterSeq !== gap) return time + d;
    if (lunch.start < time) err('lunch-placement', `lunch at ${lunch.start} overlaps work ending ${time}`, { techId });
    return lunch.start <= time + d ? time + d + LUNCH_MINUTES : time + d;
  };
  const lunchEndsBy = (gap: number, limit: number, what: string, ids: { techId?: string; jobId?: string }) => {
    if (lunch && lunch.afterSeq === gap && lunch.end > limit) err('lunch-placement', `lunch ends ${lunch.end} after ${what} ${limit}`, ids);
  };
  r.stops.forEach((s, i) => {
    const jobId = s.jobId;
    const ids = { techId, jobId };
    if (s.seq !== i + 1) err('seq', `stop ${i + 1} has seq ${s.seq}`, ids);
    const j = jobs.get(jobId);
    if (!j) return;
    if (!t.skills.includes(j.skill)) err('skill', `tech ${techId} lacks ${j.skill} for ${jobId}`, ids);
    if (j.pin && j.pin.techId !== techId) err('pin-tech', `${jobId} pinned to ${j.pin.techId}`, ids);
    if (j.pin?.position !== undefined && j.pin.position !== s.seq) err('pin-position', `${jobId} pinned at ${j.pin.position}, seq ${s.seq}`, ids);
    const d = driveMinutes(pos, j.location);
    if (s.driveMin !== d) err('drive-mismatch', `drive ${s.driveMin} ≠ ${d}`, ids);
    const arrival = travel(i, d);
    if (s.arrival !== arrival) err('time-mismatch', `arrival ${s.arrival} ≠ ${arrival}`, ids);
    lunchEndsBy(i, s.start, 'start', ids);
    if (s.start < s.arrival) err('time-mismatch', `start ${s.start} before arrival ${s.arrival}`, ids);
    if (s.start < j.windowStart) err('early-start', `start ${s.start} before window ${j.windowStart}`, ids);
    if (s.slackMin !== s.start - s.arrival) err('time-mismatch', `slack ${s.slackMin} ≠ ${s.start - s.arrival}`, ids);
    if (s.end !== s.start + j.durationMin) err('time-mismatch', `end ${s.end} ≠ start + ${j.durationMin}`, ids);
    const lateBy = Math.max(0, s.start - j.windowEnd);
    if (s.lateMin !== lateBy) err('time-mismatch', `lateMin ${s.lateMin} ≠ ${lateBy}`, ids);
    if (lateBy > problem.maxLateMin) err('too-late', `${lateBy} min late > cap ${problem.maxLateMin}`, ids);
    late += s.lateMin;
    drive += s.driveMin;
    time = s.end;
    pos = j.location;
  });
  const back = driveMinutes(pos, t.home);
  if (r.returnDriveMin !== back) err('drive-mismatch', `return drive ${r.returnDriveMin} ≠ ${back}`, { techId });
  const home = travel(n, back);
  if (r.returnAt !== home) err('time-mismatch', `returnAt ${r.returnAt} ≠ ${home}`, { techId });
  if (home > t.shiftEnd) err('shift-end', `home at ${home} after shift end ${t.shiftEnd}`, { techId });
  lunchEndsBy(n, t.shiftEnd, 'shift end', { techId });
  drive += r.returnDriveMin;
  return { late, drive };
}
