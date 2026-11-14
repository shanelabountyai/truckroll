import { REASONS, type Plan, type Problem, type Reason } from './contract';

// PRD §3 Metrics, per plan. Pure: (problem, plan) → numbers. Percentages are whole numbers (rounded half up).
// Plan-vs-actual arrives with statuses in Phase 3.
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
