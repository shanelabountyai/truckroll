import { REASONS, type Plan, type Problem, type Reason } from './contract';

// PRD §3 Metrics, per plan. Pure: (problem, plan) → numbers. Percentages are whole numbers (rounded half up).
// Plan-vs-actual (Phase 4) is planVsActual below.
export interface PlanMetrics {
  assigned: number;
  unassigned: number;
  unassignedByReason: Record<Reason, number>; // counted by each job's first reason
  onTimePct: number; // stops starting by windowEnd ÷ stops (100 when there are no stops)
  lateMin: number;
  driveMin: number; // includes the drive home
  serviceMin: number;
  utilizationPct: number; // (service + drive) ÷ available shift minutes of techs with at least one stop
  techsUsed: number;
}

export function computeMetrics(problem: Problem, plan: Plan): PlanMetrics {
  const jobs = new Map(problem.jobs.map((j) => [j.id, j]));
  const techs = new Map(problem.techs.map((t) => [t.id, t]));
  let stops = 0;
  let onTime = 0;
  let lateMin = 0;
  let driveMin = 0;
  let serviceMin = 0;
  let available = 0;
  let techsUsed = 0;
  for (const r of plan.routes) {
    driveMin += r.returnDriveMin;
    for (const s of r.stops) {
      stops++;
      if (s.lateMin === 0) onTime++;
      lateMin += s.lateMin;
      driveMin += s.driveMin;
      serviceMin += jobs.get(s.jobId)?.durationMin ?? 0;
    }
    const t = techs.get(r.techId);
    if (r.stops.length && t) {
      techsUsed++;
      available += t.shiftEnd - (t.start?.at ?? t.shiftStart);
    }
  }
  const unassignedByReason = Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<Reason, number>;
  for (const u of plan.unassigned) unassignedByReason[u.reasons[0]!]++;
  const routeDrive = plan.routes.filter((r) => r.stops.length).reduce((n, r) => n + r.returnDriveMin + r.stops.reduce((m, s) => m + s.driveMin, 0), 0);
  return {
    assigned: stops,
    unassigned: plan.unassigned.length,
    unassignedByReason,
    onTimePct: stops ? Math.round((100 * onTime) / stops) : 100,
    lateMin,
    driveMin,
    serviceMin,
    utilizationPct: available ? Math.round((100 * (serviceMin + routeDrive)) / available) : 0,
    techsUsed,
  };
}

// ---------- Phase 4: plan vs actual (PRD §3 "plan vs actual once statuses come in", D-57) ----------

/** One job's recorded statuses, as local minutes on the plan's day (null when not recorded on that day). */
export interface ActualJob {
  status: string;
  windowStart: number;
  windowEnd: number;
  durationMin: number;
  onSiteMin: number | null;
  doneMin: number | null;
}

export interface ActualRow {
  jobId: string;
  techId: string;
  seq: number;
  status: string;
  plannedStart: number;
  plannedEnd: number;
  actualStart: number | null; // on site
  actualEnd: number | null; // done / can't complete
  startDeltaMin: number | null; // actual − planned start (+ = later than planned)
  durationDeltaMin: number | null; // (actual end − actual start) − planned duration
  inWindow: boolean | null; // on site no later than the window's end (the promise made to the customer)
}

export interface PlanVsActual {
  stops: number;
  started: number; // en route, on site, done or can't complete
  done: number;
  cantComplete: number;
  arrived: number; // stops with a recorded on-site time
  /** Of the stops with a recorded on-site time: arrived by the window's end. Null until one arrives. */
  actualOnTimePct: number | null;
  /** Mean of startDeltaMin over arrived stops, rounded; null until one arrives. */
  avgStartDeltaMin: number | null;
  /** Mean of durationDeltaMin over stops with both times; null until one finishes. */
  avgDurationDeltaMin: number | null;
  rows: ActualRow[];
}

const STARTED = new Set(['en_route', 'on_site', 'done', 'cant_complete']);
const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** Every routed stop of `plan` beside what its technician recorded. Pure; jobs missing from `jobs` are skipped. */
export function planVsActual(plan: Plan, jobs: Map<string, ActualJob>): PlanVsActual {
  const rows: ActualRow[] = [];
  for (const r of plan.routes) {
    for (const s of r.stops) {
      const j = jobs.get(s.jobId);
      if (!j) continue;
      const actualStart = j.onSiteMin;
      const actualEnd = j.doneMin !== null && (j.status === 'done' || j.status === 'cant_complete') ? j.doneMin : null;
      rows.push({
        jobId: s.jobId,
        techId: r.techId,
        seq: s.seq,
        status: j.status,
        plannedStart: s.start,
        plannedEnd: s.end,
        actualStart,
        actualEnd,
        startDeltaMin: actualStart === null ? null : actualStart - s.start,
        durationDeltaMin: actualStart !== null && actualEnd !== null && j.status === 'done' ? actualEnd - actualStart - j.durationMin : null,
        inWindow: actualStart === null ? null : actualStart <= j.windowEnd,
      });
    }
  }
  const arrived = rows.filter((x) => x.actualStart !== null);
  return {
    stops: rows.length,
    started: rows.filter((x) => STARTED.has(x.status)).length,
    done: rows.filter((x) => x.status === 'done').length,
    cantComplete: rows.filter((x) => x.status === 'cant_complete').length,
    arrived: arrived.length,
    actualOnTimePct: arrived.length ? Math.round((100 * arrived.filter((x) => x.inWindow).length) / arrived.length) : null,
    avgStartDeltaMin: mean(arrived.map((x) => x.startDeltaMin!)),
    avgDurationDeltaMin: mean(rows.filter((x) => x.durationDeltaMin !== null).map((x) => x.durationDeltaMin!)),
    rows,
  };
}
