import { afterEach, describe, expect, it, vi } from 'vitest';
import { solveProblem, SolverUnavailable } from '@/lib/dispatch/solver-client';

// D-37: POST /solve answers 422 with a pin-conflict body when the pins can't all be kept. The client hands that body
// back (untrusted; the checker verifies it) instead of calling the solver unavailable. Any other 422 still is.
const problem = { version: 1 as const, date: '2026-11-16', techs: [], jobs: [] };
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('solver client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a 422 pin-conflict comes back as the body', async () => {
    const body = { error: 'pin-conflict', pins: [{ code: 'no-skill', jobId: 'J1', techId: 'T1' }], detail: 'pins can’t all be honoured' };
    vi.stubGlobal('fetch', reply(422, body));
    await expect(solveProblem(problem)).resolves.toEqual(body);
  });

  it('any other 422 (a refused request) is SolverUnavailable', async () => {
    vi.stubGlobal('fetch', reply(422, { detail: [{ msg: 'Extra inputs are not permitted' }] }));
    await expect(solveProblem(problem)).rejects.toBeInstanceOf(SolverUnavailable);
  });

  it('a 503 time-limit is SolverUnavailable', async () => {
    vi.stubGlobal('fetch', reply(503, { error: 'time-limit' }));
    await expect(solveProblem(problem)).rejects.toBeInstanceOf(SolverUnavailable);
  });
});
