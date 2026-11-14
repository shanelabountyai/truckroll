import type { Job, PinConflictEntry, Problem, Tech } from './contract';
import { driveMinutes } from './distance';
import { fitsAlone, routeFeasible } from './feasibility';

// D-37 (Shane, 2026-11-14): pinned jobs are never dropped or moved. When a day's pins can't all be honoured there is
// no plan, only a pin-conflict naming every pin at fault. This is the checker's own derivation of that list; it
// mirrors solver/solve.py (pin_conflicts, _pin_skeleton) step for step, so the checker can verify the solver's claim
// instead of trusting it (D-03), and Phase 2 can say which pins are wrong before calling the solver at all.

/** Route prefixes tried per tech before `search-limit`. A count, never the clock (TR-04). Same as solve.py. */
export const PIN_SEARCH_LIMIT = 100_000;

const byId = (a: Job, b: Job) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The first route, in a fixed search order, for tech `t` that holds all `pins`, each at its pinned position, with the
 * fewest stops: max(highest pinned position, number of pins). A slot before a pinned position that no pin fills takes
 * an unpinned job from `fillers`. Fewest is enough: an extra stop never makes a later stop earlier (durations are
 * >= 1 min and a detour's ceil'd drive minutes are never shorter). A prefix whose earliest-start timeline, without
 * lunch, starts a stop after its window is cut (lunch only delays). Returns the sequence, null, or 'limit'.
 */
export function skeleton(p: Problem, t: Tech, pins: Job[], fillersIn: Job[]): Job[] | null | 'limit' {
  const at = new Map<number, Job>();
  for (const j of pins) if (j.pin?.position !== undefined) at.set(j.pin.position, j);
  const freePins = pins.filter((j) => j.pin?.position === undefined).sort(byId);
  const fillers = fillersIn.filter((f) => t.skills.includes(f.skill)).sort(byId);
  const n = Math.max(pins.length, ...at.keys());
  const s0 = t.start ?? { point: t.home, at: t.shiftStart };
  let budget = PIN_SEARCH_LIMIT;

  const dfs = (seq: Job[], free: number, pos: Job['location'], left: Job[], used: Set<string>): Job[] | null | 'limit' => {
    if (seq.length === n) return routeFeasible(p, t, seq) ? [...seq] : null;
    if (--budget < 0) return 'limit';
    const k = seq.length + 1;
    let openSlots = 0;
    for (let q = k; q <= n; q++) if (!at.has(q)) openSlots++;
    const options = at.has(k) ? [at.get(k)!] : [...left, ...(openSlots - 1 >= left.length ? fillers.filter((f) => !used.has(f.id)) : [])];
    for (const j of options) {
      if (!t.skills.includes(j.skill)) continue;
      const start = Math.max(free + driveMinutes(pos, j.location), j.windowStart);
      if (start > j.windowEnd) continue;
      const res = dfs(
        [...seq, j],
        start + j.durationMin,
        j.location,
        left.filter((x) => x.id !== j.id),
        j.pin ? used : new Set([...used, j.id]),
      );
      if (res !== null) return res;
    }
    return null;
  };
  return dfs([], s0.at, s0.point, freePins, new Set());
}

/** Every pin at fault, in the solver's order (empty = the pins can all be honoured). Expects a parsed Problem. */
export function pinConflicts(p: Problem): PinConflictEntry[] {
  const techs = new Map(p.techs.map((t) => [t.id, t]));
  const out: PinConflictEntry[] = [];
  const pinned = p.jobs.filter((j) => j.pin);
  for (const j of pinned) {
    const t = techs.get(j.pin!.techId)!;
    const skilled = t.skills.includes(j.skill);
    if (!skilled) out.push({ code: 'no-skill', jobId: j.id, techId: t.id });
    if (j.pin!.position !== undefined && j.pin!.position > t.maxJobs) out.push({ code: 'position-over-capacity', jobId: j.id, techId: t.id });
    if (skilled && t.maxJobs >= 1 && !fitsAlone(p, t, j)) out.push({ code: 'no-window-fit', jobId: j.id, techId: t.id });
  }
  for (const t of p.techs) {
    const mine = pinned.filter((j) => j.pin!.techId === t.id);
    const byPos = new Map<number, Job[]>();
    for (const j of mine) if (j.pin!.position !== undefined) byPos.set(j.pin!.position, [...(byPos.get(j.pin!.position) ?? []), j]);
    for (const q of [...byPos.keys()].sort((a, b) => a - b))
      if (byPos.get(q)!.length > 1) for (const j of byPos.get(q)!) out.push({ code: 'position-taken', jobId: j.id, techId: t.id });
    if (mine.length > t.maxJobs) for (const j of mine) out.push({ code: 'over-capacity', jobId: j.id, techId: t.id });
  }
  if (out.length) return out;
  const used = new Set<string>();
  for (const t of p.techs) {
    const mine = pinned.filter((j) => j.pin!.techId === t.id);
    if (!mine.length) continue;
    const res = skeleton(p, t, mine, p.jobs.filter((j) => !j.pin && !used.has(j.id)));
    if (res === null || res === 'limit') {
      for (const j of mine) out.push({ code: res === 'limit' ? 'search-limit' : 'infeasible-together', jobId: j.id, techId: t.id });
      continue;
    }
    for (const j of res) if (!j.pin) used.add(j.id);
  }
  return out;
}

/** One plain sentence per pin at fault, for the dispatcher: tech names from the problem, job labels from `jobLabel`
 * (the job id by default; Phase 2 passes the job number the dispatcher knows). */
export function describePinConflicts(p: Problem, pins: PinConflictEntry[], jobLabel: (jobId: string) => string = (id) => id): string[] {
  const tech = new Map(p.techs.map((t) => [t.id, t]));
  const job = new Map(p.jobs.map((j) => [j.id, j]));
  return pins.map(({ code, jobId, techId }) => {
    const t = tech.get(techId);
    const j = job.get(jobId);
    const who = t?.name ?? techId;
    const pos = j?.pin?.position;
    const head = `${jobLabel(jobId)} is pinned to ${who}${pos ? ` at #${pos}` : ''}`;
    switch (code) {
      case 'no-skill':
        return `${head}, who doesn't have the ${j?.skill ?? 'needed'} skill.`;
      case 'position-over-capacity':
        return `${head}, but ${who} takes at most ${t?.maxJobs ?? '?'} jobs.`;
      case 'no-window-fit':
        return `${head}, who can't reach it inside its window (within the shift and lunch).`;
      case 'position-taken':
        return `${head}, and another job is pinned to the same position.`;
      case 'over-capacity':
        return `${head}, but more jobs are pinned to ${who} than the ${t?.maxJobs ?? '?'} they can take.`;
      case 'infeasible-together':
        return `${head}; each of ${who}'s pins fits alone, but not all of them together inside their windows.`;
      case 'search-limit':
        return `${head}; ${who} has too many pins to check. Unpin some and plan again.`;
    }
  });
}
