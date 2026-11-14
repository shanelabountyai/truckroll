"""Truckroll solver: pre-check, OR-Tools routing model, deterministic normalisation (docs/truckroll/PHASE1_PLAN.md).

The output is a plain dict matching contract.Plan; `plan_json` serialises it canonically (sorted keys, no spaces) so the
same request gives byte-identical bytes (TR-04).
"""

from __future__ import annotations

import json
import time
from typing import Optional

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

import objective
from contract import LUNCH_MINUTES, Job, Point, Problem, SolveRequest, Tech
from distance import drive_minutes

DAY = 24 * 60
PRIORITY_RANK = {"emergency": 0, "standard": 1, "maintenance": 2}


class PinConflict(Exception):
    """D-37 (Shane, 2026-11-14): pinned jobs are never dropped or moved. When the pins can't all be honoured there is no
    plan; the solve fails with this instead, naming every pin at fault as {"code", "jobId", "techId"}. Codes, in the
    order they are judged (src/lib/dispatch/pins.ts mirrors this, and the checker re-derives it):
      no-skill               the pinned tech lacks the job's skill
      position-over-capacity the pinned position is past the tech's maxJobs
      no-window-fit          the pinned tech can't do the job alone inside its window, shift and lunch
      position-taken         two or more jobs are pinned to the same position on the same tech
      over-capacity          more jobs are pinned to the tech than its maxJobs
      infeasible-together    each pin is fine alone, but no route for the tech holds all its pins (at their positions)
      search-limit           the tech's pins could not be settled within PIN_SEARCH_LIMIT route prefixes
    The last two are judged only when none of the others applies anywhere. POST /solve answers 422; cli.py exits 4.
    """

    def __init__(self, pins: list[dict]):
        self.pins = pins
        super().__init__("pins can't all be honoured: " + ", ".join(f"{x['jobId']} on {x['techId']} ({x['code']})" for x in pins))

    def body(self) -> dict:
        return {"detail": str(self), "error": "pin-conflict", "pins": self.pins}


class TimeLimitExceeded(Exception):
    """The search hit timeLimitMs. No plan is returned: a clock-cut search is not reproducible (TR-04, D-18)."""


# ---------- timing model (shared by the pre-check and normalisation) ----------

def _travel(free_at: int, drive: int, lunch_start: Optional[int]) -> int:
    """Arrival after leaving at `free_at`. Lunch in this gap interrupts the drive if it starts before arrival."""
    if lunch_start is None:
        return free_at + drive
    return free_at + drive + LUNCH_MINUTES if lunch_start <= free_at + drive else free_at + drive


def _place_lunch(t: Tech, free_at: int, drive: int, next_window_start: Optional[int]) -> tuple[int, int, int]:
    """Earliest lunch in a gap: returns (lunch_start, arrival, earliest service start or home time)."""
    lunch = max(free_at, t.lunch_earliest())
    arrival = _travel(free_at, drive, lunch)
    ready = max(arrival, lunch + LUNCH_MINUTES if lunch > free_at + drive else arrival)
    if next_window_start is not None:
        ready = max(ready, next_window_start)
    return lunch, arrival, ready


def _single_job_fits(p: Problem, t: Tech, j: Job) -> bool:
    """Could tech t do job j alone (own shift, window cap, lunch)? Used for `no-window-fit`."""
    if t.maxJobs < 1 or j.skill not in t.skills:
        return False
    s = t.route_start()
    d_in = drive_minutes(s.point, j.location)
    d_out = drive_minutes(j.location, t.home)
    latest_start = j.windowEnd  # D-36: no lateness
    if not t.lunch_required():
        start = max(s.at + d_in, j.windowStart)
        return start <= latest_start and start + j.durationMin + d_out <= t.shiftEnd
    # lunch before the job (gap 0)
    lunch, _, start = _place_lunch(t, s.at, d_in, j.windowStart)
    if lunch <= t.lunch.latest and start <= latest_start and start + j.durationMin + d_out <= t.shiftEnd:
        return True
    # lunch after the job (gap 1)
    start = max(s.at + d_in, j.windowStart)
    if start > latest_start:
        return False
    lunch, home, _ = _place_lunch(t, start + j.durationMin, d_out, None)
    return lunch <= t.lunch.latest and max(home, lunch + LUNCH_MINUTES) <= t.shiftEnd


def precheck(p: Problem) -> dict[str, list[str]]:
    """Reason codes for unpinned jobs no tech could ever do (never sent to the solver). Pins: pin_conflicts (D-37)."""
    out: dict[str, list[str]] = {}
    for j in p.jobs:
        if j.pin:
            continue
        skilled = [t for t in p.techs if j.skill in t.skills]
        if not skilled:
            out[j.id] = ["no-skill"]
        elif not any(_single_job_fits(p, t, j) for t in skilled):
            out[j.id] = ["no-window-fit"]
    return out


# ---------- normalisation: earliest-start forward pass over a fixed sequence ----------

def _route(p: Problem, t: Tech, jobs: list[Job], lunch_gap: Optional[int]) -> Optional[dict]:
    s = t.route_start()
    free_at, pos = s.at, s.point
    stops = []
    lunch_out = None
    for i, j in enumerate(jobs):
        d = drive_minutes(pos, j.location)
        if lunch_gap == i:
            lunch, arrival, start = _place_lunch(t, free_at, d, j.windowStart)
            lunch_out = {"afterSeq": i, "end": lunch + LUNCH_MINUTES, "start": lunch}
        else:
            arrival = free_at + d
            start = max(arrival, j.windowStart)
        late = max(0, start - j.windowEnd)
        stops.append({"arrival": arrival, "driveMin": d, "end": start + j.durationMin, "jobId": j.id,
                      "lateMin": late, "seq": i + 1, "slackMin": start - arrival, "start": start})
        free_at, pos = start + j.durationMin, j.location
    back = drive_minutes(pos, t.home)
    if lunch_gap == len(jobs):
        lunch, home, _ = _place_lunch(t, free_at, back, None)
        lunch_out = {"afterSeq": len(jobs), "end": lunch + LUNCH_MINUTES, "start": lunch}
        finish = max(home, lunch + LUNCH_MINUTES)
    else:
        home = free_at + back
        finish = home
    route = {"lunch": lunch_out, "returnAt": home, "returnDriveMin": back, "stops": stops, "techId": t.id}
    ok = finish <= t.shiftEnd and all(st["lateMin"] == 0 for st in stops)  # D-36: no lateness
    if lunch_out and lunch_out["start"] > t.lunch.latest:
        ok = False
    return route if ok else None


def _best_lunch_gap(p: Problem, t: Tech, jobs: list[Job], solver_gap: Optional[int]) -> Optional[dict]:
    if not jobs or not t.lunch_required():
        return _route(p, t, jobs, None)
    gaps = ([solver_gap] if solver_gap is not None else []) + [g for g in range(len(jobs) + 1) if g != solver_gap]
    for g in gaps:  # the solver's gap first; it is feasible by the monotonicity argument in PHASE1_PLAN.md
        r = _route(p, t, jobs, g)
        if r:
            return r
    return None


# ---------- pins (D-37): judged before the search, never relaxed ----------

PIN_SEARCH_LIMIT = 100_000  # route prefixes tried per tech before `search-limit` (a count, never the clock: TR-04)


def _pin_skeleton(p: Problem, t: Tech, pins: list[Job], fillers: list[Job]):
    """The first route, in a fixed search order, for tech t that holds all its pins, each at its pinned position, with
    the fewest stops: max(highest pinned position, number of pins). A slot before a pinned position that no pin fills
    takes an unpinned job (`fillers`). Fewest is enough: an extra stop never makes a later stop earlier (durations are
    >= 1 min and a detour's ceil'd drive minutes are never shorter). A prefix whose earliest-start timeline, without
    lunch, starts a stop after its window is cut (lunch only delays). Returns the job sequence, None if there is no such
    route, or "limit" after PIN_SEARCH_LIMIT prefixes. Mirrored by skeleton() in src/lib/dispatch/pins.ts."""
    at = {j.pin.position: j for j in pins if j.pin.position is not None}
    free_pins = sorted((j for j in pins if j.pin.position is None), key=lambda j: j.id)
    fillers = sorted((f for f in fillers if f.skill in t.skills), key=lambda j: j.id)
    n = max([len(pins)] + list(at))
    s0 = t.route_start()
    budget = [PIN_SEARCH_LIMIT]

    def dfs(seq: list[Job], free: int, pos: Point, left: list[Job], used: set[str]):
        if len(seq) == n:
            ok = len(seq) <= t.maxJobs and _best_lunch_gap(p, t, seq, None) is not None
            return list(seq) if ok else None
        budget[0] -= 1
        if budget[0] < 0:
            return "limit"
        k = len(seq) + 1
        open_slots = sum(1 for q in range(k, n + 1) if q not in at)
        if k in at:
            options = [at[k]]
        else:
            options = list(left) + ([f for f in fillers if f.id not in used] if open_slots - 1 >= len(left) else [])
        for j in options:
            if j.skill not in t.skills:
                continue
            start = max(free + drive_minutes(pos, j.location), j.windowStart)
            if start > j.windowEnd:
                continue
            res = dfs(seq + [j], start + j.durationMin, j.location, [x for x in left if x.id != j.id],
                      used if j.pin else used | {j.id})
            if res is not None:
                return res
        return None

    return dfs([], s0.at, s0.point, free_pins, set())


def pin_conflicts(p: Problem) -> tuple[list[dict], dict[str, list[Job]]]:
    """(conflicts, skeletons): every pin at fault (D-37); with none, one route per pinned tech that holds all its pins.
    Techs are taken in problem order and a filler used by one tech's skeleton is not offered to the next, so the
    skeletons together are a valid set of routes."""
    techs = {t.id: t for t in p.techs}
    out: list[dict] = []
    pinned = [j for j in p.jobs if j.pin]
    for j in pinned:
        t = techs[j.pin.techId]
        skilled = j.skill in t.skills
        if not skilled:
            out.append({"code": "no-skill", "jobId": j.id, "techId": t.id})
        if j.pin.position is not None and j.pin.position > t.maxJobs:
            out.append({"code": "position-over-capacity", "jobId": j.id, "techId": t.id})
        if skilled and t.maxJobs >= 1 and not _single_job_fits(p, t, j):
            out.append({"code": "no-window-fit", "jobId": j.id, "techId": t.id})
    for t in p.techs:
        mine = [j for j in pinned if j.pin.techId == t.id]
        by_pos: dict[int, list[Job]] = {}
        for j in mine:
            if j.pin.position is not None:
                by_pos.setdefault(j.pin.position, []).append(j)
        for q in sorted(by_pos):
            if len(by_pos[q]) > 1:
                out += [{"code": "position-taken", "jobId": j.id, "techId": t.id} for j in by_pos[q]]
        if len(mine) > t.maxJobs:
            out += [{"code": "over-capacity", "jobId": j.id, "techId": t.id} for j in mine]
    if out:
        return out, {}
    skeletons: dict[str, list[Job]] = {}
    used: set[str] = set()
    for t in p.techs:
        mine = [j for j in pinned if j.pin.techId == t.id]
        if not mine:
            continue
        res = _pin_skeleton(p, t, mine, [j for j in p.jobs if not j.pin and j.id not in used])
        if res is None or res == "limit":
            code = "search-limit" if res == "limit" else "infeasible-together"
            out += [{"code": code, "jobId": j.id, "techId": t.id} for j in mine]
            continue
        skeletons[t.id] = res
        used |= {j.id for j in res if not j.pin}
    return out, ({} if out else skeletons)


# ---------- the routing model ----------

def _model_solve(p: Problem, eligible: list[Job], time_limit_ms: int):
    techs = p.techs
    m, nv = len(eligible), len(techs)
    points: list[Point] = [j.location for j in eligible]
    starts, ends = [], []
    for t in techs:
        starts.append(len(points)); points.append(t.route_start().point)
        ends.append(len(points)); points.append(t.home)
    service = [j.durationMin for j in eligible] + [0] * (2 * nv)
    drive = [[drive_minutes(a, b) for b in points] for a in points]

    manager = pywrapcp.RoutingIndexManager(len(points), nv, starts, ends)
    routing = pywrapcp.RoutingModel(manager)

    def drive_cb(i: int, k: int) -> int:
        return drive[manager.IndexToNode(i)][manager.IndexToNode(k)] * objective.DRIVE_PER_MIN

    def time_cb(i: int, k: int) -> int:
        a, b = manager.IndexToNode(i), manager.IndexToNode(k)
        return service[a] + drive[a][b]

    def count_cb(i: int) -> int:
        return 1 if manager.IndexToNode(i) < m else 0

    routing.SetArcCostEvaluatorOfAllVehicles(routing.RegisterTransitCallback(drive_cb))
    time_idx = routing.RegisterTransitCallback(time_cb)
    routing.AddDimension(time_idx, DAY, DAY, False, "Time")
    tdim = routing.GetDimensionOrDie("Time")
    routing.AddDimensionWithVehicleCapacity(routing.RegisterUnaryTransitCallback(count_cb), 0,
                                            [t.maxJobs for t in techs], True, "Count")
    cdim = routing.GetDimensionOrDie("Count")

    tech_index = {t.id: v for v, t in enumerate(techs)}
    for n, j in enumerate(eligible):
        idx = manager.NodeToIndex(n)
        tdim.CumulVar(idx).SetRange(j.windowStart, j.windowEnd)  # D-36: a hard window, no lateness
        if j.pin:
            allowed = [tech_index[j.pin.techId]]
            if j.pin.position is not None:
                cdim.CumulVar(idx).SetValue(j.pin.position - 1)
        else:
            allowed = [v for v, t in enumerate(techs) if j.skill in t.skills]
        if j.pin:  # D-37: mandatory (no disjunction); pin_conflicts has shown a route holding every pin exists
            routing.VehicleVar(idx).SetValues(allowed)
        else:
            routing.VehicleVar(idx).SetValues([-1] + allowed)
            routing.AddDisjunction([idx], objective.DROP[j.priority])

    solver = routing.solver()
    visit = [service[manager.IndexToNode(i)] for i in range(routing.Size())]
    breaks: dict[int, object] = {}
    for v, t in enumerate(techs):
        s_idx, e_idx = routing.Start(v), routing.End(v)
        tdim.CumulVar(s_idx).SetValue(t.route_start().at)
        tdim.CumulVar(e_idx).SetMax(t.shiftEnd)
        if t.lunch_required():
            b = solver.FixedDurationIntervalVar(t.lunch_earliest(), t.lunch.latest, LUNCH_MINUTES, False, f"lunch-{v}")
            solver.Add(b.StartExpr() >= tdim.CumulVar(s_idx))
            solver.Add(b.EndExpr() <= tdim.CumulVar(e_idx))
            tdim.SetBreakIntervalsOfVehicle([b], v, visit)
            routing.AddIntervalToAssignment(b)  # so the solution carries the lunch start
            breaks[v] = b

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GREEDY_DESCENT
    # The work limit (D-18): greedy descent ends at a local optimum or after SOLUTION_LIMIT solutions. Both are counts,
    # so the search does the same work on any machine; the routing search is single-threaded.
    params.solution_limit = objective.SOLUTION_LIMIT
    # The clock is only a safety net. lns_time_limit (default 100 ms) is a per-neighbourhood clock inside the search: a
    # slow machine could hit it without hitting the overall cap and quietly get a different plan, so it is lifted to the
    # cap as well. Whichever clock bites, the result is TimeLimitExceeded, never a plan.
    params.time_limit.FromMilliseconds(time_limit_ms)
    params.lns_time_limit.FromMilliseconds(time_limit_ms)
    params.log_search = False

    t0 = time.monotonic()
    sol = routing.SolveWithParameters(params)
    elapsed_ms = (time.monotonic() - t0) * 1000
    solutions = routing.solver().Solutions()
    S = routing_enums_pb2.RoutingSearchStatus
    # Two independent signs of a clock cut: the elapsed time, and OR-Tools' own status (a limit stopped the search
    # before a local optimum while the solution count was still under SOLUTION_LIMIT).
    clock_cut = routing.status() in (S.ROUTING_FAIL_TIMEOUT, S.ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED)
    if solutions < objective.SOLUTION_LIMIT and (elapsed_ms >= time_limit_ms or clock_cut):
        raise TimeLimitExceeded(f"search hit the {time_limit_ms} ms limit after {solutions} solutions")
    if solutions >= objective.SOLUTION_LIMIT:
        stopped = "solution-limit"
    else:
        stopped = "local-optimum"
    if sol is None:
        return None, stopped

    out = []
    for v, t in enumerate(techs):
        seq: list[Job] = []
        idx = routing.Start(v)
        while not routing.IsEnd(idx):
            idx = sol.Value(routing.NextVar(idx))
            node = manager.IndexToNode(idx)
            if node < m:
                seq.append(eligible[node])
        gap = None
        if v in breaks and seq:
            b_start = sol.StartValue(breaks[v])
            ends_by = [sol.Value(tdim.CumulVar(manager.NodeToIndex(eligible.index(j)))) + j.durationMin for j in seq]
            gap = sum(1 for e in ends_by if e <= b_start)
        out.append((t, seq, gap))
    return out, stopped


def _insertions(p: Problem, t: Tech, seq: list[Job], j: Job):
    """Every feasible route with j inserted into t's sequence (pins, maxJobs, windows, shift, lunch all honoured).
    Never before a stop pinned to its position, so a pinned position never moves."""
    if j.skill not in t.skills or (j.pin and j.pin.techId != t.id) or len(seq) + 1 > t.maxJobs:
        return
    for k in range(len(seq) + 1):
        if j.pin and j.pin.position is not None and j.pin.position != k + 1:
            continue
        if any(o.pin and o.pin.position is not None for o in seq[k:]):
            continue  # inserting here would move a stop pinned to its position
        new = seq[:k] + [j] + seq[k:]
        r = _best_lunch_gap(p, t, new, None)
        if r is not None:
            yield k, new, r


def _repair(p: Problem, eligible: list[Job], seqs: dict[str, list[Job]], built: dict[str, dict]) -> None:
    """Insert every unrouted job that still fits somewhere, so `over-capacity` is only ever said of a job that cannot be
    added to any route of the returned plan (the checker re-derives this, D-03). Most important jobs first; the
    cheapest insertion by drive wins (no lateness since D-36); ties go to tech order, then position. Deterministic."""
    order = sorted(eligible, key=lambda j: (0 if j.pin else 1, PRIORITY_RANK[j.priority], j.id))
    changed = True
    while changed:
        changed = False
        routed = {s["jobId"] for r in built.values() for s in r["stops"]}
        for j in order:
            if j.id in routed:
                continue
            best = None
            for ti, t in enumerate(p.techs):
                before = built[t.id]
                base_drive = before["returnDriveMin"] + sum(st["driveMin"] for st in before["stops"])
                for k, new, r in _insertions(p, t, seqs[t.id], j):
                    drive = r["returnDriveMin"] + sum(st["driveMin"] for st in r["stops"]) - base_drive
                    key = (drive, ti, k)
                    if best is None or key < best[0]:
                        best = (key, t, new, r)
            if best is not None:
                _, t, new, r = best
                seqs[t.id], built[t.id] = new, r
                routed.add(j.id)
                changed = True


def solve(req: SolveRequest) -> dict:
    p = req.problem
    conflicts, skeletons = pin_conflicts(p)
    if conflicts:
        raise PinConflict(conflicts)  # D-37: never a plan that drops or moves a pin
    reasons = precheck(p)
    eligible = [j for j in p.jobs if j.id not in reasons]
    stopped_by = "trivial"
    assignments: list[tuple[Tech, list[Job], Optional[int]]] = [(t, [], None) for t in p.techs]
    use_skeletons = bool(skeletons)  # until the model gives routes that hold every pin
    if eligible and p.techs:
        res, stopped_by = _model_solve(p, eligible, req.timeLimitMs)
        if res is not None:
            assignments = res
            use_skeletons = False

    seqs: dict[str, list[Job]] = {}
    built: dict[str, dict] = {}
    for t, seq, gap in assignments:
        r = _best_lunch_gap(p, t, seq, gap)
        if r is None and any(j.pin for j in seq):
            use_skeletons = True  # never drop or move a pin to make a route fit
            break
        while r is None and seq:  # defensive: never emit a plan the checker would reject; drop from the end
            seq = seq[:-1]
            r = _best_lunch_gap(p, t, seq, None)
        if r is None:
            seq = []
            r = _best_lunch_gap(p, t, [], None)
        seqs[t.id], built[t.id] = seq, r
    if use_skeletons:
        # No model solution, or one that would cost a pin: start over from the routes pin_conflicts proved, which hold
        # every pin at its position; the repair pass then adds everything else that fits.
        seqs = {t.id: list(skeletons.get(t.id, [])) for t in p.techs}
        built = {t.id: _best_lunch_gap(p, t, seqs[t.id], None) for t in p.techs}
    _repair(p, eligible, seqs, built)
    routes = [built[t.id] for t in p.techs]
    routed = {s["jobId"] for r in routes for s in r["stops"]}

    unassigned = []
    for j in p.jobs:
        if j.id in reasons:
            unassigned.append({"jobId": j.id, "reasons": reasons[j.id]})
        elif j.id not in routed:
            unassigned.append({"jobId": j.id, "reasons": ["over-capacity"]})
    by_id = {j.id: j for j in p.jobs}
    objective_out = {
        "driveMin": sum(r["returnDriveMin"] + sum(s["driveMin"] for s in r["stops"]) for r in routes),
        "lateMin": sum(s["lateMin"] for r in routes for s in r["stops"]),
        "unassignedEmergencies": sum(1 for u in unassigned if by_id[u["jobId"]].priority == "emergency"),
    }
    return {"date": p.date, "objective": objective_out, "routes": routes, "stoppedBy": stopped_by,
            "unassigned": unassigned, "version": 1}


def plan_json(plan: dict) -> str:
    return json.dumps(plan, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
