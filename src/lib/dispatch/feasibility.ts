import { LUNCH_MINUTES, type Job, type Problem, type Reason, type Tech } from './contract';
import { driveMinutes } from './distance';

// Could a technician do this exact sequence of jobs? The earliest-start timeline of the route model in
// docs/truckroll/PHASE1_PLAN.md ("Model"), trying every gap for lunch. Mirrors solver/solve.py (_route, _best_lunch_gap,
// _single_job_fits). The checker uses it to verify every reason the solver gives for leaving a job unassigned, so a
// plan cannot drop jobs it could have done (review of PR #1, must-fix 2).

const start = (t: Tech) => t.start ?? { point: t.home, at: t.shiftStart };
/** Lunch is owed on a non-empty route unless already taken (D-41) or the tech starts after the lunch window (D-16). */
export const lunchRequired = (t: Tech) => !t.lunchTaken && start(t).at <= t.lunch.latest;
const lunchEarliest = (t: Tech) => Math.max(t.lunch.earliest, start(t).at);

/** Earliest-start schedule with lunch in gap `lunchGap` (null = no lunch). True if every constraint holds. */
function fitsWithLunchGap(p: Problem, t: Tech, jobs: Job[], lunchGap: number | null): boolean {
  let free = start(t).at;
  let pos = start(t).point;
  const place = (d: number, windowStart: number | null) => {
    // lunch at the earliest moment in this gap; it interrupts the drive or is eaten on arrival (contract semantics)
    const lunch = Math.max(free, lunchEarliest(t));
    const arrival = lunch <= free + d ? free + d + LUNCH_MINUTES : free + d;
    let ready = lunch > free + d ? Math.max(arrival, lunch + LUNCH_MINUTES) : arrival;
    if (windowStart !== null) ready = Math.max(ready, windowStart);
    return { lunch, arrival, ready };
  };
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i]!;
    const d = driveMinutes(pos, j.location);
    let begin: number;
    if (lunchGap === i) {
      const l = place(d, j.windowStart);
      if (l.lunch > t.lunch.latest) return false;
      begin = l.ready;
    } else begin = Math.max(free + d, j.windowStart);
    if (begin > j.windowEnd) return false; // D-36: no lateness
    free = begin + j.durationMin;
    pos = j.location;
  }
  const back = driveMinutes(pos, t.home);
  if (lunchGap === jobs.length) {
    const l = place(back, null);
    if (l.lunch > t.lunch.latest) return false;
    return Math.max(l.arrival, l.lunch + LUNCH_MINUTES) <= t.shiftEnd;
  }
  return free + back <= t.shiftEnd;
}

/** Can tech `t` do `jobs` in this order: skills, maxJobs, pins (tech and position), windows, lunch, shift? */
export function routeFeasible(p: Problem, t: Tech, jobs: Job[]): boolean {
  if (jobs.length > t.maxJobs) return false;
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i]!;
    if (!t.skills.includes(j.skill)) return false;
    if (j.pin && (j.pin.techId !== t.id || (j.pin.position !== undefined && j.pin.position !== i + 1))) return false;
  }
  if (!jobs.length || !lunchRequired(t)) return fitsWithLunchGap(p, t, jobs, null);
  for (let g = 0; g <= jobs.length; g++) if (fitsWithLunchGap(p, t, jobs, g)) return true;
  return false;
}

/** Could tech `t` do job `j` alone, its pin position aside (a position is about other stops, not fit)? */
export function fitsAlone(p: Problem, t: Tech, j: Job): boolean {
  return routeFeasible(p, t, [{ ...j, pin: j.pin ? { techId: j.pin.techId } : undefined }]);
}

/** The reason an unpinned job can't be done by anyone alone, or null if some tech could do it alone. (A pinned job is
 * never unassigned, D-37: pins.ts.) */
export function standaloneReason(p: Problem, j: Job): Reason | null {
  const skilled = p.techs.filter((t) => t.skills.includes(j.skill));
  if (!skilled.length) return 'no-skill';
  return skilled.some((t) => fitsAlone(p, t, j)) ? null : 'no-window-fit';
}

/** A tech and position where `j` could be added to the plan's routes without breaking any of them, or null. */
export function insertionFor(p: Problem, j: Job, routes: Map<string, Job[]>): { techId: string; position: number } | null {
  for (const t of p.techs) {
    if (!t.skills.includes(j.skill) || (j.pin && j.pin.techId !== t.id)) continue;
    const seq = routes.get(t.id) ?? [];
    for (let i = 0; i <= seq.length; i++) {
      const candidate = [...seq.slice(0, i), j, ...seq.slice(i)];
      if (routeFeasible(p, t, candidate)) return { techId: t.id, position: i + 1 };
    }
  }
  return null;
}
