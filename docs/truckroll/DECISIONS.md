# Truckroll — decisions

Made by Claude on 2026-11-13 while Shane was away (he asked for progress over waiting). Each one is a default
he can change; the "Change it" column says what moves if he does.

| ID | Problem | Options | Decision | Change it |
|---|---|---|---|---|
| D-01 | Distances without paying for a maps API | (a) haversine × road factor, (b) self-hosted OSRM with Oklahoma extract, (c) Google/Mapbox matrix API | **(a)** factor 1.35, 45 mph | (b) is a Phase 5 swap behind `distance.ts`; (c) adds a key and cost |
| D-02 | Where the solver runs | (a) Python OR-Tools service, (b) OR-Tools in Node via WASM/bindings, (c) hand-rolled TS heuristic | **(a)** — OR-Tools' routing library is best supported in Python | (c) would drop the "real solver" portfolio point |
| D-03 | Trusting solver output | (a) TS checker validates every plan, (b) trust solver | **(a)** — mirrors housefile/gavel oracle pattern | none recommended |
| D-04 | Objective order | (a) emergencies → lateness → drive minutes, (b) single weighted sum | **(a)** lexicographic via penalties | tune in `solver/objective.py` |
| D-05 | Real SMS for ETA texts | (a) captured messages only, (b) foundation `notifications` module (Twilio) | **(a)** in v1 — no real customers | flip to (b) for a live pilot |
| D-06 | LLM for ETA text | (a) Claude via `withBudget`, template fallback, (b) template only | **(a)** | (b) if you want zero AI spend |
| D-07 | Port | 7800 | **7800** (7700 is Turnstile) | `new-project` rewrite |
| D-08 | Billing module | (a) keep, (b) remove via `check-modules` | **(b) remove** — not a SaaS sold here; notifications kept | re-add by merging the module back |
| D-09 | How far the first unattended run goes | (a) stop after Phase 1 plan, (b) build Phase 1 and stop at the Phase 2 gate | **(b)** — you set "work as far as you can"; Phase 1 has no DB writes, so it is cheap to throw away | tell the next session "redo Phase 1 from plan" |
| D-10 | Synthetic geography | Muskogee-area bounding box, made-up addresses, two shops (Muskogee, Tahlequah) | as stated | edit `fixtures/geo.json` |
| D-11 | Phase 0 sandbox has no Postgres 17 (apt.postgresql.org is blocked by the egress proxy) | (a) Postgres 16 from Ubuntu, (b) PG 17.11 binaries from the npm package `@embedded-postgres/linux-x64`, (c) stop | **(b)** — matches CI's `postgres:17`; sandbox-only, nothing committed | none needed on a laptop (Homebrew `postgresql@17`) |
| D-12 | Prisma engine download (binaries.prisma.sh) is blocked in the sandbox, so `prisma migrate deploy` can't run there | (a) local stand-in that applies `prisma/migrations/*/migration.sql` in order and records `_prisma_migrations`, (b) build schema-engine from source, (c) stop | **(a)** for the local gate only; `prisma generate` runs with `PRISMA_SCHEMA_ENGINE_BINARY` pointed at a stub. CI uses the real Prisma CLI, so CI is the source of truth | nothing to change; on a normal network the stand-in is unused |
| D-13 | Template test `rls:policies module guard (F-09)` in `tests/unit/foundation-tools.test.ts` expects every module installed, so it fails after the documented billing removal | (a) compare against installed modules only, (b) keep billing, (c) leave red | **(a)** one-line change; `foundation:drift` does not flag it (tests/unit isn't template-owned). Should move upstream in the next foundation release | upstream the fix, then take the template's version on the next `git merge` |
| D-14 | `BillingAccount` table stays in the migration history after removing billing | (a) leave it (no rows, no model), (b) add a clone drop migration now | **(a)** — Phase 0 changes nothing in the schema; a drop migration can come with Phase 2's `truckroll.prisma` | add the drop migration dated after `20261108000002` |
