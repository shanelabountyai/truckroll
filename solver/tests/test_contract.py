import copy

import pytest
from pydantic import ValidationError

from conftest import FIXTURES, load
from contract import Problem, SolveRequest


def test_at_least_twelve_fixtures():
    assert len(FIXTURES) >= 12


def test_every_fixture_parses(fixture):
    p = Problem.model_validate(fixture["problem"])
    SolveRequest.model_validate({"problem": fixture["problem"], "timeLimitMs": fixture["timeLimitMs"]})
    assert len(p.jobs) == len(fixture["problem"]["jobs"])


def _bad(mutate):
    p = copy.deepcopy(load(FIXTURES[0])["problem"])
    mutate(p)
    return p


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p["techs"][0].update(lunch={"earliest": 400, "latest": 700}),
        lambda p: p["techs"][0].update(shiftEnd=p["techs"][0]["shiftStart"]),
        lambda p: p["techs"].append(copy.deepcopy(p["techs"][0])),
        lambda p: p["jobs"][0].update(pin={"techId": "nobody"}),
        lambda p: p["jobs"][0].update(skill="plumbing"),
        lambda p: p.update(extra=1),
        lambda p: p["jobs"][0].update(windowEnd=p["jobs"][0]["windowStart"] - 1),
    ],
    ids=["lunch-outside-shift", "empty-shift", "dup-tech", "pin-unknown", "bad-skill", "extra-field", "window-backwards"],
)
def test_rejects(mutate):
    with pytest.raises(ValidationError):
        Problem.model_validate(_bad(mutate))
