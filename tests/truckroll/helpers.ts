// Shared by the Truckroll Phase 1 tests: fixtures, golden plans, the solver's Python, and fixture expectations.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plan, ProblemInput, Reason } from '@/lib/dispatch/contract';
import type { Expect, Fixture } from '../../scripts/truckroll/gen-fixtures';

export const ROOT = resolve(__dirname, '../..');
export const SOLVER_DIR = join(ROOT, 'solver');
const PROBLEMS = join(ROOT, 'fixtures/problems');
const PLANS = join(ROOT, 'fixtures/plans');

export const fixtures: Fixture[] = readdirSync(PROBLEMS)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(PROBLEMS, f), 'utf8')) as Fixture);

/** Golden plans: the solver's output at the time the fixture was written, committed so the checker tests run without Python. */
export function goldenPlan(name: string): Plan {
  return JSON.parse(readFileSync(join(PLANS, `${name}.json`), 'utf8')) as Plan;
}

// The solver's Python: TRUCKROLL_SOLVER_PYTHON, else solver/.venv. CI's solver job sets TRUCKROLL_REQUIRE_SOLVER=1 so
// these tests fail there instead of skipping.
const python = process.env.TRUCKROLL_SOLVER_PYTHON ?? join(SOLVER_DIR, '.venv/bin/python');
export const requireSolver = process.env.TRUCKROLL_REQUIRE_SOLVER === '1';
export const hasSolver = existsSync(python) && spawnSync(python, ['-c', 'import ortools, fastapi'], { cwd: SOLVER_DIR }).status === 0;
if (requireSolver && !hasSolver) throw new Error(`TRUCKROLL_REQUIRE_SOLVER=1 but no solver Python with ortools at ${python}`);
export const skipWithoutSolver = !hasSolver;

function runPython(args: string[], input: string): string {
  const r = spawnSync(python, args, { cwd: SOLVER_DIR, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`solver exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

/** Raw bytes of the solver's plan (canonical JSON) for a problem, through solver/cli.py — the POST /solve code path. */
export function solveRaw(problem: ProblemInput, timeLimitMs = 10_000): string {
  return runPython(['cli.py'], JSON.stringify({ problem, timeLimitMs }));
}

export function pythonDriveMatrix(points: { lat: number; lng: number }[]): number[][] {
  const code = 'import json,sys\nfrom contract import Point\nfrom distance import drive_matrix\nprint(json.dumps(drive_matrix([Point(**p) for p in json.load(sys.stdin)])))';
  return JSON.parse(runPython(['-c', code], JSON.stringify(points))) as number[][];
}

/** Every point a fixture's plan can drive between: techs' starts and homes, then jobs. */
export function fixturePoints(p: ProblemInput) {
  return [...p.techs.flatMap((t) => [t.start?.point ?? t.home, t.home]), ...p.jobs.map((j) => j.location)];
}

/** Human-readable failures of a plan against a fixture's `expect` (empty = all good). */
export function expectationFailures(expect: Expect, plan: Plan): string[] {
  const out: string[] = [];
  const routedBy = new Map<string, string>();
  for (const r of plan.routes) for (const s of r.stops) routedBy.set(s.jobId, r.techId);
  for (const j of expect.assigned ?? []) if (!routedBy.has(j)) out.push(`${j} should be assigned`);
  if (expect.unassigned) {
    const got = Object.fromEntries(plan.unassigned.map((u) => [u.jobId, u.reasons]));
    const want = expect.unassigned;
    if (expect.unassignedCounts === undefined) {
      if (JSON.stringify(Object.keys(got).sort()) !== JSON.stringify(Object.keys(want).sort())) out.push(`unassigned ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
    }
    for (const [j, reasons] of Object.entries(want)) if (JSON.stringify(got[j]) !== JSON.stringify(reasons)) out.push(`${j}: reasons ${JSON.stringify(got[j])} ≠ ${JSON.stringify(reasons)}`);
  }
  if (expect.unassignedCounts) {
    const counts: Partial<Record<Reason, number>> = {};
    for (const u of plan.unassigned) counts[u.reasons[0]!] = (counts[u.reasons[0]!] ?? 0) + 1;
    if (JSON.stringify(Object.entries(counts).sort()) !== JSON.stringify(Object.entries(expect.unassignedCounts).sort())) out.push(`unassigned counts ${JSON.stringify(counts)} ≠ ${JSON.stringify(expect.unassignedCounts)}`);
  }
  for (const [techId, seq] of Object.entries(expect.sequence ?? {})) {
    const got = plan.routes.find((r) => r.techId === techId)?.stops.map((s) => s.jobId) ?? [];
    if (JSON.stringify(got) !== JSON.stringify(seq)) out.push(`${techId} sequence ${JSON.stringify(got)} ≠ ${JSON.stringify(seq)}`);
  }
  const late = plan.objective.lateMin;
  if (expect.lateMin?.min !== undefined && late < expect.lateMin.min) out.push(`lateMin ${late} < ${expect.lateMin.min}`);
  if (expect.lateMin?.max !== undefined && late > expect.lateMin.max) out.push(`lateMin ${late} > ${expect.lateMin.max}`);
  for (const techId of expect.noLunch ?? []) if (plan.routes.find((r) => r.techId === techId)?.lunch !== null) out.push(`${techId} should have no lunch`);
  return out;
}
