# Release notes

## Not deployed — portfolio pack 2026-11-24

Truckroll has never been deployed: there is no hosting, no production database and no live URL. It runs on a laptop
against synthetic data (two made-up shops around Muskogee and Tahlequah, Oklahoma; fictional 918-555-01xx numbers).
No real SMS is sent; approved ETA texts land in the captured-message store (D-05, D-49).

### What exists, by pull request

Every merge commit below was checked with `git log` on `main` (`aa4897e`) on 2026-11-24. Dates are the merge dates.

| PR | Merge commit | Date | What it added |
|---|---|---|---|
| #1 | `18c4a54` | 2026-11-14 | Phase 1: pure engines. Contract (TS + Python), distance, the TypeScript checker, the OR-Tools solver service, fixtures, metrics; TR-01, TR-04 |
| #2 | `4acc302` | 2026-11-14 | Phase 2: schema, dispatcher board, pins, save plan; TR-02, TR-05 |
| #3 | `d6ad17c` | 2026-11-14 | Phase 3: technician's day at phone width, statuses, mid-day re-plan with emergency insert; TR-03 |
| #4 | `9f0290a` | 2026-11-14 | Phase 4: ETA text drafts (Claude via `withBudget`, template fallback), approve and send, metrics page, demo seed; TR-06 |
| #5 | `bf794ea` | 2026-11-17 | saas-foundation v1.6.4 (`security:` audit fixes) |
| #6 | `4a5cd3d` | 2026-11-17 | saas-foundation v1.6.5 + v1.6.6 (`security:`) |
| #7 | `03e35dd` | 2026-11-18 | saas-foundation v1.7.0 (`security:`) |
| #8 | `9a045bc` | 2026-11-18 | Design pass: look from the Claude Design artboards, axe WCAG 2.1 AA checks, three independent reviews (D-60 to D-73) |
| #9 | `aa4897e` | 2026-11-19 | e2e on one worker so reseeding specs can't race (D-74) |

CI on `main` at `aa4897e`: success ([run 44571003644](https://github.com/shanelabountyai/truckroll/actions/runs/44571003644), 2026-11-19).

### The pack

Branch `portfolio-pack/2026-11-24`, PR #10, merged 2026-11-24 as `e15be14` (CI green on `main`, run 45509963486), docs only (no application code, tests, seeds, schema, config or CI
changed).

| Item | Where | State |
|---|---|---|
| Demo walk-through | `docs/DEMO.md` | 18 stops; 15 verified by a named test, 2 partly, 1 not (D-77). Not yet clicked through by Shane |
| Exec brief "Truckroll in Brief" | [Claude Docs](https://claude.ai/artifact/BQK2vDLSmEgLCGix4d97bo) (private, not shared) | Kept from 2026-11-23, corrected in place on 2026-11-24 (D-80) |
| LinkedIn drafts | `docs/LINKEDIN_DRAFTS.md` | Two drafts, on D-32 and D-36. Drafted, unposted (D-78) |
| Cost note | `docs/truckroll/DECISIONS.md` D-79 | Build and running cost not measured; spending limits listed as limits |
| Release notes | `docs/RELEASE_NOTES.md` | This entry |
| Hand-off | `NEXT.md`, top section | What was verified and how, what wasn't, Shane's steps |

Gate for the pack: see the PR's "Gate results" and `NEXT.md`. Benchmarks quoted anywhere in the pack are on synthetic
fixture problems, not real-world performance.
