# truckroll

> Cloned from saas-foundation v1.6.2. Port 7800. Upgrade with `npm run foundation:status`; template-owned paths are listed in the template's plan §3.2.

## Truckroll — HVAC dispatch (build log #24)

Truckroll plans an HVAC shop's day with a constraint solver: who has the skill, who is closest, whose shift fits the
customer's window. The dispatcher can pin jobs, re-plan mid-day when an emergency lands, and send customers ETA texts
after approving them. Product spec: `docs/truckroll/PRD.md`; decisions: `docs/truckroll/DECISIONS.md`; phase plans:
`docs/truckroll/PHASE1_PLAN.md` … `PHASE4_PLAN.md`. All data is synthetic (Muskogee and Tahlequah, Oklahoma; made-up
customers, "Synthetic OK" addresses, fictional 918-555-01xx numbers). No real SMS is ever sent: an approved text lands
in the captured-message store.

How it fits together: `solver/` is a Python service (FastAPI + Google OR-Tools, `POST /solve` on port 7801). The app
never trusts it: every plan passes the TypeScript checker `src/lib/dispatch/check.ts` before it is saved. Invariants
TR-01 to TR-06 are in `tests/truckroll/`.

### Run it locally

```bash
npm ci && npm run db:setup                     # Postgres 17 running locally (Quickstart below)
cd solver && python3 -m venv .venv && .venv/bin/pip install -e . && cd ..
(cd solver && .venv/bin/uvicorn app:app --port 7801) &   # the planner
npm run seed:demo && npm run seed:dispatch     # demo orgs, then the Truckroll demo days
npm run dev                                    # http://localhost:7800
```

`seed:dispatch` seeds Acme (6 technicians, 24 jobs a day) and Globex (a smaller shop). It creates four days: the fixed
e2e day 2026-11-16, then three days around today in Chicago time. **Yesterday** is finished: it has a saved plan, and
every stop has recorded times. **Today** and **tomorrow** are waiting to be planned. Re-running it resets those days.

ETA texts are written by Claude when `ANTHROPIC_API_KEY` is set in `.env.local`. Every model call goes through the
foundation's AI spending limit (`withBudget`; the demo org's limit is $1.00), and Claude's text is only used if it
passes the checks in `src/lib/dispatch/eta.ts`. Without the key, every draft uses the standard template.

### Demo script (about 10 minutes)

Sign in at `http://localhost:7800/demo` and pick the account named in each step. Use the board's **Day** picker to
move between days.

1. **The dispatcher's board.** Sign in as `admin@acme.demo.test` → **Acme Studio** → **Dispatch**. The board opens on
   today: 24 jobs and 6 technicians, with skills, shifts and lunch windows.
2. **Pin a job.** In the Jobs table, pin `J10` (an afternoon window) to **Tahlequah One**. Pinned jobs are never moved or dropped. If the
   pins can't all be kept, the board names the pins to change and saves nothing.
3. **Plan the day.** Press **Plan the day**. The solver answers in well under a second, and the result is shown only
   after the checker passes it: one timeline per technician, a stops table under each, and on-time %, drive minutes
   and utilization. Every job starts inside its window; a job that can't fit is listed as unassigned, with the reason.
4. **The technician's phone.** In a second browser, or with your phone's screen size, sign in as
   `member@acme.demo.test` and open **My day**. Muskogee One sees only their own stops. Press **On site**, then
   **Done**, on the first stop.
5. **10:40, a no-heat call.** First record the morning: a stop nobody marked counts as not started, so a re-plan
   would treat morning jobs whose window has passed as unplaceable (and a pinned one blocks the re-plan). On the board,
   open each stop that should have started by 10:40 (select its block on the timeline) and press **On site**, then
   **Done** for the finished ones. Then open **Emergency insert** under **Mid-day re-plan**. Re-plan from `10:40`, job `E1040`, any
   address with latitude `35.765` and longitude `-95.345`, skill `repair`, and press **Add emergency and re-plan**.
   Started work and pins stay exactly where they were, and the emergency goes on a route. If the only room for it is
   taken by a pin, the pin wins and the board tells you.
6. **Customer ETA texts.** In **Customer ETA texts**, press **Draft ETA texts**. Read the drafts, edit one, and press
   **Approve and send** on it, then **Approve and send all**. Nothing is sent until you approve it. Each approval is
   written to the audit log (**Audit log** in the org menu, action `dispatch.eta`), and the database refuses to mark a text sent
   without that approval (TR-06). The sent texts are in the captured-message store, not on anyone's phone.
7. **Metrics.** Open **Metrics for …**. It shows the current plan's numbers and every plan and re-plan saved that day.
   Change the day to **yesterday** to see plan vs actual: arrived in window, average start against plan, job length
   against estimate, and one stop that couldn't be completed.
8. **Two shops.** Sign in as `admin@globex.demo.test`. Globex is a separate shop and sees none of Acme's data.

To run the demo on the fixed e2e day instead, open `?date=2026-11-16` (the Phase 2–4 e2e in `e2e/dispatch.spec.ts`
runs the same steps there).

A Next.js 16 + Prisma 7 + Postgres template with the parts every multi-tenant app rebuilds: magic-link sign-in with TOTP,
orgs and roles, one authorization path, an append-only audit log, share links, cron, and optional billing (Stripe) and
notifications (SMS). Its safety rules are executable: `tests/invariants/` holds INV-01 to INV-28, and CI fails if one breaks.

Design and decisions: `FOUNDATION_SPEC.md`. Milestones and the sync model: `IMPLEMENTATION_PLAN.md`. Releases: `CHANGELOG.md`. Clones: `CLONES.md`.

## Quickstart (about 10 minutes)

Needs Node 22 and a local Postgres 17 you can create databases in (Homebrew `postgresql@17` works with no password).

```bash
git clone git@github.com:shanelabountyai/saas-foundation.git my-app
cd my-app
git remote rename origin template
git checkout -B main v1.0.0   # -B: a fresh clone already has a main
npm ci
npm run new-project -- my-app 4200   # name and port; rewrites package.json, CI, Playwright, README
npm run db:setup                     # creates my_app and my_app_test, writes .env.local and .env.test, migrates both
npm run seed:demo                    # two orgs, owner/admin/member each; owners and admins have TOTP
npm run dev                          # http://localhost:4200/demo
```

**Do not use GitHub's "Use this template" button.** It drops the shared history, so later fixes can't be merged.
Working on the template itself: `npm run dev:template` serves on :4100.

`db:setup` never overwrites an existing `.env.*` and never prints a value. It uses your OS user against `localhost:5432`;
set `PGUSER`/`PGPASSWORD` or `LOCAL_PG_URL_BASE` for a different Postgres. Real keys (Resend, Stripe, Twilio) are optional
and go in `.env.local`; without them email is captured in the database, billing uses a mock, and SMS is off.

### Row-level security on Neon (optional, `RLS_MODE=enforce`)

`db:setup` gives you two roles locally: the owner (`DATABASE_URL` while RLS is off, `DATABASE_URL_SYSTEM`, `DIRECT_URL`) and
`<name>_app_rw` with `NOBYPASSRLS` (`DATABASE_URL_APP_RW`). To enforce locally, set `DATABASE_URL` to the app_rw URL and
`RLS_MODE=enforce` together: app_rw with RLS off sees no org rows, because off mode sets no org. On Neon, the role the console creates is a `neon_superuser` with `BYPASSRLS`, so the app role is made
in SQL, as the owner, on the branch:

```sql
CREATE ROLE app_rw LOGIN PASSWORD '<generate one>' NOBYPASSRLS NOSUPERUSER;
GRANT USAGE ON SCHEMA public TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
```

Then in Vercel: `DATABASE_URL` = app_rw through the pooler (`-pooler` host), `DATABASE_URL_SYSTEM` = the owner through the pooler,
`DIRECT_URL` = the owner without the pooler, `RLS_MODE=enforce`. Run `npm run rls:policies` once for your own org-owned models and
commit the migration; INV-30 fails until you do. The pooler accepts an SQL-created role (spike S4a ran through it).

## Commands

| Command | What it does |
|---|---|
| `npm test` | vitest against the local test database: unit, integration and all invariants |
| `npm run test:e2e` | Playwright against a production build (`E2E_DEV=1` runs the dev server for debugging one spec) |
| `npm run lint` / `typecheck` | ESLint (including the core-boundary rule) and `tsc` |
| `npm run db:migrate` | create a migration in dev; `db:migrate:test` applies to the test database |
| `npm run seed:demo` | idempotent demo accounts; refuses a cloud database |
| `npm run foundation:drift` | in a clone: fails if a template-owned file was edited |
| `npm run foundation:status` | in a clone: current vs latest release, and any `security:` changelog entries between |
| `npm run foundation:check-modules` | builds a scratch copy with both modules deleted (CI runs it) |

## Layout

- `src/core/`: env, db, auth, tenancy, authz, audit, tokens, email, share links, cron. Never imports from `src/modules` or `src/app` (lint-enforced).
- `src/modules/{billing,notifications}/`: optional, deletable.
- `src/app/`: routes. `src/app/cron-jobs.ts` is where a clone adds its own cron work. `src/app/org-hooks.ts` holds the
  clone's org hooks: `beforeOrgDelete` (runs before an org is deleted; throwing stops it) and `filterListedOrgs` (which of a
  user's orgs `/onboarding` and `/demo` list; default all, and it can only hide, never add — D-22).
- `prisma/schema/`: `core.prisma` plus one file per module. A clone's tables get their own file and migrations.
- `tests/invariants/`: the security rules as tests. `tests/fixtures/app.ts` holds a clone's harness rows.

## Removing a module

Delete the paths listed for it in `scripts/foundation-modules.ts`, and the lines marked `// billing` or `// notifications`
(`{/* billing */}` in `layout.tsx`) in `prisma/schema/core.prisma`, `src/app/cron-jobs.ts` and `src/app/o/[org]/layout.tsx` —
that includes the module's nav link, so it goes with the rest.
`foundation:check-modules` does exactly this in a scratch copy (`removeModule()` in `scripts/foundation-modules.ts`) and
requires validate, typecheck, the module-tooling unit tests, build and drift to pass.
The module's tables stay in the migration history; drop them with a clone migration if you want them gone. Date that
migration after the template's newest migration: the RLS policy migrations up to `20261108000002` `ALTER` module tables
unguarded. Policy migrations from 1.6.2 on skip a module table that no longer exists.

If your own code imports a module outside the marked lines (a clone's own routes or lib files, not just
`cron-jobs.ts`/`org-hooks.ts`), list it in `src/app/required-modules.ts`. `check-modules` leaves a required module in
place and still removes the rest.

## Staying current

Template-owned paths (core, modules, invariants, security routes) are never edited in a clone, so `git merge vX.Y.Z` is clean.
An urgent local patch goes in `FOUNDATION_PATCHES.md` as `` `path` `hash` — reason `` (drift prints the hash to paste in) and moves upstream at the next release. The excuse stops matching, and drift fails again, once that path changes further.
Upgrade steps and versioning rules: `IMPLEMENTATION_PLAN.md` §3.3.

## Not included

Legal pages are stubs (`/legal/privacy`, `/legal/terms`) and are not legal advice. There is no audit-log viewer and no
`/o/[org]/settings/security` page yet.

No cookie banner: the foundation sets only strictly necessary cookies (`session`, `totp_pending`), and those need no consent.
If you add analytics, ads or any other non-essential tracker, you need consent first (spec D-20).
