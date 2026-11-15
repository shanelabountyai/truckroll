import { describe, expect, it } from 'vitest';
import { Problem } from '@/lib/dispatch/contract';
import { computeMetrics, planVsActual } from '@/lib/dispatch/metrics';
import { fixtures, goldenPlan } from './helpers';

const m = (name: string) => computeMetrics(Problem.parse(fixtures.find((f) => f.name === name)!.problem), goldenPlan(name));

describe('metrics', () => {
  it('on-time %: no lateness since D-36, so every routed stop is on time', () => {
    const x = m('13-would-be-late');
    expect(x.assigned).toBe(1);
    expect(x.onTimePct).toBe(100);
    expect(x.lateMin).toBe(0);
    for (const f of fixtures) expect(m(f.name).lateMin).toBe(0);
  });
  it('unassigned by reason', () => {
    expect(m('14-all-reasons').unassignedByReason).toEqual({ 'no-skill': 1, 'no-window-fit': 1, 'over-capacity': 1 });
    expect(m('05-emergency-first').unassignedByReason['over-capacity']).toBe(2);
  });
  it('drive minutes equal the plan objective; utilization is a whole percent in 0..100', () => {
    for (const f of fixtures) {
      const x = m(f.name);
      expect(x.driveMin).toBe(goldenPlan(f.name).objective.driveMin);
      expect(Number.isInteger(x.utilizationPct)).toBe(true);
      expect(x.utilizationPct).toBeGreaterThanOrEqual(0);
      expect(x.utilizationPct).toBeLessThanOrEqual(100);
    }
  });
  it('utilization by hand for the single-job fixture', () => {
    const plan = goldenPlan('01-single-job');
    const r = plan.routes[0]!;
    const busy = 60 + r.stops[0]!.driveMin + r.returnDriveMin;
    expect(m('01-single-job').utilizationPct).toBe(Math.round((100 * busy) / 540));
  });
});

describe('planVsActual (Phase 4, D-57)', () => {
  const name = '03-demo-day';
  const problem = Problem.parse(fixtures.find((f) => f.name === name)!.problem);
  const plan = goldenPlan(name);
  const stops = plan.routes.flatMap((r) => r.stops);
  const base = () => new Map(problem.jobs.map((j) => [j.id, { status: 'scheduled', windowStart: j.windowStart, windowEnd: j.windowEnd, durationMin: j.durationMin, onSiteMin: null as number | null, doneMin: null as number | null }]));

  it('before any status: every stop listed, nothing measured yet', () => {
    const x = planVsActual(plan, base());
    expect([x.stops, x.started, x.done, x.arrived, x.actualOnTimePct, x.avgStartDeltaMin, x.avgDurationDeltaMin]).toEqual([stops.length, 0, 0, 0, null, null, null]);
  });

  it('measures start and duration deltas and on-time arrivals by hand', () => {
    const jobs = base();
    const [a, b, c] = stops;
    const ja = jobs.get(a!.jobId)!;
    Object.assign(ja, { status: 'done', onSiteMin: a!.start + 10, doneMin: a!.start + 10 + ja.durationMin + 5 }); // 10 late, 5 long
    const jb = jobs.get(b!.jobId)!;
    Object.assign(jb, { status: 'on_site', onSiteMin: b!.start - 4 }); // 4 early
    const jc = jobs.get(c!.jobId)!;
    Object.assign(jc, { status: 'cant_complete', onSiteMin: jc.windowEnd + 1, doneMin: jc.windowEnd + 20 }); // arrived after the window
    const x = planVsActual(plan, jobs);
    expect([x.started, x.done, x.cantComplete, x.arrived]).toEqual([3, 1, 1, 3]);
    expect(x.actualOnTimePct).toBe(67);
    expect(x.avgDurationDeltaMin).toBe(5); // only the done stop counts
    expect(x.avgStartDeltaMin).toBe(Math.round((10 - 4 + (jc.windowEnd + 1 - c!.start)) / 3));
    const row = x.rows.find((r) => r.jobId === a!.jobId)!;
    expect(row).toMatchObject({ startDeltaMin: 10, durationDeltaMin: 5, inWindow: true, actualEnd: a!.start + 15 + ja.durationMin });
    expect(x.rows.find((r) => r.jobId === c!.jobId)!.inWindow).toBe(false);
  });

  it('a done time without done/can’t-complete status is not an end', () => {
    const jobs = base();
    Object.assign(jobs.get(stops[0]!.jobId)!, { status: 'on_site', onSiteMin: 500, doneMin: 600 });
    expect(planVsActual(plan, jobs).rows.find((r) => r.jobId === stops[0]!.jobId)!.actualEnd).toBeNull();
  });
});
