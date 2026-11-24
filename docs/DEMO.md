# Truckroll demo walk-through

**Not deployed.** Truckroll runs on a laptop against synthetic data only: two made-up shops around Muskogee and
Tahlequah, Oklahoma, invented customers, fictional 918-555-01xx numbers. No real SMS is ever sent; an approved text
lands in the app's captured-message store. Written 2026-11-24 from `main` at `aa4897e`.

## At a glance

| | |
|---|---|
| **Who it is for** | The dispatcher at a small HVAC shop who builds each technician's day by hand (PRD §1–2); the technicians who work that day from a phone; the owner who reads how the day went. |
| **What was decided** | A real route solver (Python + Google OR-Tools) whose answers are never trusted: a TypeScript checker re-checks every plan before it is saved (D-02, D-03, D-32). Hard service windows, no late arrivals (D-36, Shane). Pinned jobs are never moved or dropped (D-37, Shane). No ETA text is sent without a dispatcher's approval, enforced in the app and by a database trigger (D-54). |
| **What was left out** | Paid maps and geocoding (D-01), real SMS (D-05), a map on screen (D-61), invoicing, payments, inventory, customer self-booking, multi-day plans (PRD §4), dark mode (D-66), a 30-day metrics view (D-68). |
| **The complete journey** | Sign in → the day's jobs and technicians → pin a job → **Plan the day** → a technician marks stops on a phone → a 10:40 emergency is inserted and the day re-planned around started work and pins → the dispatcher approves customer ETA texts → metrics compare plan with actual. |
| **Why come back in week three** | Every working day starts with a plan and usually needs a re-plan; the metrics page shows how arrivals and job lengths compared with the plan for any day. This is design intent only: nobody has used it for three weeks, and there is no multi-week view (D-68). |
| **The design** | Navy header, amber mark, blue actions, red for emergencies (D-60); a timeline per technician instead of a map (D-61); light only (D-66); 64 px status buttons on the technician's phone (DR-05); axe WCAG 2.1 AA checks on every page state the e2e reaches (D-71, DR-01). |

## How to read "verified"

"Verified by" names the automated test that drives that stop. Those tests last passed together in CI on `main`
(run [44571003644](https://github.com/shanelabountyai/truckroll/actions/runs/44571003644), 2026-11-19, `aa4897e`).
They were **not** re-run in the 2026-11-24 session that wrote this file (no Postgres there, D-76); the pack PR's CI
runs them again. Most e2e steps run on the fixed day `2026-11-16`, not on "today". "Not yet clicked through by Shane"
means no test covers it and no person has checked it by hand either.

## Start it

Needs Node 22, a local Postgres 17 and Python 3.12 or 3.13 (README "Run it locally").

```bash
npm ci && npm run db:setup
cd solver && python3 -m venv .venv && .venv/bin/pip install -e . && cd ..
(cd solver && .venv/bin/uvicorn app:app --port 7801) &   # the planner
npm run seed:demo && npm run seed:dispatch               # demo shops, then the demo days
npm run dev                                              # http://localhost:7800/demo (DEMO_MODE=1)
```

`seed:dispatch` creates the fixed day 2026-11-16 plus yesterday (finished, with recorded times), today and tomorrow in
America/Chicago (D-58). Optional: `ANTHROPIC_API_KEY` in `.env.local` makes Claude write the ETA drafts; without it
every draft uses the fixed template (D-06, D-50).

## The stops

1. **Demo sign-in.** Open `/demo`, choose `admin@acme.demo.test`, then **Acme Studio**.
   Verified by `e2e/demo.spec.ts` › "demo sign-in lands a seeded owner in their org".
2. **The dispatcher's board.** **Dispatch** opens on today: 24 jobs and 6 technicians, with skills, shifts and lunch
   windows. Verified by `e2e/dispatch.spec.ts` › "dispatcher pins a job and plans the demo day" (24 jobs, 6 technicians,
   on 2026-11-16).
3. **Pin a job.** In the Jobs table, pin `J10` to **Tahlequah One**. Verified by the same test, which pins `J02` on
   2026-11-16; the README's `J10`-on-today suggestion itself is not tested.
4. **Plan the day.** Press **Plan the day**: one timeline per technician, a stops table under each, on-time %, drive
   minutes and utilization; the pin holds. Verified by the same test ("Plan saved: 24 stops, 0 unassigned", the pin on
   Tahlequah One's route).
5. **The timeline, by keyboard.** Tab from "Skip to content"; each timeline block is a link that opens its stop.
   Verified by `e2e/design.spec.ts` › "the dispatcher board, planned today: axe, keyboard, targets, timeline blocks open
   stops" (skipped on a run whose today is 2026-11-16).
6. **The technician's phone.** Sign in as `member@acme.demo.test`, open **My day**: Muskogee One sees only their own
   stops, and another technician's stop is a 404 (TR-05). Verified by `e2e/dispatch.spec.ts` › "a technician sees only
   their own day; another tech's stop is a 404".
7. **On site, then Done.** At phone width, press **On site** and **Done** on the first stop. Verified by
   `e2e/dispatch.spec.ts` › "a technician works their day at phone width" and `e2e/design.spec.ts` › "the technician's
   day and stop page at 390 px: the current stop is the big card; axe clean".
8. **Record the morning.** As the dispatcher, open each stop that should have started by 10:40 and press **On site** /
   **Done** (an unmarked stop counts as not started, D-40). Verified by `e2e/dispatch.spec.ts` › "the emergency at 10:40
   lands with pins and started work intact (TR-03)" (its first half).
9. **10:40, a no-heat call.** **Emergency insert**: re-plan from `10:40`, job `E1040`, latitude `35.765`, longitude
   `-95.345`, skill `repair`, **Add emergency and re-plan**. Started work and pins stay put; the emergency goes on a
   route. Verified by the same test (TR-03).
10. **The phone after the re-plan.** The technician's My day shows the new route. Verified by `e2e/dispatch.spec.ts` ›
    "the technician's phone shows the re-planned day".
11. **Customer ETA texts.** **Draft ETA texts**, edit one, **Approve and send** it, then **Approve and send all**. The
    emergency has no phone, so its draft can't be sent. Verified by `e2e/dispatch.spec.ts` › "the dispatcher drafts,
    edits and approves ETA texts; only approved texts are sent (TR-06)" (template path: CI has no API key).
12. **A Claude-written ETA text.** With `ANTHROPIC_API_KEY` set, drafts come from Claude through `withBudget` and are
    used only if they pass the D-51 checks. Not yet clicked through by Shane; never run against the live API (the unit
    tests in `tests/truckroll/eta-llm.test.ts` use a stub model).
13. **The audit log.** **Audit log** in the org menu lists each approval (`dispatch.eta_approved`). Partly verified: the
    page renders by `e2e/security-pages.spec.ts` › "settings pages render for the Acme Studio demo owner", and the
    approval rows exist by the TR-06 e2e test's database check; seeing those rows on the page is not yet clicked
    through by Shane.
14. **Metrics for the day.** **Metrics for …**: the current plan's numbers and both saved plans (Plan the day, the
    10:40 re-plan). Verified by `e2e/dispatch.spec.ts` › "the metrics page shows the day's plans and plan vs actual".
15. **Yesterday, plan vs actual.** Change the day to yesterday: arrived in window, start against plan, length against
    estimate, 23 done and one stop that couldn't be completed. Verified by the same test (its yesterday half, which
    runs unless yesterday is 2026-11-16).
16. **A technician can't reach the dispatcher's pages.** As `member@acme.demo.test`, the metrics and board URLs send
    you to My day. Verified by `e2e/dispatch.spec.ts` › "a technician can't open the metrics page or approve texts".
17. **Two shops.** Sign in as `admin@globex.demo.test`: Globex is a separate shop and sees none of Acme's data.
    Partly verified: Globex's owner pages render by `e2e/security-pages.spec.ts` › "settings pages render for the
    Globex Labs demo owner", and cross-org access is refused by the foundation's invariant harness
    (`tests/invariants/`, INV-01 to INV-04); Globex's dispatch board itself is not yet clicked through by Shane.
18. **Phone width everywhere.** Board, metrics and shop home at 390 px with no sideways scroll, axe clean. Verified by
    `e2e/design.spec.ts` › "the board, metrics and home at 390 px: no sideways page scroll, axe clean".

**Tally:** 15 of 18 stops verified by a named test, 2 partly (13, 17), 1 not (12). No stop has been clicked through by
Shane on record.
