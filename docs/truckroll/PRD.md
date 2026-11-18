# Truckroll — PRD

Build-log item: **#24 Truckroll** (AI track). Repo: `shanelabountyai/truckroll` (public). Port: **7800**.
Base: saas-foundation **v1.6.2** (clone, shared history — never "Use this template").

## 1. Why this exists

An HVAC dispatcher builds each tech's day by hand: who has the skill, who is closest, whose shift fits the customer's
window, and what happens when an emergency no-heat call lands at 10:40. Truckroll does that planning with a constraint
solver, lets the dispatcher pin and override, re-plans when the day changes, and drafts the customer ETA texts.

Portfolio angle: the first build-log project with **optimization (vehicle routing with time windows)** and
**geospatial distance**. Sales angle: a live demo for home-services prospects in eastern Oklahoma (synthetic
Muskogee-area data only — no real customers).

## 2. Users and roles (foundation roles mapped)

| Person | Foundation role | Can |
|---|---|---|
| Owner | owner | everything, settings, metrics |
| Dispatcher | admin | jobs, techs, plan, pin, re-plan, approve ETA texts |
| Technician | member | own day only: route, job detail, status (en route / on site / done / can't complete) |

Each HVAC shop is one org. Two demo orgs (two shops) from `seed:demo`.

## 3. Scope v1

**Jobs:** customer (synthetic), address + lat/lng, service window (start/end), estimated duration, required skill
(`install`, `repair`, `maintenance`, `refrigerant-certified`, `commercial`), priority (`emergency` > `standard` >
`maintenance`), status.

**Technicians:** skills, shift start/end, home base (lat/lng), lunch break (30 min floating window), max jobs/day.

**Plan:** for a date, the solver assigns and orders jobs per tech, minimizing (in order) unassigned emergencies,
late arrivals, total drive minutes. Output per stop: tech, sequence, planned arrival, planned start, drive minutes,
slack. Unassignable jobs come back with a reason code (`no-skill`, `no-window-fit`, `over-capacity`).

**Pins:** dispatcher can pin a job to a tech (and optionally a sequence position). A re-plan never moves a pinned job.

**Re-plan:** mid-day, with jobs already `done`/`on site` frozen and techs' current positions as start points;
emergency insert is the main case.

**ETA texts:** for each customer, a short ETA message drafted by an LLM from the plan, reviewed by the dispatcher,
"sent" into the foundation's captured-message store (no real SMS in v1). Without an API key, a fixed template is
used. LLM calls go through the foundation's AI spend guard (`withBudget`, v1.6.0 §6).

**Metrics:** per plan — on-time %, drive minutes, utilization %, unassigned count by reason; plan vs actual once
statuses come in.

## 4. Out of scope v1

Real maps/geocoding APIs, real SMS, inventory/truck stock, invoicing, payments, customer self-booking (Bookable
covers booking), multi-day plans.

## 5. Architecture

- **App:** the foundation (Next.js 16, Prisma 7, Postgres). Clone-owned code in `src/app/o/[org]/dispatch/**`,
  `src/lib/dispatch/**`, `prisma/schema/truckroll.prisma`.
- **Solver:** Python service in `solver/` (FastAPI + Google OR-Tools routing, `pyproject.toml`, pinned versions).
  One endpoint: `POST /solve` taking a JSON problem, returning a JSON plan. Deterministic for the same input
  (fixed search parameters, time limit as an input, no randomness).
- **Contract:** `src/lib/dispatch/contract.ts` (zod) and `solver/contract.py` (pydantic) describe the same JSON;
  a shared fixture set in `fixtures/problems/*.json` round-trips through both.
- **Checker (oracle):** `src/lib/dispatch/check.ts` — pure TypeScript that validates any plan against its problem
  (skills, windows, shifts, pins, capacity, sequence continuity) and recomputes metrics. The solver is never
  trusted; every plan passes the checker before it is saved.
- **Distance:** `src/lib/dispatch/distance.ts` — haversine × road factor 1.35, at 45 mph average for drive time,
  rounded up to whole minutes. Same function ported in `solver/distance.py`; fixtures prove they agree to the
  minute.

## 6. Invariants (clone-owned, `tests/truckroll/`)

- TR-01 No stop is assigned to a tech lacking the job's required skill.
- TR-02 A plan the checker rejects is never persisted.
- TR-03 Re-plan never moves a pinned job, nor a job whose status is `on site` or `done`.
- TR-04 Same problem + same time limit → byte-identical plan JSON.
- TR-05 A technician (member) can read only their own day; another tech's stop 404s.
- TR-06 ETA text drafts are never "sent" without a dispatcher approval event in the audit log.

## 7. Phases and gates

| Phase | Scope | Gate |
|---|---|---|
| 0 | Clone foundation v1.6.2 into the repo, `new-project truckroll 7800`, CLONES row drafted | foundation CI green on `main` |
| 1 | **Pure engines, no database writes:** contract, distance (TS + Py), checker, solver service, fixtures (≥12 problems incl. infeasible ones), metrics | `npm test` + `pytest` green; every fixture's solver plan passes the checker; TR-01, TR-04 green |
| 2 | Schema, dispatcher board (jobs table, techs, plan view per tech as a timeline), pins, save plan | e2e: dispatcher plans the demo day; TR-02, TR-05 green |
| 3 | Tech day view (mobile width), statuses, mid-day re-plan with emergency insert | e2e: emergency at 10:40 lands with pins intact; TR-03 green |
| 4 | ETA text drafts (LLM via `withBudget`, template fallback), approval, metrics page, demo seed (Muskogee-area synthetic) | TR-06 green; demo script in README |

## 8. Open decisions (defaults in force; see `docs/DECISIONS.md`)

## 9. Design, UX and accessibility requirements (design pass, 2026-11-18)

The UI follows the Claude Design artboards in `docs/design/` (Main, MyDay, Metrics; gap designs BoardTools, StopDetail,
DemoEntry, OrgHome; D-60 to D-64). Findings are from the three independent reviews of the built UI (design **DF**, UX
**UX**, accessibility **A11Y**, numbered as in the design-pass PR). Tests: `e2e/design.spec.ts`, `tests/truckroll/look.test.ts`.

| ID | Requirement | Test / source |
|---|---|---|
| DR-01 | Every Truckroll page has 0 axe violations (wcag2a, wcag2aa, wcag21a, wcag21aa) in the light theme and under a dark OS setting, including with every disclosure open (Emergency insert, Add a job, Add a technician, Can't complete). | `design.spec.ts` (A11Y-2, A11Y-3, A11Y-5) |
| DR-02 | The app is light only: under `prefers-color-scheme: dark` the page keeps its light colours (D-66). | `design.spec.ts` |
| DR-03 | Every job status and priority is shown as word + glyph + colour; colour is never the only signal. An emergency block on the timeline shows a visible "!". | `look.test.ts`, `design.spec.ts` (A11Y-1) |
| DR-04 | Every board, My day, stop, metrics and home page fits 390 px with no sideways page scroll; wide tables and the timeline scroll inside a named, focusable region. | `design.spec.ts`, `dispatch.spec.ts` |
| DR-05 | Every button and form control in the page content is at least 44 px tall; the tech's status buttons are 64 px. | `design.spec.ts` |
| DR-06 | The first Tab stop is "Skip to content"; every focusable element shows a 3 px focus ring, date and time inputs included. Timeline blocks are links named "Stop n, job J… · skill, priority, start to end, …", and Enter opens the stop. | `design.spec.ts` (A11Y-4) |
| DR-07 | A control's accessible name contains its visible label (WCAG 2.5.3). | axe `label-content-name-mismatch`; `design.spec.ts` (A11Y-2, A11Y-3) |
| DR-08 | The timeline and tech screens say when work **starts** (the promise inside the window); arrival is labelled as arrival, with the wait before start. No copy says "every arrival is inside the window". | `design.spec.ts` (UX-M5) |
| DR-09 | A job added after the current plan was saved (Add a job, or an emergency whose re-plan was refused, D-45) is listed under Not placed as "added after this plan was saved"; an emergency among them raises the red banner. | `design.spec.ts` (UX-M3) |
| DR-10 | The metrics page leads with **Arrived on time** (actual, from recorded on-site times; "—" until there are some), with the planned figure beside it. | metrics page (DF-2) |
| DR-11 | The header shows the org's own name, never a mockup shop name; no mockup sample values ship; the footer reads "All data is synthetic … Built by Lab Intelligence." | D-62; DF review |
| DR-12 | A refused action shows as a red-edged message next to its form; Pin needs a technician chosen before it submits. | `theme.css`; UX-S1, UX-S2 |
| DR-13 | The README demo script works on the seeded "today": the pin it suggests has an afternoon window, and the 10:40 step says to mark the morning's started stops first. | README (UX-M1) |
