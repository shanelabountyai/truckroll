import { PinConflictError, type ProblemInput } from './contract';

// The app's only way to the Python solver (PRD §5): POST $SOLVER_URL/solve. The response is untrusted JSON; the caller
// runs it through checkPlan before anything is saved (D-03, TR-02). SOLVER_URL is read here rather than in core env.ts,
// which is template-owned (D-26). It names an internal service and carries no secret.
export const DEFAULT_SOLVER_URL = 'http://127.0.0.1:7801';
export const SOLVE_TIME_LIMIT_MS = 5000;

export class SolverUnavailable extends Error {
  constructor(reason: string) {
    super(`Solver unavailable: ${reason}`);
  }
}

export async function solveProblem(problem: ProblemInput, timeLimitMs = SOLVE_TIME_LIMIT_MS): Promise<unknown> {
  const base = (process.env.SOLVER_URL || DEFAULT_SOLVER_URL).replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/solve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ problem, timeLimitMs }),
      signal: AbortSignal.timeout(timeLimitMs + 10_000),
      cache: 'no-store',
    });
  } catch (e) {
    throw new SolverUnavailable((e as Error).name === 'TimeoutError' ? 'timed out' : 'not reachable');
  }
  if (res.status === 422) {
    // D-37: the pins can't all be kept, so there is no plan. Hand the (untrusted) pin-conflict body back for the checker
    // to verify (checkPinConflict); any other 422 is a request the solver refused.
    const body: unknown = await res.json().catch(() => null);
    if (PinConflictError.safeParse(body).success) return body;
    throw new SolverUnavailable('HTTP 422');
  }
  if (!res.ok) throw new SolverUnavailable(`HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new SolverUnavailable('response was not JSON');
  }
}
