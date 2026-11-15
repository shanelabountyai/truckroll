// Shared by the Phase 4 ETA tests: an org with a dispatcher, a technician and a saved demo-day plan whose jobs all
// have (fictional) customer phones.
import { expect } from 'vitest';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system';
import { buildProblem, savePlanIfValid } from '@/lib/dispatch/plan-store';
import { actAs, addMember, makeOrg } from '../helpers/org';
import { seedFixtureDay, translatedGolden, type Seeded } from './dispatch-db';

export const FIX = '03-demo-day';

export type EtaWorld = { slug: string; orgId: string; seeded: Seeded; admin: string; tech: string; planId: string };

export async function etaWorld(slug = 'shop'): Promise<EtaWorld> {
  const org = await makeOrg(slug);
  await db.org.update({ where: { id: org.id }, data: { name: 'Acme Heating' } });
  const admin = (await addMember(org.id, 'admin', `dispatch@${slug}.test`)).id;
  const tech = (await addMember(org.id, 'member', `one@${slug}.test`)).id;
  const seeded = await seedFixtureDay(org.id, FIX, { 'Muskogee One': tech });
  let n = 0;
  for (const id of seeded.job.values()) await db.job.update({ where: { id }, data: { customerPhone: `918-555-01${String(n++ % 100).padStart(2, '0')}` } });
  const planId = await savePlan(org.slug, org.id, admin, seeded);
  return { slug: org.slug, orgId: org.id, seeded, admin, tech, planId };
}

/** Saves the fixture's golden plan as a new current plan (a new plan id each call). */
export async function savePlan(slug: string, orgId: string, admin: string, seeded: Seeded): Promise<string> {
  const ctx = await actAs(admin, slug);
  const res = await withOrg(ctx, async (tx) => savePlanIfValid(tx, ctx, await buildProblem(tx, orgId, seeded.date), translatedGolden(FIX, seeded)));
  expect(res.ok).toBe(true);
  return (res as { planId: string }).planId;
}
