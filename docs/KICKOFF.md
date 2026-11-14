# Truckroll — Claude Code kickoff

One session per phase; each stops at its gate. Branch flow as in Commons/Turnstile: Phase 0 lands on `main`,
Phase 1 on `kickoff` (PR #1, never merged by Claude), later phases on `phase-N` branches.

## Session prompt — Phase 0 + Phase 1

```text
You are building Truckroll (build-log #24), an HVAC dispatch app on saas-foundation. The repo
shanelabountyai/truckroll currently holds only this kit on branch `kit` (docs/PRD.md, docs/DECISIONS.md,
docs/KICKOFF.md). Read all three first. Decisions in DECISIONS.md are in force; when you hit a new one, pick the
option you'd recommend, append a row (problem, options, decision, how to change it) and keep going. Never stop to ask.

PHASE 0 — foundation clone (goes on `main`):
  1. git clone https://github.com/shanelabountyai/saas-foundation truckroll-app && cd truckroll-app
     git remote rename origin template; git remote add origin https://github.com/shanelabountyai/truckroll
     git checkout -B main v1.6.2
     (Never GitHub's "Use this template": shared history is what lets later foundation releases merge.)
  2. Needs Node 22 and Postgres 17. Install them if missing. npm ci; npm run new-project -- truckroll 7800;
     npm run db:setup; npm run seed:demo.
  3. Remove the billing module per README "Removing a module" (D-08); run foundation:check-modules.
  4. Copy docs/PRD.md, docs/DECISIONS.md, docs/KICKOFF.md from origin/kit into docs/truckroll/.
  5. Gate: npm run lint, typecheck, test green. Push main (-c push.negotiate=true). Set the default branch:
     gh repo edit shanelabountyai/truckroll --default-branch main. Do not delete `kit`.
  6. You cannot push to saas-foundation. Put the CLONES.md row you'd add in the PR body under "For Shane".

PHASE 1 — pure engines, no database writes (branch `kickoff` off main):
  1. Write docs/truckroll/PHASE1_PLAN.md first (files, tests, fixture list, risks), commit it, open PR #1
     "Truckroll Phase 1: pure engines" against main. Keep it unmerged.
  2. Build per PRD §5: contract.ts + contract.py; distance.ts + distance.py; check.ts (checker/oracle);
     metrics.ts; solver/ (FastAPI + ortools, pinned in pyproject.toml, `POST /solve`, time limit as an input,
     deterministic search params); fixtures/problems/ with at least 12 problems including infeasible ones
     (missing skill, impossible window, over-capacity) and a pinned-job case.
  3. Tests: vitest for TS, pytest for Python; a cross-language test that runs every fixture through the solver and
     the checker; TR-01 and TR-04 in tests/truckroll/. CI: add a Python job to the existing workflow.
  4. Gate (all must hold): lint, typecheck, test, pytest green; every feasible fixture's plan passes the checker;
     every infeasible fixture returns the right reason codes; solver p95 under 2 s per fixture on CI (report the
     numbers as integers in the PR body).
  5. PR body: what was built, gate results, new DECISIONS rows, anything you could not verify. Then stop. Do not
     start Phase 2.

Rules: synthetic data only; never print a secret or a connection string; commit trailers per session settings;
if a gate fails, stop and report rather than loosen the gate.
```

## Later phases

| Session | Scope | Stop condition |
|---|---|---|
| Phase 2 | schema, dispatcher board, pins, save plan | PRD §7 Phase 2 gate; PR #2 on `phase-2` |
| Phase 3 | tech day view, statuses, re-plan | Phase 3 gate |
| Phase 4 | ETA texts, approvals, metrics, demo seed, README demo script | Phase 4 gate |
