"""D-36 / D-37 (Shane, 2026-11-14): no lateness; pinned jobs are never dropped or moved, and pins that can't all be
honoured give a pin-conflict naming them instead of a plan. The TS checker re-derives the same list (pins.test.ts)."""

import copy

import pytest
from fastapi.testclient import TestClient

from app import app
from conftest import FIXTURES, load
from contract import PinConflictError, Plan, SolveRequest
from solve import PinConflict, plan_json, solve


def _fx(stem: str) -> dict:
    return load(next(p for p in FIXTURES if p.stem == stem))


def _req(problem: dict, ms: int = 10_000) -> SolveRequest:
    return SolveRequest.model_validate({"problem": problem, "timeLimitMs": ms})


def _conflict(problem: dict) -> list[dict]:
    with pytest.raises(PinConflict) as e:
        solve(_req(problem))
    return e.value.pins


def test_pin_position_past_max_jobs_is_a_pin_conflict_not_a_crash():
    """The pre-existing crash: position > maxJobs aborted OR-Tools (Count cumul out of range)."""
    p = copy.deepcopy(_fx("12-pinned-position")["problem"])
    p["techs"][0]["maxJobs"] = 2
    p["jobs"][2]["pin"] = {"techId": "T1", "position": 3}
    assert _conflict(p) == [{"code": "position-over-capacity", "jobId": "J3", "techId": "T1"}]


def test_pin_to_a_tech_without_the_skill_is_a_pin_conflict():
    p = copy.deepcopy(_fx("11-pinned-job")["problem"])
    p["jobs"][0]["skill"] = "install"
    p["techs"][0]["skills"] = ["repair", "install"]  # someone else could do it; the pin is still never moved
    assert _conflict(p) == [{"code": "no-skill", "jobId": "J1", "techId": "Q1"}]


def test_two_pins_that_fit_alone_but_not_together():
    p = copy.deepcopy(_fx("13-would-be-late")["problem"])
    for j in p["jobs"]:
        j["pin"] = {"techId": "T1"}
    assert _conflict(p) == [{"code": "infeasible-together", "jobId": "J1", "techId": "T1"},
                            {"code": "infeasible-together", "jobId": "J2", "techId": "T1"}]


def test_post_solve_answers_422_with_the_pins_and_the_same_bytes_every_time():
    p = copy.deepcopy(_fx("12-pinned-position")["problem"])
    p["techs"][0]["maxJobs"] = 2
    p["jobs"][2]["pin"] = {"techId": "T1", "position": 3}
    client = TestClient(app)
    a = client.post("/solve", json={"problem": p, "timeLimitMs": 10_000})
    b = client.post("/solve", json={"problem": p, "timeLimitMs": 10_000})
    assert a.status_code == 422 and a.text == b.text
    body = PinConflictError.model_validate(a.json())
    assert [x.model_dump() for x in body.pins] == [{"code": "position-over-capacity", "jobId": "J3", "techId": "T1"}]


def test_no_model_solution_still_keeps_every_pin_in_place(monkeypatch):
    """If OR-Tools returns nothing, the routes pin_conflicts proved (the pin skeletons) are the start: no pin is dropped."""
    import solve as solve_module

    monkeypatch.setattr(solve_module, "_model_solve", lambda p, eligible, ms: (None, "local-optimum"))
    fx = _fx("12-pinned-position")
    plan = Plan.model_validate(solve_module.solve(_req(fx["problem"])))
    assert plan.unassigned == []
    assert plan.routes[0].stops[0].jobId == "J3"  # pinned at position 1


def test_a_pin_at_position_2_takes_an_unpinned_job_first():
    p = copy.deepcopy(_fx("12-pinned-position")["problem"])
    p["jobs"][2]["pin"] = {"techId": "T1", "position": 2}
    plan = Plan.model_validate(solve(_req(p)))
    assert [s.jobId for s in plan.routes[0].stops][1] == "J3"


def test_pins_are_never_dropped_even_for_an_emergency():
    plan = solve(_req(_fx("16-pin-never-dropped")["problem"]))
    assert [s["jobId"] for s in plan["routes"][0]["stops"]] == ["J1"]
    assert plan["unassigned"] == [{"jobId": "E1", "reasons": ["over-capacity"]}]


def test_no_stop_is_ever_late(fixture):
    plan = solve(_req(fixture["problem"], fixture["timeLimitMs"]))
    jobs = {j["id"]: j for j in fixture["problem"]["jobs"]}
    for r in plan["routes"]:
        for s in r["stops"]:
            assert s["lateMin"] == 0 and jobs[s["jobId"]]["windowStart"] <= s["start"] <= jobs[s["jobId"]]["windowEnd"]
    assert plan["objective"]["lateMin"] == 0


def test_max_late_min_is_no_longer_accepted():
    p = dict(_fx("01-single-job")["problem"], maxLateMin=60)
    assert TestClient(app).post("/solve", json={"problem": p, "timeLimitMs": 1000}).status_code == 422
    assert plan_json(solve(_req(_fx("01-single-job")["problem"])))  # and without it, a plan
