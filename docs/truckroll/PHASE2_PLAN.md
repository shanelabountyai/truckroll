# Truckroll Phase 2 plan — schema, dispatcher board, pins, save plan

Branch `phase-2` off `kickoff` (PR #1 is approved but not merged yet), PR #2 "Truckroll Phase 2: dispatcher board"
against `kickoff`. Once #1 merges, #2 is retargeted to `main` (D-23). Gate (PRD §7): e2e "dispatcher plans the demo
day"; TR-02 and TR-05 green; lint, typecheck, test, pytest green.

## Schema (`prisma/schema/truckroll.prisma`)

All org-owned (`orgId` + `Org` relation, back-relations in `core.prisma` marked `// app`, the drift-excused form).
Times stay integer minutes after local midnight (D-19); dates are `@db.Date`.

| Model | Fields (beyond id, orgId, timestamps) |
|---|---|
| `Technician` | `name`, `skills String[]`, `shiftStart`, `shiftEnd`, `homeLat`, `homeLng`, `lunchEarliest`, `lunchLatest`, `maxJobs`, `userId?` (the member who *is* this tech; unique per org) |
| `Job` | `ref` (shop job number, unique per org+date), `customer`, `address`, `lat`, `lng`, `date`, `windowStart`, `windowEnd`, `durationMin`, `skill`, `priority` (enum), `status` (enum: `unscheduled`, `scheduled`, `en_route`, `on_site`, `done`, `cant_complete` — the last four used from Phase 3), `pinTechId?`, `pinPosition?` |
| `DispatchPlan` | `date`, `createdById`, `problem Json`, `plan Json`, `metrics Json`, `driveMin`, `lateMin`, `unassignedCount`, `stoppedBy` — append-only history; the newest for a date is current |
| `PlanStop` | `planId`, `techId`, `jobId`, `seq`, `arrival`, `start`, `end`, `driveMin`, `slackMin`, `lateMin` — the plan's stops as rows, so a tech's day is a scoped query (TR-05) |

Migration hand-written in Prisma's shape (the sandbox can't run the schema engine, D-12), plus `npm run rls:policies`
for the four tables. CI gets a new step, `prisma migrate diff --from-migrations … --to-schema … --exit-code`, so a
mismatch between the hand-written SQL and the schema fails CI (D-24). Export: all four tables (INV-34).

## Roles

Dispatcher = `org.update` (owner, admin). The foundation's permission list is template-owned, so no new permission
(D-25). Technician = member with a linked `Technician` row; members without one see nothing to do.

## Pages (`src/app/o/[org]/dispatch/**`)

- `/dispatch?date=YYYY-MM-DD` (dispatcher): jobs table with pin controls, techs table, **Plan the day** button,
  the current plan as one timeline per tech (stops and lunch as positioned blocks, plus an accessible table), unassigned
  jobs with reason codes, plan metrics. Add-job and add-tech forms.
- `/dispatch/my-day?date=` (technician): the member's own stops for the date.
- `/dispatch/stops/[id]` (technician or dispatcher): one stop. A technician asking for another tech's stop gets the
  same `notFound` as a missing id (TR-05).
- Home (`/o/[org]`) links to the board or to My day by role.

## Actions (`dispatch/actions.ts`, all `orgAction`, every id a `ref(...)`)

`addJob`, `addTech`, `pinJob` (job, tech, optional position), `unpinJob`, `planDay` (date).

`planDay`: build a `Problem` from the date's jobs and the org's techs → `solveProblem` (HTTP `POST $SOLVER_URL/solve`,
default `http://127.0.0.1:7801`, D-26) → `checkPlan` → only if `ok`, one `withOrg` transaction writes the
`DispatchPlan`, its `PlanStop`s, job statuses (`scheduled` / `unscheduled`) and audit `dispatch.plan_saved`. A rejected
plan writes nothing but an audit `dispatch.plan_rejected` with the checker's codes and returns an error (TR-02).
A solver outage returns "Solver unavailable" and writes nothing.

## Seed

`scripts/truckroll/seed-dispatch.ts` (`npm run seed:dispatch[:test]`): fixture `03-demo-day` into Acme on 2026-11-16
(6 techs, 24 jobs; `member@acme.demo.test` is tech "Muskogee One"), fixture `02-skill-split` into Globex. Idempotent:
replaces that org+date's jobs and plans. Runs after `seed:demo`. (The full Muskogee demo seed is Phase 4.)

## Tests

- `tests/truckroll/tr-02-persist.test.ts`: solver stubbed with (a) a planted bad plan → error, zero plans/stops, job
  statuses unchanged, a `plan_rejected` audit row; (b) the fixture-03 golden plan mapped onto the seeded ids → saved,
  stops match, statuses set; (c) solver down → nothing written.
- `tests/truckroll/tr-05-tech-day.test.ts`: two members linked to two techs; each sees only their stops; the other's
  stop page and a random id both `notFound`; a member without a tech gets an empty day; a dispatcher sees any stop.
- `tests/truckroll/dispatch-actions.test.ts`: pin/unpin (pin to a tech in another org → notFound), problem building.
- INV-01..04 harness picks the new actions up automatically; `tests/fixtures/app.ts` seeds a tech and a job per org.
- `e2e/dispatch.spec.ts`: seed; admin signs in through `/demo`, opens the board for 2026-11-16, pins one job, plans the
  day, sees six timelines, the pinned job on its tech, 0 unassigned, "Plan saved"; then the member opens My day and
  sees only Muskogee One's stops, and another tech's stop URL is a 404.
- CI: the `ci` job starts the solver (`uvicorn app:app --port 7801`) before Playwright and sets `SOLVER_URL`.

## Risks

- Hand-written migration drift → the CI `migrate diff` step (D-24).
- e2e needs Python in the `ci` job → setup-python + pip cache, ~20 s.
- Server actions calling an HTTP solver: timeout 10 s, never trusted (checker), never a secret in the URL.
