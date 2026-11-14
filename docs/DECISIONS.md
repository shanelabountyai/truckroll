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
