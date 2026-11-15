import { beforeEach, describe, expect, it } from 'vitest';
import { dbSystem as db } from '@/core/db/system';
import { checkPlan } from '@/lib/dispatch/check';
import { Problem } from '@/lib/dispatch/contract';
import { dayOf, localMinuteOn } from '@/lib/dispatch/time';
import { seedDispatch } from '../../scripts/truckroll/seed-dispatch';
import { resetAuthTables } from '../helpers/auth';
import { addMember, makeOrg } from '../helpers/org';

// Phase 4 demo seed (PRD §7, D-58): the fixed e2e day plus rolling days around "today" in America/Chicago, synthetic
// Muskogee-area data with fictional phones. The finished day's plan went through the checker (TR-02).

const FIXED = '2026-11-16';
let acme: string;

beforeEach(async () => {
  await resetAuthTables();
  const a = await makeOrg('acme');
  const g = await makeOrg('globex');
  acme = a.id;
  await addMember(a.id, 'member', 'member@acme.demo.test');
  await addMember(g.id, 'member', 'member@globex.demo.test');
});

const jobsOn = (orgId: string, day: string) => db.job.findMany({ where: { orgId, date: dayOf(day) }, orderBy: { ref: 'asc' } });
const plansOn = (orgId: string, day: string) => db.dispatchPlan.findMany({ where: { orgId, date: dayOf(day) } });

describe('seed:dispatch (the demo seed)', () => {
  it('seeds the fixed day and three rolling days; yesterday is finished with a checked plan and recorded times', async () => {
    const lines = await seedDispatch({ today: '2026-11-20' });
    expect(lines).toHaveLength(2);
    for (const day of [FIXED, '2026-11-19', '2026-11-20', '2026-11-21']) expect(await jobsOn(acme, day)).toHaveLength(24);
    for (const day of [FIXED, '2026-11-20', '2026-11-21']) expect(await plansOn(acme, day)).toHaveLength(0);

    const [plan] = await plansOn(acme, '2026-11-19');
    expect(plan).toBeDefined();
    expect(checkPlan(Problem.parse(plan!.problem), plan!.plan).ok).toBe(true);
    const done = await jobsOn(acme, '2026-11-19');
    expect(done.filter((j) => j.status === 'done')).toHaveLength(23);
    expect(done.filter((j) => j.status === 'cant_complete')).toHaveLength(1);
    for (const j of done) {
      const on = localMinuteOn(j.onSiteAt, '2026-11-19');
      const off = localMinuteOn(j.doneAt, '2026-11-19');
      expect(on).not.toBeNull();
      expect(off!).toBeGreaterThan(on!);
    }
    expect((await db.technician.findFirst({ where: { orgId: acme, name: 'Muskogee One' }, include: { user: true } }))?.user?.email).toBe('member@acme.demo.test');
  });

  it('synthetic only: fictional 555-01xx phones, "Synthetic OK" addresses; the fixed day keeps the fixture names', async () => {
    await seedDispatch({ today: '2026-11-20' });
    for (const j of await db.job.findMany()) {
      expect(j.customerPhone).toMatch(/^918-555-01\d\d$/);
      expect(j.address).toMatch(/Synthetic OK$/);
    }
    expect((await jobsOn(acme, FIXED)).every((j) => j.customer.startsWith('Customer '))).toBe(true);
    expect((await jobsOn(acme, '2026-11-20')).some((j) => j.customer.startsWith('Customer '))).toBe(false);
  });

  it('idempotent: a second run replaces the days instead of adding to them', async () => {
    await seedDispatch({ today: '2026-11-20' });
    await seedDispatch({ today: '2026-11-20' });
    expect(await db.job.count({ where: { orgId: acme } })).toBe(4 * 24);
    expect(await db.dispatchPlan.count({ where: { orgId: acme } })).toBe(1);
    expect(await db.technician.count({ where: { orgId: acme } })).toBe(6);
  });

  it('the fixed e2e day wins when a rolling day falls on it', async () => {
    await seedDispatch({ today: '2026-11-17' }); // yesterday would be the fixed day
    expect(await plansOn(acme, FIXED)).toHaveLength(0);
    expect((await jobsOn(acme, FIXED)).every((j) => j.status === 'unscheduled' && j.customer.startsWith('Customer '))).toBe(true);
  });
});
