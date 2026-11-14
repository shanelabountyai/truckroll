import { beforeEach, describe, expect, it } from 'vitest';
import { addJob, addTech, pinJob, unpinJob } from '@/app/o/[org]/dispatch/actions';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system';
import { Problem } from '@/lib/dispatch/contract';
import { buildProblem } from '@/lib/dispatch/plan-store';
import { resetAuthTables, signInAs } from '../helpers/auth';
import { NavSignal } from '../helpers/next';
import { actAs, addMember, makeOrg } from '../helpers/org';
import { fixtures } from './helpers';
import { seedFixtureDay, type Seeded } from './dispatch-db';

let slug: string;
let orgId: string;
let seeded: Seeded;
let admin: string;

const outcome = async (p: Promise<unknown>) => {
  try {
    return { result: await p };
  } catch (e) {
    if (e instanceof NavSignal) return { nav: e.kind, to: e.to };
    throw e;
  }
};

beforeEach(async () => {
  await resetAuthTables();
  const org = await makeOrg('shop');
  [slug, orgId] = [org.slug, org.id];
  admin = (await addMember(org.id, 'admin', 'dispatch@example.test')).id;
  seeded = await seedFixtureDay(org.id, '03-demo-day');
  await signInAs(admin, { mfa: true });
});

describe('buildProblem', () => {
  it('rebuilds the fixture problem from the database (same techs, jobs and values, new ids)', async () => {
    const ctx = await actAs(admin, slug);
    const built = Problem.parse(await withOrg(ctx, (tx) => buildProblem(tx, orgId, seeded.date)));
    const fx = Problem.parse(fixtures.find((f) => f.name === '03-demo-day')!.problem);
    expect(built.jobs).toHaveLength(fx.jobs.length);
    expect(built.techs).toHaveLength(fx.techs.length);
    const byRef = new Map(fx.jobs.map((j) => [seeded.job.get(j.id), j]));
    for (const j of built.jobs) expect({ ...j, id: 'x' }).toEqual({ ...byRef.get(j.id)!, id: 'x' });
  });
});

describe('pins', () => {
  it('pin with a position, then unpin', async () => {
    const job = seeded.job.get('J01')!;
    const tech = seeded.techByName.get('Tahlequah Two')!;
    expect(await outcome(pinJob(slug, { id: job, techId: tech, position: '2' }))).toMatchObject({ nav: 'redirect' });
    expect(await db.job.findUnique({ where: { id: job }, select: { pinTechId: true, pinPosition: true } })).toEqual({ pinTechId: tech, pinPosition: 2 });
    const ctx = await actAs(admin, slug);
    const p = await withOrg(ctx, (tx) => buildProblem(tx, orgId, seeded.date));
    expect(p.jobs.find((j) => j.id === job)!.pin).toEqual({ techId: tech, position: 2 });
    await outcome(unpinJob(slug, { id: job }));
    expect(await db.job.findUnique({ where: { id: job }, select: { pinTechId: true, pinPosition: true } })).toEqual({ pinTechId: null, pinPosition: null });
  });

  it('a blank position pins to the tech only', async () => {
    const job = seeded.job.get('J02')!;
    await outcome(pinJob(slug, { id: job, techId: seeded.techByName.get('Muskogee One')!, position: '' }));
    expect((await db.job.findUnique({ where: { id: job } }))!.pinPosition).toBeNull();
  });

  it('a technician from another org is notFound, and nothing changes', async () => {
    const other = await makeOrg('rival');
    const rivalTech = await db.technician.create({ data: { orgId: other.id, name: 'Rival', skills: ['repair'], shiftStart: 480, shiftEnd: 1020, homeLat: 35.7, homeLng: -95.3, lunchEarliest: 690, lunchLatest: 780, maxJobs: 8 } });
    expect(await outcome(pinJob(slug, { id: seeded.job.get('J01')!, techId: rivalTech.id }))).toEqual({ nav: 'notFound', to: undefined });
    expect((await db.job.findUnique({ where: { id: seeded.job.get('J01')! } }))!.pinTechId).toBeNull();
  });

  it('a member cannot pin (dispatcher only, D-25)', async () => {
    const m = await addMember(orgId, 'member', 'tech@example.test');
    await signInAs(m.id, { mfa: true });
    await expect(pinJob(slug, { id: seeded.job.get('J01')!, techId: seeded.techByName.get('Muskogee One')! })).rejects.toThrow(/Missing permission/);
  });
});

describe('add job / add technician', () => {
  const job = { date: '2026-11-16', ref: 'N1', customer: 'Customer New', address: '9 Example Rd', lat: '35.75', lng: '-95.36', windowStart: '09:00', windowEnd: '11:00', durationMin: '45', skill: 'repair', priority: 'emergency' };
  it('adds a job from form strings', async () => {
    expect(await outcome(addJob(slug, job))).toMatchObject({ nav: 'redirect', to: `/o/${slug}/dispatch?date=2026-11-16` });
    expect(await db.job.findFirst({ where: { orgId, ref: 'N1' }, select: { windowStart: true, windowEnd: true, durationMin: true, priority: true } })).toEqual({ windowStart: 540, windowEnd: 660, durationMin: 45, priority: 'emergency' });
  });
  it.each([
    ['a window that ends first', { windowStart: '11:00', windowEnd: '09:00' }, /ends before it starts/],
    ['a duplicate job number', { ref: 'J01' }, /already exists/],
    ['a bad time', { windowStart: '9am' }, /HH:MM/],
    ['an unknown skill', { skill: 'plumbing' }, /Pick a skill/],
  ])('refuses %s', async (_, patch, msg) => {
    expect((await outcome(addJob(slug, { ...job, ...patch }))).result).toMatchObject({ error: expect.stringMatching(msg) });
  });

  const tech = { date: '2026-11-16', name: 'New Tech', skills: ['repair', 'install'], shiftStart: '07:00', shiftEnd: '15:30', lunchEarliest: '11:00', lunchLatest: '12:30', homeLat: '35.7', homeLng: '-95.3', maxJobs: '6', userId: '' };
  it('adds a technician, optionally linked to a member', async () => {
    const m = await addMember(orgId, 'member', 'newtech@example.test');
    expect(await outcome(addTech(slug, { ...tech, userId: m.id }))).toMatchObject({ nav: 'redirect' });
    expect(await db.technician.findFirst({ where: { orgId, name: 'New Tech' }, select: { userId: true, shiftStart: true, skills: true } })).toEqual({ userId: m.id, shiftStart: 420, skills: ['repair', 'install'] });
  });
  it('refuses a lunch window outside the shift, and a user from another org is notFound', async () => {
    expect((await outcome(addTech(slug, { ...tech, lunchLatest: '15:20' }))).result).toMatchObject({ error: expect.stringMatching(/lunch window/) });
    const other = await makeOrg('rival');
    const outsider = await addMember(other.id, 'member', 'outsider@example.test');
    expect(await outcome(addTech(slug, { ...tech, userId: outsider.id }))).toEqual({ nav: 'notFound', to: undefined });
  });
});
