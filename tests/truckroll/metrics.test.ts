import { describe, expect, it } from 'vitest';
import { Problem } from '@/lib/dispatch/contract';
import { computeMetrics } from '@/lib/dispatch/metrics';
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
