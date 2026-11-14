import { beforeEach, describe, expect, it } from 'vitest';
import { setJobStatus } from '@/app/o/[org]/dispatch/actions';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system';
import { buildProblem, savePlanIfValid } from '@/lib/dispatch/plan-store';
import { resetAuthTables, signInAs } from '../helpers/auth';
import { NavSignal } from '../helpers/next';
import { actAs, addMember, makeOrg } from '../helpers/org';
import { seedFixtureDay, translatedGolden, type Seeded } from './dispatch-db';

// Phase 3 statuses (PRD §2, D-44): a technician moves their own stops en route → on site → done (or can't complete);
// another tech's stop is notFound, like a missing one (TR-05); the dispatcher may set any stop; one active job per tech.
const FIX = '03-demo-day';
let slug: string;
let orgId: string;
let seeded: Seeded;
const users: Record<string, string> = {};

beforeEach(async () => {
  await resetAuthTables();
  const org = await makeOrg('shop');
  [slug, orgId] = [org.slug, org.id];
  users.admin = (await addMember(org.id, 'admin', 'dispatch@example.test')).id;
  users.one = (await addMember(org.id, 'member', 'one@example.test')).id;
  users.none = (await addMember(org.id, 'member', 'office@example.test')).id;
  seeded = await seedFixtureDay(org.id, FIX, { 'Muskogee One': users.one! });
  const ctx = await actAs(users.admin!, slug);
  const res = await withOrg(ctx, async (tx) => savePlanIfValid(tx, ctx, await buildProblem(tx, orgId, seeded.date), translatedGolden(FIX, seeded)));
  expect(res.ok).toBe(true);
});

async function as(user: string, input: Record<string, unknown>): Promise<{ error?: string; redirected?: string; notFound?: true }> {
  await signInAs(users[user]!, { mfa: true });
  try {
    return ((await setJobStatus(slug, input)) ?? {}) as { error?: string };
  } catch (e) {
    if (e instanceof NavSignal) return e.kind === 'redirect' ? { redirected: e.to } : { notFound: true };
    throw e;
  }
}

const job = (ref: string) => db.job.findUniqueOrThrow({ where: { id: seeded.job.get(ref)! } });
// Muskogee One's golden route: J11, J05, J15. Muskogee Two's: J07, …
const MINE = 'J11';
const THEIRS = 'J07';

describe('a technician’s statuses', () => {
  it('en route → on site → done on their own stop, with times and an audit row each', async () => {
    expect(await as('one', { id: seeded.job.get(MINE), status: 'en_route' })).toEqual({ redirected: `/o/${slug}/dispatch/my-day?date=${seeded.date}` });
    expect((await job(MINE)).enRouteAt).toBeInstanceOf(Date);
    expect((await as('one', { id: seeded.job.get(MINE), status: 'on_site' })).redirected).toBeDefined();
    expect((await job(MINE)).onSiteAt).toBeInstanceOf(Date);
    expect((await as('one', { id: seeded.job.get(MINE), status: 'done', back: 'stop' })).redirected).toMatch(new RegExp(`^/o/${slug}/dispatch/stops/[0-9a-f-]{36}$`));
    const j = await job(MINE);
    expect([j.status, j.doneAt instanceof Date]).toEqual(['done', true]);
    const audit = await db.auditEvent.findMany({ where: { orgId, action: 'dispatch.job_status' }, orderBy: { id: 'asc' } });
    expect(audit.map((a) => (a.data as { to: string }).to)).toEqual(['en_route', 'on_site', 'done']);
    expect((audit[0]!.data as { by: string }).by).toBe('technician');
  });

  it('another tech’s stop, a job on no plan and a member who is no tech → notFound (TR-05)', async () => {
    expect(await as('one', { id: seeded.job.get(THEIRS), status: 'on_site' })).toEqual({ notFound: true });
    await db.job.update({ where: { id: seeded.job.get(MINE)! }, data: { status: 'scheduled' } });
    expect(await as('none', { id: seeded.job.get(MINE), status: 'on_site' })).toEqual({ notFound: true });
    const extra = await db.job.create({ data: { orgId, ref: 'X1', customer: 'c', address: 'a', lat: 35.7, lng: -95.3, date: new Date(`${seeded.date}T00:00:00Z`), windowStart: 600, windowEnd: 700, durationMin: 30, skill: 'repair', priority: 'standard' } });
    expect(await as('one', { id: extra.id, status: 'on_site' })).toEqual({ notFound: true });
    expect((await job(THEIRS)).status).toBe('scheduled');
  });

  it('only allowed moves; can’t complete needs a note', async () => {
    expect((await as('one', { id: seeded.job.get(MINE), status: 'done' })).error).toMatch(/is scheduled; it can’t go to done/);
    await as('one', { id: seeded.job.get(MINE), status: 'on_site' });
    expect((await as('one', { id: seeded.job.get(MINE), status: 'cant_complete' })).error).toMatch(/Say why/);
    expect((await as('one', { id: seeded.job.get(MINE), status: 'cant_complete', note: 'Needs a part' })).redirected).toBeDefined();
    const j = await job(MINE);
    expect([j.status, j.statusNote]).toEqual(['cant_complete', 'Needs a part']);
    expect((await as('one', { id: seeded.job.get(MINE), status: 'on_site' })).error).toMatch(/can’t go to on site/);
  });

  it('one active job per technician', async () => {
    await as('one', { id: seeded.job.get(MINE), status: 'on_site' });
    expect((await as('one', { id: seeded.job.get('J05'), status: 'en_route' })).error).toMatch(/Muskogee One is already on site for job J11/);
    await as('one', { id: seeded.job.get(MINE), status: 'done' });
    expect((await as('one', { id: seeded.job.get('J05'), status: 'en_route' })).redirected).toBeDefined();
  });

  it('the dispatcher can set any stop’s status', async () => {
    const r = await as('admin', { id: seeded.job.get(THEIRS), status: 'on_site', back: 'board' });
    expect(r.redirected).toBe(`/o/${slug}/dispatch?date=${seeded.date}`);
    expect((await job(THEIRS)).status).toBe('on_site');
    const audit = await db.auditEvent.findFirstOrThrow({ where: { orgId, action: 'dispatch.job_status' } });
    expect((audit.data as { by: string }).by).toBe('dispatcher');
  });
});
