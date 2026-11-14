import { dbSystem as db } from '@/core/db/system';

// CLONE-OWNED. The INV-01..04 harness seeds these rows in both fixture orgs, so it can drive
// actions whose inputs use ref('<model>') for the clone's own tables. Return { model: id } for
// one row of each model, owned by `org.orgId`. INV-29 (RLS enforce) calls it too, so every org-owned clone table has rows to scope.
// Truckroll: a technician, a job on the harness day, and a saved plan with one stop. Fixed ids: the harness re-seeds
// before every call, and a ref minted once must still resolve.
const id = (key: 'a' | 'b', n: number) => `00000000-0000-4000-8000-${String((key === 'a' ? 9000 : 9500) + n).padStart(12, '0')}`;

export async function seedApp(org: { orgId: string; userId: string }, key: 'a' | 'b'): Promise<Record<string, string>> {
  const date = new Date('2031-01-06T00:00:00Z');
  const technician = await db.technician.create({
    data: { id: id(key, 1), orgId: org.orgId, name: `harness tech ${key}`, skills: ['repair'], shiftStart: 480, shiftEnd: 1020, homeLat: 35.7479, homeLng: -95.3697, lunchEarliest: 690, lunchLatest: 780, maxJobs: 8 },
  });
  const job = await db.job.create({
    data: { id: id(key, 2), orgId: org.orgId, ref: `H-${key}`, customer: `harness customer ${key}`, address: '1 Example Rd', lat: 35.75, lng: -95.37, date, windowStart: 540, windowEnd: 660, durationMin: 60, skill: 'repair', priority: 'standard' },
  });
  const plan = await db.dispatchPlan.create({
    data: { id: id(key, 3), orgId: org.orgId, date, createdById: org.userId, problem: {}, plan: {}, metrics: {}, driveMin: 0, lateMin: 0, unassignedCount: 0, stoppedBy: 'trivial' },
  });
  const stop = await db.planStop.create({
    data: { id: id(key, 4), orgId: org.orgId, planId: plan.id, techId: technician.id, jobId: job.id, seq: 1, arrival: 482, start: 540, end: 600, driveMin: 2, slackMin: 58, lateMin: 0 },
  });
  return { technician: technician.id, job: job.id, dispatchPlan: plan.id, planStop: stop.id };
}
