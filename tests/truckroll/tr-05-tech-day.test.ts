import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import StopPage from '@/app/o/[org]/dispatch/stops/[id]/page';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system';
import { savePlanIfValid, buildProblem } from '@/lib/dispatch/plan-store';
import { myDay, readStop } from '@/lib/dispatch/tech-day';
import { resetAuthTables } from '../helpers/auth';
import { NavSignal } from '../helpers/next';
import { actAs, addMember, makeOrg } from '../helpers/org';
import { seedFixtureDay, translatedGolden, type Seeded } from './dispatch-db';

// TR-05: a technician (member) can read only their own day; another tech's stop 404s, exactly like a missing one.
const FIX = '03-demo-day';
let slug: string;
let orgId: string;
let seeded: Seeded;
const users: Record<string, string> = {};

const notFoundOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof NavSignal ? e.kind : `threw ${(e as Error).message}`;
  }
};

beforeEach(async () => {
  await resetAuthTables();
  const org = await makeOrg('shop');
  [slug, orgId] = [org.slug, org.id];
  users.admin = (await addMember(org.id, 'admin', 'dispatch@example.test')).id;
  users.one = (await addMember(org.id, 'member', 'one@example.test')).id;
  users.two = (await addMember(org.id, 'member', 'two@example.test')).id;
  users.none = (await addMember(org.id, 'member', 'office@example.test')).id; // a member who is not a tech
  seeded = await seedFixtureDay(org.id, FIX, { 'Muskogee One': users.one!, 'Tahlequah One': users.two! });
  const ctx = await actAs(users.admin!, slug);
  const res = await withOrg(ctx, async (tx) => savePlanIfValid(tx, ctx, await buildProblem(tx, orgId, seeded.date), translatedGolden(FIX, seeded)));
  expect(res.ok).toBe(true);
});

const stopsOf = (techName: string) => db.planStop.findMany({ where: { orgId, techId: seeded.techByName.get(techName)! }, orderBy: { seq: 'asc' } });

describe('TR-05: a technician reads only their own day', () => {
  it('My day holds exactly the member’s own stops, in order', async () => {
    const own = await stopsOf('Muskogee One');
    expect(own.length).toBeGreaterThan(0);
    const day = await myDay(await actAs(users.one!, slug), seeded.date);
    expect(day.tech?.id).toBe(seeded.techByName.get('Muskogee One'));
    expect(day.stops.map((s) => s.id)).toEqual(own.map((s) => s.id));
    expect(new Set(day.stops.map((s) => s.techId))).toEqual(new Set([seeded.techByName.get('Muskogee One')]));
  });

  it('another tech’s stop is notFound — the same answer as a missing id or a malformed one', async () => {
    const theirs = (await stopsOf('Tahlequah One'))[0]!;
    const ctx = await actAs(users.one!, slug);
    expect(await notFoundOf(readStop(ctx, theirs.id))).toBe('notFound');
    expect(await notFoundOf(readStop(ctx, randomUUID()))).toBe('notFound');
    expect(await notFoundOf(readStop(ctx, 'not-a-uuid'))).toBe('notFound');
    // and through the page itself
    expect(await notFoundOf(StopPage({ params: Promise.resolve({ org: slug, id: theirs.id }) }))).toBe('notFound');
  });

  it('the member’s own stop opens', async () => {
    const mine = (await stopsOf('Muskogee One'))[0]!;
    const s = await readStop(await actAs(users.one!, slug), mine.id);
    expect(s.id).toBe(mine.id);
    expect(await notFoundOf(StopPage({ params: Promise.resolve({ org: slug, id: mine.id }) }))).toBe('resolved');
  });

  it('a member who is not a technician sees no day and no stop', async () => {
    const ctx = await actAs(users.none!, slug);
    expect(await myDay(ctx, seeded.date)).toEqual({ tech: null, stops: [], planId: null });
    expect(await notFoundOf(readStop(ctx, (await stopsOf('Muskogee One'))[0]!.id))).toBe('notFound');
  });

  it('a dispatcher reads any stop in the org; a dispatcher of another org reads none', async () => {
    const theirs = (await stopsOf('Tahlequah One'))[0]!;
    expect((await readStop(await actAs(users.admin!, slug), theirs.id)).id).toBe(theirs.id);
    const other = await makeOrg('rival');
    const rival = await addMember(other.id, 'owner', 'rival@example.test');
    expect(await notFoundOf(readStop(await actAs(rival.id, 'rival'), theirs.id))).toBe('notFound');
  });

  it('negative control: unlinking the member takes their day away on the next request', async () => {
    await db.technician.updateMany({ where: { orgId, userId: users.one! }, data: { userId: null } });
    const ctx = await actAs(users.one!, slug);
    expect((await myDay(ctx, seeded.date)).stops).toEqual([]);
    expect(await notFoundOf(readStop(ctx, (await stopsOf('Muskogee One'))[0]!.id))).toBe('notFound');
  });
});
