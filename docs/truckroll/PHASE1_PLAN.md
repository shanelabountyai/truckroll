# Truckroll Phase 1 plan — pure engines, no database writes

Branch `kickoff`, PR #1 "Truckroll Phase 1: pure engines" against `main` (never merged by Claude). Scope is PRD §5 and
§7 row 1. Nothing here touches Prisma, routes or the database.

## Model (what the engines agree on)

All times are **integer minutes after local midnight** on the plan date; all distances go through `distance`.

- **Drive minutes** (D-01): haversine (R = 3958.8 mi) × 1.35 road factor at 45 mph, `ceil(minutes − 1e-9)`; the epsilon
  keeps libm last-bit differences between V8 and CPython from flipping a whole minute. Same point → 0.
- **Route** for one tech: leaves its start (home base, or `start` override for a re-plan) at `shiftStart` (or `start.at`),
  visits stops in `seq` order, returns home. Waiting happens at the customer.
- **Stop timing**: the tech leaves as soon as the previous stop ends (`free` = previous `end`, or the route start).
  `arrival = free + drive`, `start ≥ max(arrival, windowStart)`, `end = start + duration`, `slack = start − arrival`.
  In the gap holding lunch (`lunch.afterSeq` = that gap, 0 = before the first stop): `lunch.start ≥ free`; if lunch
  starts no later than `free + drive` it interrupts the drive and `arrival = free + drive + 30`, otherwise it is eaten on
  arrival and `arrival = free + drive`; either way `lunch.end ≤ start` of the next stop (or `≤ shiftEnd` in the last
  gap, where `returnAt` is the arrival home). This matches OR-Tools' break semantics (break during travel or waiting).
  *(Revised during the build: the first draft had the tech always eat before driving, which is stricter than the
  solver's model and could push a stop later than the solver planned.)*
- **Windows**: start before `windowStart` is never allowed. Start after `windowEnd` is **late**; lateness is capped at
  `maxLateMin` (problem field, default 60) — beyond that the job does not fit (D-15).
- **Shift**: the route must be home by `shiftEnd`. **Lunch** (30 min) starts within `[lunch.earliest, lunch.latest]`
  and is required on every non-empty route; empty routes carry `lunch: null` (D-16).
- **Capacity**: at most `maxJobs` stops per tech.
- **Pins**: `pin.techId` (and optional 1-based `pin.position`) are hard; a pinned job that cannot be honoured comes back
  unassigned instead of breaking the solve (D-17).
- **Objective** (D-04, lexicographic via penalties in `solver/objective.py`): pinned drop 10^10 > emergency drop 10^9 >
  standard drop 10^6 > maintenance drop 10^5 > lateness 10^3 per minute > drive 1 per minute. With `maxLateMin` = 60 a
  job's worst lateness (6·10^4) costs less than dropping any job.
- **Reason codes**: `no-skill` (no tech — or the pinned tech — has the skill), `no-window-fit` (no skilled tech could
  do the job alone inside its shift, window cap and lunch), `over-capacity` (individually feasible, but dropped by the
  solver for time or `maxJobs`). The first two come from a pre-check; the solver never sees those jobs.
- **Determinism** (TR-04): one search worker, `PARALLEL_CHEAPEST_INSERTION` then `GREEDY_DESCENT` to a local optimum,
  bounded by a solution limit (never the clock); `timeLimitMs` is a hard cap, and the plan says
  `"stoppedBy": "time-limit"` if it ever bites (determinism is only promised when it doesn't). *(Revised: the draft
  said guided local search, but GLS has no natural end and ran to the clock on small fixtures — see D-18.)* After the search, timings are normalised by a deterministic
  earliest-start forward pass (never later than the solver's, so feasibility is kept). JSON is emitted with sorted keys
  and no whitespace (D-18).

## Files

| Path | What |
|---|---|
| `src/lib/dispatch/contract.ts` | zod schemas: `Problem`, `Plan`, `SolveRequest`, reason codes, skills, priorities |
| `src/lib/dispatch/distance.ts` | `haversineMiles`, `driveMinutes` |
| `src/lib/dispatch/check.ts` | checker/oracle: `checkPlan(problem, plan) → { ok, errors[], metrics }` |
| `src/lib/dispatch/metrics.ts` | on-time %, drive minutes, utilization %, unassigned by reason |
| `solver/pyproject.toml` | pinned: ortools 9.15.6755, fastapi 0.162.7, uvicorn 0.54.0, pydantic 2.14.3, httpx 0.28.1, pytest 9.2.0 |
| `solver/contract.py` | pydantic mirror of `contract.ts` |
| `solver/distance.py` | port of `distance.ts` |
| `solver/objective.py` | penalty constants (D-04) |
| `solver/solve.py` | pre-check + OR-Tools routing model + normalisation |
| `solver/app.py` | FastAPI, `POST /solve`, `GET /health` |
| `solver/cli.py` | stdin problem → stdout plan (same code path; used by the cross-language test) |
| `solver/bench.py` | p95 per fixture, integer ms, fails over 2000 |
| `fixtures/geo.json` | D-10 bounding box, two shops |
| `fixtures/problems/*.json` | `{ name, description, timeLimitMs, problem, expect }` |
| `fixtures/plans/*.json` | golden solver plans, so the checker and metrics tests run without Python |
| `scripts/truckroll/gen-fixtures.ts` | deterministic fixture generator (seeded PRNG) |
| `tests/truckroll/*.test.ts` | vitest: contract, distance, checker negatives, metrics, TR-01, TR-04, cross-language |
| `solver/tests/*.py` | pytest: contract round-trip, distance agreement, solve per fixture, `/solve` via TestClient, TR-04 |
| `.github/workflows/ci.yml` | new `solver` job: Python 3.13 + Node 22, pytest, solver-dependent vitest, bench |

## Fixtures (≥ 12)

1. `01-single-job` — one tech, one job.
2. `02-skill-split` — two techs, disjoint skills.
3. `03-demo-day` — both shops, 6 techs, 24 jobs, mixed priorities.
4. `04-tight-windows` — narrow windows force an order.
5. `05-emergency-first` — too much work: maintenance dropped, emergencies kept.
6. `06-lunch-squeeze` — lunch window between back-to-back jobs.
7. `07-max-jobs` — `maxJobs` binds → `over-capacity`.
8. `08-missing-skill` — `commercial` job, nobody certified → `no-skill`.
9. `09-impossible-window` — 05:00–05:30 window, shifts start 08:00 → `no-window-fit`.
10. `10-over-capacity` — one tech, a day's worth of jobs plus more → `over-capacity`.
11. `11-pinned-job` — job pinned to the farther tech.
12. `12-pinned-position` — pin with `position: 1`.
13. `13-late-but-ok` — lateness within the cap; plan shows late minutes.
14. `14-all-reasons` — one of each reason code in one problem.
15. `15-replan-start` — tech `start` override (mid-day position).
16. `16-pin-wrong-skill` — job pinned to a tech without the skill → `no-skill`.

`expect` holds `unassigned` (job id → reason codes, exact) and/or `unassignedCounts` (reason → count) where the solver
may choose which job to drop, plus `assigned` ids that must be on a route.

## Tests and gate

- vitest: distance known values; contract parses every fixture; checker rejects planted bad plans (wrong skill,
  window, shift, lunch overlap, capacity, pin, seq gap, drive mismatch, duplicate/missing job); metrics values.
- Cross-language (vitest, needs the solver's Python): every fixture → `solver/cli.py` → `checkPlan` ok, expected reasons;
  TS and Py drive matrices equal for every fixture; **TR-01** (no stop lacks the skill, plus a negative control);
  **TR-04** (two solves byte-identical). Skips when no solver Python is configured unless `TRUCKROLL_REQUIRE_SOLVER=1`,
  which the CI `solver` job sets so it can never silently skip there.
- pytest: same fixtures through `solve()` and `POST /solve`; TR-04 in Python; distance known values (the cross-language
  vitest compares the TS and Python matrices live).
- Gate: lint, typecheck, test, pytest green; all fixture plans pass the checker; reasons match; bench p95 < 2000 ms per
  fixture on CI (numbers in the PR body as integers).

## Risks

- OR-Tools break intervals and determinism: mitigated by solution-limit stop + single worker + normalisation; TR-04 runs
  twice per fixture in both languages.
- Float drift between V8 and CPython in `driveMinutes`: epsilon ceil + an all-pairs agreement test.
- CI runtime: the solver job installs ortools (~30 MB wheel); cached by pip.
- Sandbox limits (D-11/D-12): local gate uses a Prisma stand-in; CI is authoritative.
