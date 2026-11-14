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
    latest_start = j.windowEnd + p.maxLateMin
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
    """Reason codes for jobs no tech could ever do (never sent to the solver)."""
    out: dict[str, list[str]] = {}
    techs = {t.id: t for t in p.techs}
    for j in p.jobs:
        candidates = [techs[j.pin.techId]] if j.pin else p.techs
        skilled = [t for t in candidates if j.skill in t.skills]
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
    ok = finish <= t.shiftEnd and all(st["lateMin"] <= p.maxLateMin for st in stops)
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
        tdim.CumulVar(idx).SetRange(j.windowStart, j.windowEnd + p.maxLateMin)
        tdim.SetCumulVarSoftUpperBound(idx, j.windowEnd, objective.LATE_PER_MIN)
        if j.pin:
            allowed = [tech_index[j.pin.techId]]
            if j.pin.position is not None:
                cdim.CumulVar(idx).SetValue(j.pin.position - 1)
        else:
            allowed = [v for v, t in enumerate(techs) if j.skill in t.skills]
        routing.VehicleVar(idx).SetValues([-1] + allowed)
        routing.AddDisjunction([idx], objective.DROP_PINNED if j.pin else objective.DROP[j.priority])

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
    """Every feasible route with j inserted into t's sequence (pins, maxJobs, windows, shift, lunch all honoured)."""
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
    cheapest insertion (lateness, then drive) wins; ties go to tech order, then position. Deterministic."""
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
                base_late = sum(st["lateMin"] for st in before["stops"])
                base_drive = before["returnDriveMin"] + sum(st["driveMin"] for st in before["stops"])
                for k, new, r in _insertions(p, t, seqs[t.id], j):
                    late = sum(st["lateMin"] for st in r["stops"]) - base_late
                    drive = r["returnDriveMin"] + sum(st["driveMin"] for st in r["stops"]) - base_drive
                    key = (late, drive, ti, k)
                    if best is None or key < best[0]:
                        best = (key, t, new, r)
            if best is not None:
                _, t, new, r = best
                seqs[t.id], built[t.id] = new, r
                routed.add(j.id)
                changed = True


def solve(req: SolveRequest) -> dict:
    p = req.problem
    reasons = precheck(p)
    eligible = [j for j in p.jobs if j.id not in reasons]
    stopped_by = "trivial"
    assignments: list[tuple[Tech, list[Job], Optional[int]]] = [(t, [], None) for t in p.techs]
    if eligible and p.techs:
        res, stopped_by = _model_solve(p, eligible, req.timeLimitMs)
        if res is not None:
            assignments = res

    seqs: dict[str, list[Job]] = {}
    built: dict[str, dict] = {}
    for t, seq, gap in assignments:
        r = _best_lunch_gap(p, t, seq, gap)
        while r is None and seq:  # defensive: never emit a plan the checker would reject; drop from the end
            seq = seq[:-1]
            r = _best_lunch_gap(p, t, seq, None)
        if r is None:
            seq = []
            r = _best_lunch_gap(p, t, [], None)
        seqs[t.id], built[t.id] = seq, r
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
