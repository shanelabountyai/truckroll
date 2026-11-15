# Truckroll Phase 4 plan — ETA texts, approval, metrics page, demo seed

Branch `phase-4` off `main` (Phases 1–3 merged; PR #3 merged on Shane's "Merge and go", 2026-11-15, D-48). One PR,
"Truckroll Phase 4: ETA texts, approval, metrics, demo seed", never merged by Claude. Phase 4 is the last phase in the
PRD; nothing beyond PRD §3 v1 scope is built (no real SMS, no maps APIs, no multi-day plans).

## Scope (PRD §7, Phase 4)

| PRD item | What it means here |
|---|---|
| ETA text drafts (LLM via `withBudget`, template fallback) | **Draft ETA texts** on the board drafts one short message per routed job of the day's current plan. With `ANTHROPIC_API_KEY` set (and AI on, budget left), each draft is written by Claude through the foundation's `withBudget` (feature `truckroll.eta`); the model's text is accepted only if it passes a validator, else the fixed template is used. Without a key, the template is used and no model call is made (D-06, D-50, D-51). |
| Approval | A dispatcher reviews the drafts, can edit one, and **Approve and send** writes a `dispatch.eta_approved` audit event (with the body's SHA-256) and only then "sends" it: a `CapturedMessage` row (no real SMS in v1, D-05, D-49). |
| Metrics page | `/o/[org]/dispatch/metrics?date=`: the day's current plan metrics (on-time %, drive minutes, utilization %, unassigned by reason), every saved plan and re-plan of the day, and **plan vs actual** once statuses come in (D-57). |
| Demo seed (Muskogee-area synthetic) | `npm run seed:dispatch` becomes the demo seed: the fixed e2e day plus rolling days around today in America/Chicago (a finished day with a checked plan and synthetic actuals, today and tomorrow to plan), fictional 918-555-01xx phone numbers (D-55, D-58). |
| Gate: TR-06 green; demo script in README | TR-06 below; README gets a Truckroll section with a step-by-step demo script. |

Owner decisions still binding: D-36 (no lateness) and D-37 (pins never dropped or moved). Phase 4 does not change the
planner; ETA texts read the plan as saved.

## TR-06 — "ETA text drafts are never sent without a dispatcher approval event in the audit log"

Defence in depth (never trust one layer):

1. **App path.** `sendApprovedEta(tx, ctx, id)` is the only code that writes a captured ETA message. It re-reads the
   draft and refuses unless an audit event `dispatch.eta_approved` exists for that draft, in that org, whose
   `bodySha256` matches the body being sent and whose plan is the day's current plan. The approve action writes that
   event first, in the same transaction, then calls it.
2. **Database.** A trigger on `EtaText` refuses any row that becomes `sent` unless it has `approvedById`, `approvedAt`,
   `sentAt`, `capturedMessageId` **and** a matching `dispatch.eta_approved` audit row (same org, target id, body SHA-256
   computed in SQL). A sent row's body, phone and plan can never change, and a sent row can't go back to draft.
3. **Roles.** Only a dispatcher (owner/admin, D-25) can draft, edit or approve; a technician gets notFound/forbidden.
4. **Staleness.** A draft belongs to one plan. After a re-plan, older unsent drafts can't be sent (D-53).

## Tasks

1. This plan + D-48 (first commit).
2. Schema: `Job.customerPhone`, `EtaText` (+ enum `EtaStatus`), hand-written migration in Prisma's shape plus the TR-06
   trigger; `npm run rls:policies` migration for the new table; `EtaText` in the export; harness fixture row.
3. Pure modules: `src/lib/dispatch/eta.ts` (facts from a plan, the ETA range, the template, the LLM output validator,
   the prompt), `src/lib/dispatch/eta-llm.ts` (Anthropic Messages API over fetch, worst-case cost for `withBudget`,
   injectable for tests), `planVsActual` in `metrics.ts`.
4. `src/lib/dispatch/eta-store.ts`: draft (LLM outside any transaction, write under the dispatch lock, refuse if the
   plan changed), edit, approve-and-send, `sendApprovedEta` guard.
5. Actions: `draftEtas`, `editEta`, `approveEtas`, `discardEta`. Board: an ETA section; phone fields on add-job and
   emergency forms.
6. Metrics page + a board link.
7. Demo seed + README demo script.
8. Tests + e2e (below).

## Acceptance → proof

| Acceptance item | Proof |
|---|---|
| **TR-06** | `tests/truckroll/tr-06-eta-approval.test.ts`: drafting sends nothing; approve → one captured message per draft, each with a prior matching approval event; calling the send guard without approval, with an approval for another body (edited after approval), for another org's draft, or for a stale plan → refused, nothing captured; a direct SQL update to `sent` without approval is refused by the trigger; a technician can't approve; a sweep over every sent row and every captured ETA message finds the matching approval event. |
| LLM via `withBudget` | `tests/truckroll/eta-llm.test.ts`: with a stubbed model call, drafts come from the model and an `AiUsage` row with feature `truckroll.eta` is written; budget exceeded / AI off / model error / invalid output → template, no usage row for refused calls; no key → template, `fetch` never called. |
| Template fallback | `tests/truckroll/eta.test.ts`: template text per stop, ETA range inside the job window, validator cases (missing time, wrong time, URL, too long, phone number, empty). |
| Metrics page | `tests/truckroll/metrics.test.ts` (`planVsActual` cases) and e2e: the page shows plan metrics and plan vs actual for the seeded finished day. |
| Demo seed | `tests/truckroll/seed-demo.test.ts`: idempotent, the finished day's plan passes `checkPlan`, phones are fictional, the fixed day is untouched by rolling days. |
| e2e | `e2e/dispatch.spec.ts` (after the Phase 3 tests): dispatcher drafts ETA texts, edits one, approves and sends; captured messages = approved drafts, each with an approval audit row; the metrics page shows the day. |
| No regressions | lint, typecheck, vitest, pytest, solver bench p95 < 2000 ms, Playwright, all green on GitHub CI. |

## Gate

lint · typecheck · vitest · pytest · solver p95 bench (< 2 s per fixture) · Playwright e2e · TR-06 green · demo
script in README · GitHub CI green. Then stop.

## Risks

- Prisma's schema engine can't run in the sandbox (D-12): migration hand-written, CI's `migrate diff` is the gate.
  The trigger is invisible to `migrate diff`, like the audit append-only trigger.
- No live model call is ever made by this run (no key, no network calls to Anthropic); the LLM path is proven with a
  stubbed transport only. Shane's hand step: set `ANTHROPIC_API_KEY` locally and draft once.
