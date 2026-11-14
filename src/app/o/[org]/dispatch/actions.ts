'use server';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { audit } from '@/core/audit';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { LUNCH_MINUTES, PRIORITIES, SKILLS } from '@/lib/dispatch/contract';
import { DISPATCH } from '@/lib/dispatch/roles';
import { buildProblem, savePlanIfValid } from '@/lib/dispatch/plan-store';
import { solveProblem, SolverUnavailable } from '@/lib/dispatch/solver-client';
import { DATE_RE, dayOf, parseHHMM } from '@/lib/dispatch/time';

// The dispatcher board's writes (PRD §3, Phase 2). Dispatcher = owner or admin (D-25). Every id is a ref() so the
// INV-01..04 harness drives these with cross-org ids; a tech or job outside the org is notFound, like a missing one.

const board = (ctx: OrgCtx, date?: string) => `/o/${ctx.slug}/dispatch${date ? `?date=${date}` : ''}`;
const date = z.string().trim().regex(DATE_RE, 'Pick a date.').refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'Pick a real date.');
// HH:MM from a form, or whole minutes from code and the harness.
const clock = (label: string) =>
  z.union([z.number().int(), z.string().min(1, `${label}: use HH:MM.`)]).transform((v, c) => {
    const m = typeof v === 'number' ? (v >= 0 && v <= 24 * 60 ? v : null) : parseHHMM(v);
    if (m === null) c.addIssue({ code: 'custom', message: `${label}: use HH:MM.` });
    return m ?? 0;
  });
// Only where the day just sets the page to return to: '' (or a missing day) goes back to the board's default day.
const backTo = z.union([z.literal(''), date]).optional();
const num = (label: string, min: number, max: number) => z.coerce.number({ message: `${label} must be a number.` }).min(min, `${label} is out of range.`).max(max, `${label} is out of range.`);

export const addJob = orgAction(
  DISPATCH,
  z.object({
    date,
    ref: z.string().trim().min(1, 'Give the job a number.').max(32),
    customer: z.string().trim().min(1, 'Customer name is required.').max(120),
    address: z.string().trim().min(1, 'Address is required.').max(200),
    lat: num('Latitude', -90, 90),
    lng: num('Longitude', -180, 180),
    windowStart: clock('Window start'),
    windowEnd: clock('Window end'),
    durationMin: num('Duration', 1, 720).int('Duration is whole minutes.'),
    skill: z.enum(SKILLS, { message: 'Pick a skill.' }),
    priority: z.enum(PRIORITIES, { message: 'Pick a priority.' }),
  }),
  async (ctx, i) => {
    if (i.windowEnd < i.windowStart) throw new Refused('The window ends before it starts.');
    await withOrg(ctx, async (tx) => {
      const exists = await tx.job.findFirst({ where: { ...inOrg(ctx), date: dayOf(i.date), ref: i.ref }, select: { id: true } });
      if (exists) throw new Refused(`Job ${i.ref} already exists on ${i.date}.`);
      const j = await tx.job.create({ data: { ...inOrg(ctx), ...i, date: dayOf(i.date) } });
      await audit(ctx, 'dispatch.job_created', { targetType: 'job', targetId: j.id, data: { ref: i.ref, date: i.date } }, tx);
    });
    redirect(board(ctx, i.date));
  },
);

export const addTech = orgAction(
  DISPATCH,
  z.object({
    date: backTo,
    name: z.string().trim().min(1, 'Give the technician a name.').max(120),
    skills: z.array(z.enum(SKILLS)).min(1, 'Pick at least one skill.'),
    shiftStart: clock('Shift start'),
    shiftEnd: clock('Shift end'),
    lunchEarliest: clock('Lunch earliest'),
    lunchLatest: clock('Lunch latest'),
    homeLat: num('Home latitude', -90, 90),
    homeLng: num('Home longitude', -180, 180),
    maxJobs: num('Max jobs', 0, 50).int(),
    userId: z.union([ref('member'), z.literal('')]).optional(), // '' = no login (the select's first option)
  }),
  async (ctx, { date: d, userId, ...t }) => {
    await withOrg(ctx, async (tx) => {
      // The ref first: a member of another org is notFound before any other check can answer (INV-02/04).
      if (userId) {
        const m = await tx.membership.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId } }, select: { role: true } });
        if (!m) notFound();
        if (await tx.technician.findFirst({ where: { ...inOrg(ctx), userId }, select: { id: true } })) throw new Refused('That member is already linked to a technician.');
      }
      if (t.shiftEnd <= t.shiftStart) throw new Refused('The shift ends before it starts.');
      if (t.lunchLatest < t.lunchEarliest || t.lunchEarliest < t.shiftStart || t.lunchLatest + LUNCH_MINUTES > t.shiftEnd)
        throw new Refused('The lunch window has to sit inside the shift.');
      const tech = await tx.technician.create({ data: { ...inOrg(ctx), ...t, userId: userId || null } });
      await audit(ctx, 'dispatch.tech_created', { targetType: 'technician', targetId: tech.id }, tx);
    });
    redirect(board(ctx, d || undefined));
  },
);

export const pinJob = orgAction(
  DISPATCH,
  z.object({ id: ref('job'), techId: ref('technician'), position: z.union([z.coerce.number().int().min(1, 'Position starts at 1.').max(50), z.literal('')]).optional() }),
  async (ctx, i) => {
    const d = await withOrg(ctx, async (tx) => {
      const [job, tech] = await Promise.all([
        tx.job.findFirst({ where: { ...inOrg(ctx), id: i.id }, select: { id: true, date: true, status: true, skill: true, ref: true } }),
        tx.technician.findFirst({ where: { ...inOrg(ctx), id: i.techId }, select: { id: true, skills: true, name: true } }),
      ]);
      if (!job || !tech) notFound();
      if (job.status !== 'unscheduled' && job.status !== 'scheduled') throw new Refused('That job is already underway.');
      await tx.job.update({ where: { id: job.id }, data: { pinTechId: tech.id, pinPosition: i.position || null } });
      await audit(ctx, 'dispatch.job_pinned', { targetType: 'job', targetId: job.id, data: { techId: tech.id, position: i.position || null } }, tx);
      return job.date.toISOString().slice(0, 10);
    });
    redirect(board(ctx, d));
  },
);

export const unpinJob = orgAction(DISPATCH, z.object({ id: ref('job') }), async (ctx, i) => {
  const d = await withOrg(ctx, async (tx) => {
    const job = await tx.job.findFirst({ where: { ...inOrg(ctx), id: i.id }, select: { id: true, date: true } });
    if (!job) notFound();
    await tx.job.update({ where: { id: job.id }, data: { pinTechId: null, pinPosition: null } });
    await audit(ctx, 'dispatch.job_unpinned', { targetType: 'job', targetId: job.id }, tx);
    return job.date.toISOString().slice(0, 10);
  });
  redirect(board(ctx, d));
});

/**
 * Plan the day: problem from the database → solver (outside any transaction: it can take seconds) → checker →
 * save. The problem is rebuilt inside the write transaction; if the day changed while the solver ran, nothing is saved.
 */
export const planDay = orgAction(DISPATCH, z.object({ date }), async (ctx, { date: d }) => {
  const problem = await withOrg(ctx, (tx) => buildProblem(tx, ctx.orgId, d), { atomic: false });
  let output: unknown;
  try {
    output = await solveProblem(problem);
  } catch (e) {
    if (e instanceof SolverUnavailable) throw new Refused('The planner is unavailable right now. Nothing was changed; try again in a minute.');
    throw e;
  }
  const result = await withOrg(ctx, async (tx) => {
    const again = await buildProblem(tx, ctx.orgId, d);
    if (JSON.stringify(again) !== JSON.stringify(problem)) throw new Refused('Jobs changed while planning. Nothing was saved; plan again.');
    return savePlanIfValid(tx, ctx, problem, output);
  });
  if (!result.ok) throw new Refused(`The planner returned a plan that failed the checks (${result.codes.join(', ')}). Nothing was saved.`);
  redirect(`${board(ctx, d)}&saved=1`);
});
