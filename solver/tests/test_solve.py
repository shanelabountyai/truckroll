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
