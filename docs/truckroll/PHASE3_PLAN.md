# Truckroll Phase 3 plan — tech day view, statuses, mid-day re-plan

Branch `phase-3` off `main` (Phases 1 and 2 merged, PRs #1 and #2). One PR, "Truckroll Phase 3: tech day view,
statuses, mid-day re-plan", never merged by Claude.

## Scope (PRD §7, Phase 3 — nothing from Phase 4)

| PRD item | What it means here |
|---|---|
| Tech day view (mobile width) | `/dispatch/my-day` rebuilt for a phone: one card per stop, the current stop first-class, big status buttons, no horizontal scroll at 360–390 px. The stop page gets the same buttons. |
| Statuses | A technician moves their own stops through `en route → on site → done`, or `can't complete` (with a note). The dispatcher may set any stop's status. Times are recorded (`enRouteAt`, `onSiteAt`, `doneAt`) for Phase 4's plan-vs-actual, which is **not** built here. |
| Mid-day re-plan with emergency insert | **Re-plan from HH:MM** on the board, and an **Emergency insert** form that adds an emergency job and re-plans in one step. Started work stays where it is; techs start from where their statuses put them; pins are kept (D-37); jobs only inside their windows (D-36). |

Out (Phase 4+): ETA texts, approvals (TR-06), metrics page, plan-vs-actual numbers, Muskogee demo seed.

Owner decisions that bind this phase: **D-36** (no lateness; a job that can't fit is unassigned with a verified reason)
and **D-37** (pins are never dropped or moved; an impossible pin set is a pin-conflict naming the pins). A pin outranks
an emergency: an emergency that only fits by moving a pin stays unassigned with its reason, and the dispatcher is told.

## Re-plan model (`src/lib/dispatch/replan.ts`, pure)

Input: the day's current saved plan, the day's jobs with statuses, the techs, and `asOf` (minutes after midnight).

- **Frozen** jobs: `on_site`, `done` (PRD/TR-03), plus `en_route` and `cant_complete` (D-39). They are not sent to the
  solver. Each stays on the tech, at the place in the day, with the times the current plan gave it.
- **Start per tech** (D-40, no GPS): the active stop (`en_route`/`on_site`) if any, else the last finished stop, else
  home. `start.at` = when that work ends (actual `onSiteAt`/`doneAt` when recorded on the plan's date, else the planned
  times), never before `asOf` or the shift start. A tech whose free time is at or past shift end gets `maxJobs: 0`.
- **Capacity**: `maxJobs` minus the tech's frozen stops.
- **Lunch** (D-41): if the current plan's lunch for the tech started before `asOf`, it is taken: the problem says
  `lunchTaken: true` (new optional contract field, both languages; checker and feasibility honour it). Lunch in progress
  pushes `start.at` to its end.
- **Pins** (D-43): positions count from the first stop of the day, so a re-plan position is `pinPosition − frozen`. A pin
  whose position is already filled by started work is a pin-conflict `position-taken` (no solve). Everything else goes
  through the same `pinConflicts` pre-check and solver as Plan the day.
- **Merge**: frozen stops (renumbered 1..k, times unchanged) + the solver's stops (seq + k). Lunch: the solver's, or the
  taken one. The saved `DispatchPlan.plan` is the merged day; `problem` is the re-plan problem; `asOf` and
  `basePlanId` are new columns (D-47).

## Safety rails (never trust the solver, D-03)

1. `checkPlan(replanProblem, output)` — skills, windows (D-36), shifts, lunch, pins (D-37), reasons (D-32).
2. `checkReplan(state, merged)` — every frozen stop is in the merged plan on the same tech, same order, same times, ahead
   of every new stop; every pinned job is on its tech and at its day position; every job of the day appears exactly once;
   nothing else changed. Only if both pass is anything written (TR-02 extends to re-plans).
3. The problem is rebuilt inside the write transaction under the org's dispatch lock; if it changed, nothing is saved
   (D-28).
4. Plan the day is refused once any job on the day is underway or finished (D-42): only a re-plan can save over started
   work.

## Tasks

1. This plan (first commit).
2. Contract `lunchTaken` (TS + Py), checker/feasibility/solver honour it; fixtures `17-replan-lunch-taken`,
   `18-replan-pin-outranks-emergency` + goldens; pytest + cross-language coverage.
3. Schema: `Job.enRouteAt/onSiteAt/doneAt/statusNote`, `DispatchPlan.asOf/basePlanId`; hand-written migration (D-24 CI
   diff proves it).
4. `replan.ts` (build, merge, checkReplan, merged metrics) + `plan-store.ts` day-state loader and save path.
5. Actions: `setJobStatus` (tech: own current stops; dispatcher: any), `replanDay`, `insertEmergency`; `planDay`
   refuses started days.
6. Pages: My day (mobile), stop page statuses, board: Re-plan from, Emergency insert, unassigned-emergency alert,
   frozen markers.
7. Tests and e2e (below). CI: the `ci` job starts the solver before vitest so TR-03 runs against the real solver there.

## Acceptance → proof

| Acceptance item | Proof |
|---|---|
| **TR-03** re-plan never moves a pinned job, nor an `on site`/`done` job | `tests/truckroll/tr-03-replan.test.ts`: (a) live solver (required in CI): demo day at 10:40 with statuses and pins, emergency added → frozen stops identical (tech, order, times), pinned jobs on their tech at their position; (b) planted solver outputs that move a pinned job, move/drop/retime a frozen stop → refused, nothing written, audited; (c) `checkReplan` unit cases in `replan.test.ts`. |
| **10:40 emergency e2e** | `e2e/replan.spec.ts`: dispatcher pins two jobs, plans the demo day; Muskogee One (phone viewport) marks stop 1 on site; dispatcher marks other started work; Emergency insert at 10:40 → "Re-plan saved as of 10:40", the emergency is on a route, both pins on their tech/position, started stops unchanged. |
| A pin outranks an emergency | `tr-03-replan.test.ts` + `replan.test.ts`: an emergency that only fits in a pinned slot stays unassigned with a checker-verified reason; the board shows the alert. |
| Pin conflicts surface like Plan the day | re-plan with an impossible pin (and with a position taken by started work) → the same "pins can't all be kept" message naming the job, nothing saved. |
| Statuses | `tests/truckroll/job-status.test.ts`: transitions, one active stop per tech, a tech can't touch another tech's stop (404, TR-05 style), dispatcher can; times recorded; audit rows. |
| Mobile tech day | e2e at 390×844: no horizontal scroll, status buttons move the stop along. |
| TR-04 still holds | `tr-04-determinism.test.ts` covers the new fixtures; `replan.test.ts` builds the same problem twice from the same state → identical JSON. |
| No regressions | lint, typecheck, vitest, pytest, solver bench p95 < 2000 ms, Playwright, all green on GitHub CI. |

## Gate

lint · typecheck · vitest · pytest · solver p95 bench (< 2 s per fixture) · Playwright e2e incl. the 10:40 emergency ·
TR-03 green · GitHub CI green. Then stop; no Phase 4.

## Risks

- Prisma's schema engine can't run in the sandbox (D-12): migration hand-written, CI's `migrate diff` is the gate.
- Real clock vs. the fixed demo date: the re-plan time is an explicit input (D-38), so e2e and tests don't depend on
  the wall clock.
