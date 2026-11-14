from collections import Counter

from fastapi.testclient import TestClient

from app import app
from contract import Plan, SolveRequest
import pytest

from solve import TimeLimitExceeded, plan_json, precheck, solve


def _req(fx: dict) -> SolveRequest:
    return SolveRequest.model_validate({"problem": fx["problem"], "timeLimitMs": fx["timeLimitMs"]})


def test_every_job_exactly_once_and_reasons_match(fixture):
    plan = Plan.model_validate(solve(_req(fixture)))
    ids = [s.jobId for r in plan.routes for s in r.stops] + [u.jobId for u in plan.unassigned]
    assert sorted(ids) == sorted(j["id"] for j in fixture["problem"]["jobs"])
    exp = fixture["expect"]
    got = {u.jobId: list(u.reasons) for u in plan.unassigned}
    for job_id, reasons in exp.get("unassigned", {}).items():
        assert got.get(job_id) == reasons
    if "unassigned" in exp and "unassignedCounts" not in exp:
        assert set(got) == set(exp["unassigned"])
    if "unassignedCounts" in exp:
        assert dict(Counter(u.reasons[0] for u in plan.unassigned)) == exp["unassignedCounts"]
    routed = {s.jobId for r in plan.routes for s in r.stops}
    assert set(exp.get("assigned", [])) <= routed
    for tech_id, seq in exp.get("sequence", {}).items():
        assert [s.jobId for r in plan.routes if r.techId == tech_id for s in r.stops] == seq


def test_skills_respected_tr01(fixture):
    plan = solve(_req(fixture))
    techs = {t["id"]: t for t in fixture["problem"]["techs"]}
    jobs = {j["id"]: j for j in fixture["problem"]["jobs"]}
    for r in plan["routes"]:
        for s in r["stops"]:
            assert jobs[s["jobId"]]["skill"] in techs[r["techId"]]["skills"]


def test_byte_identical_tr04(fixture):
    assert plan_json(solve(_req(fixture))) == plan_json(solve(_req(fixture)))


def test_post_solve_returns_the_same_bytes(fixture):
    client = TestClient(app)
    body = {"problem": fixture["problem"], "timeLimitMs": fixture["timeLimitMs"]}
    res = client.post("/solve", json=body)
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/json")
    assert res.text == plan_json(solve(_req(fixture)))


def test_post_solve_rejects_a_bad_request():
    client = TestClient(app)
    assert client.post("/solve", json={"problem": {"version": 2}, "timeLimitMs": 1000}).status_code == 422
    assert client.get("/health").json() == {"ok": True}


def test_precheck_reasons_are_independent_of_the_solver():
    from conftest import FIXTURES, load

    fx = load(next(p for p in FIXTURES if p.stem == "14-all-reasons"))
    assert precheck(_req(fx).problem) == {"NS": ["no-skill"], "NW": ["no-window-fit"]}


def test_a_clock_cut_search_returns_no_plan_tr04(monkeypatch):
    """D-18 / PR #1 review must-fix 1: a search the clock cut short would depend on machine speed, so there is no plan.
    The clock is faked (each reading 10 s after the last) so the test does not itself depend on machine speed."""
    import itertools

    import solve as solve_module
    from conftest import FIXTURES, load

    ticks = itertools.count(0, 10.0)
    monkeypatch.setattr(solve_module.time, "monotonic", lambda: next(ticks))
    fx = load(next(p for p in FIXTURES if p.stem == "01-single-job"))
    req = SolveRequest.model_validate({"problem": fx["problem"], "timeLimitMs": 2000})
    with pytest.raises(TimeLimitExceeded):
        solve(req)
    res = TestClient(app).post("/solve", json={"problem": fx["problem"], "timeLimitMs": 2000})
    assert res.status_code == 503
    assert res.json()["error"] == "time-limit"


# ---- TR-04 with a real cap that bites (no faked clock) ----

def _demo(limit: int) -> SolveRequest:
    from conftest import FIXTURES, load

    fx = load(next(p for p in FIXTURES if p.stem == "03-demo-day"))
    return SolveRequest.model_validate({"problem": fx["problem"], "timeLimitMs": limit})


def _demo_x3(limit: int) -> SolveRequest:
    """The demo day three times over (72 jobs, maxJobs 50). Since hard windows (D-36) the demo day itself solves in
    ~60 ms, under the 100 ms minimum cap, so this heavier day (~450 ms here) is the one a low cap must bite on."""
    import copy

    from conftest import FIXTURES, load

    p = copy.deepcopy(load(next(f for f in FIXTURES if f.stem == "03-demo-day"))["problem"])
    p["jobs"] = [dict(copy.deepcopy(j), id=f"{j['id']}-{k}") for k in range(3) for j in p["jobs"]]
    for t in p["techs"]:
        t["maxJobs"] = 50
    return SolveRequest.model_validate({"problem": p, "timeLimitMs": limit})


def test_a_low_real_cap_gives_the_same_plan_or_no_plan_never_another_plan_tr04():
    ref = plan_json(solve(_demo_x3(60_000)))
    for limit in (100, 100, 250, 500, 1000):
        try:
            got = plan_json(solve(_demo_x3(limit)))
        except TimeLimitExceeded:
            continue
        assert got == ref
    with pytest.raises(TimeLimitExceeded):  # 100 ms is far below this day's work budget on any machine we run on
        solve(_demo_x3(100))


def test_plan_has_no_wall_clock_field():
    plan = solve(_demo(60_000))
    assert plan["stoppedBy"] in ("solution-limit", "local-optimum")
    assert set(plan) == {"date", "objective", "routes", "stoppedBy", "unassigned", "version"}


def test_no_solution_from_the_model_still_gives_honest_reasons(monkeypatch):
    """If OR-Tools returns nothing, the repair pass routes what fits instead of calling every job over-capacity."""
    import solve as solve_module

    monkeypatch.setattr(solve_module, "_model_solve", lambda p, eligible, ms: (None, "local-optimum"))
    plan = solve_module.solve(_demo(60_000))
    assert plan["unassigned"] == []  # the demo day has room for everything
    assert sum(len(r["stops"]) for r in plan["routes"]) == 24
