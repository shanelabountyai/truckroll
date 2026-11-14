"""Pydantic mirror of src/lib/dispatch/contract.ts. Field names are the JSON names (camelCase) on purpose."""

import re
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

SKILLS = ("install", "repair", "maintenance", "refrigerant-certified", "commercial")
PRIORITIES = ("emergency", "standard", "maintenance")
REASONS = ("no-skill", "no-window-fit", "over-capacity")
# D-37: why a set of pins can't all be honoured (POST /solve answers 422 {"error": "pin-conflict", "pins": [...]}).
PIN_CONFLICT_CODES = ("no-skill", "position-over-capacity", "no-window-fit", "position-taken", "over-capacity",
                      "infeasible-together", "search-limit")
LUNCH_MINUTES = 30

Skill = Literal["install", "repair", "maintenance", "refrigerant-certified", "commercial"]
Priority = Literal["emergency", "standard", "maintenance"]
Reason = Literal["no-skill", "no-window-fit", "over-capacity"]
Minute = Field(ge=0, le=24 * 60)
Id = Field(min_length=1, max_length=64)


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=False)


class Point(_Strict):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class LunchWindow(_Strict):
    earliest: int = Minute
    latest: int = Minute


class Start(_Strict):
    point: Point
    at: int = Minute


class Tech(_Strict):
    id: str = Id
    name: str = Field(min_length=1, max_length=120)
    skills: list[Skill] = Field(min_length=1)
    shiftStart: int = Minute
    shiftEnd: int = Minute
    home: Point
    lunch: LunchWindow
    maxJobs: int = Field(ge=0, le=50)
    start: Optional[Start] = None

    @model_validator(mode="after")
    def _shift(self) -> "Tech":
        if self.shiftEnd <= self.shiftStart:
            raise ValueError("shiftEnd must be after shiftStart")
        if self.lunch.latest < self.lunch.earliest:
            raise ValueError("lunch.latest before lunch.earliest")
        if self.lunch.earliest < self.shiftStart or self.lunch.latest + LUNCH_MINUTES > self.shiftEnd:
            raise ValueError("lunch window must sit inside the shift")
        if self.start and (self.start.at < self.shiftStart or self.start.at >= self.shiftEnd):
            raise ValueError("start.at must be inside the shift")
        return self

    def route_start(self) -> Start:
        return self.start or Start(point=self.home, at=self.shiftStart)

    def lunch_required(self) -> bool:
        return self.route_start().at <= self.lunch.latest

    def lunch_earliest(self) -> int:
        return max(self.lunch.earliest, self.route_start().at)


class Pin(_Strict):
    techId: str = Id
    position: Optional[int] = Field(default=None, ge=1)


class Job(_Strict):
    id: str = Id
    customer: str = Field(min_length=1, max_length=120)
    address: str = Field(min_length=1, max_length=200)
    location: Point
    windowStart: int = Minute
    windowEnd: int = Minute
    durationMin: int = Field(ge=1, le=12 * 60)
    skill: Skill
    priority: Priority
    pin: Optional[Pin] = None

    @model_validator(mode="after")
    def _window(self) -> "Job":
        if self.windowEnd < self.windowStart:
            raise ValueError("windowEnd before windowStart")
        return self


class Problem(_Strict):
    version: Literal[1]
    date: str
    techs: list[Tech] = Field(max_length=100)
    jobs: list[Job] = Field(max_length=1000)

    @model_validator(mode="after")
    def _ids(self) -> "Problem":
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", self.date):
            raise ValueError("date must be YYYY-MM-DD")
        tech_ids = [t.id for t in self.techs]
        if len(set(tech_ids)) != len(tech_ids):
            raise ValueError("duplicate tech id")
        job_ids = [j.id for j in self.jobs]
        if len(set(job_ids)) != len(job_ids):
            raise ValueError("duplicate job id")
        for j in self.jobs:
            if j.pin and j.pin.techId not in tech_ids:
                raise ValueError(f"job {j.id} pinned to unknown tech")
        return self


class SolveRequest(_Strict):
    problem: Problem
    timeLimitMs: int = Field(ge=100, le=60_000)


class Stop(_Strict):
    jobId: str
    seq: int = Field(ge=1)
    driveMin: int = Field(ge=0)
    arrival: int = Minute
    start: int = Minute
    end: int = Minute
    slackMin: int = Field(ge=0)
    lateMin: int = Field(ge=0)  # always 0 since D-36 (no lateness); kept so the wire format and Phase 2's columns hold


class Lunch(_Strict):
    start: int = Minute
    end: int = Minute
    afterSeq: int = Field(ge=0)


class Route(_Strict):
    techId: str
    stops: list[Stop]
    lunch: Optional[Lunch]
    returnDriveMin: int = Field(ge=0)
    returnAt: int = Minute


class Unassigned(_Strict):
    jobId: str
    reasons: list[Reason] = Field(min_length=1)


class Objective(_Strict):
    unassignedEmergencies: int = Field(ge=0)
    lateMin: int = Field(ge=0)
    driveMin: int = Field(ge=0)


class PinConflictEntry(_Strict):
    jobId: str
    techId: str
    code: Literal["no-skill", "position-over-capacity", "no-window-fit", "position-taken", "over-capacity",
                  "infeasible-together", "search-limit"]


class PinConflictError(_Strict):
    error: Literal["pin-conflict"]
    pins: list[PinConflictEntry] = Field(min_length=1)
    detail: str


class Plan(_Strict):
    version: Literal[1]
    date: str
    routes: list[Route]
    unassigned: list[Unassigned]
    objective: Objective
    stoppedBy: Literal["solution-limit", "local-optimum", "trivial"]
