'use server';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { audit } from '@/core/audit';
import { orgAction, ref } from '@/core/authz/action';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { LUNCH_MINUTES, PRIORITIES, SKILLS } from '@/lib/dispatch/contract';
import { ETA_EDIT_MAX_CHARS } from '@/lib/dispatch/eta';
import { etaModelFromEnv } from '@/lib/dispatch/eta-llm';
import { approveAndSend, discardEtaText, draftEtaTexts, editEtaText } from '@/lib/dispatch/eta-store';
import { DISPATCH } from '@/lib/dispatch/roles';
import { buildProblem, currentPlan, loadReplan, lockDispatch, pinConflictMessage, replanPinMessage, savePlanIfValid, saveReplanIfValid, startedJobs } from '@/lib/dispatch/plan-store';
import { ACTIVE, NEXT_STATUS as NEXT, STATUS_LABEL, type JobStatus } from '@/lib/dispatch/replan';
import { isDispatcher } from '@/lib/dispatch/roles';
import { solveProblem, SolverUnavailable } from '@/lib/dispatch/solver-client';
import { DATE_RE, dayOf, hhmm, isoDay, isRealDay, parseHHMM } from '@/lib/dispatch/time';

// The dispatcher board's writes (PRD §3, Phase 2). Dispatcher = owner or admin (D-25). Every id is a ref() so the
// INV-01..04 harness drives these with cross-org ids; a tech or job outside the org is notFound, like a missing one.
// Every write takes the org's dispatch lock first, so a plan is never saved over a day another write is changing (D-28).

const board = (ctx: OrgCtx, date?: string) => `/o/${ctx.slug}/dispatch${date ? `?date=${date}` : ''}`;
const date = z.string().trim().regex(DATE_RE, 'Pick a date.').refine(isRealDay, 'Pick a real date.');
// HH:MM from a form, or whole minutes from code and the harness.
const clock = (label: string) =>
  z.union([z.number().int(), z.string().min(1, `${label}: use HH:MM.`)]).transform((v, c) => {
    const m = typeof v === 'number' ? (v >= 0 && v <= 24 * 60 ? v : null) : parseHHMM(v);
    if (m === null) c.addIssue({ code: 'custom', message: `${label}: use HH:MM.` });
    return m ?? 0;
  });
// Only where the day just sets the page to return to: '' (or a missing day) goes back to the board's default day.
const backTo = z.union([z.literal(''), date]).optional();
// Phase 4 (D-55): the customer's phone for ETA texts; optional ('' = none, the text can't be sent).
const phone = z.union([z.literal(''), z.string().trim().regex(/^\+?[0-9][0-9 ().-]{6,24}$/, 'Phone: digits, spaces, dashes or brackets.')]).optional();
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
    customerPhone: phone,
  }),
  async (ctx, { customerPhone, ...i }) => {
    if (i.windowEnd < i.windowStart) throw new Refused('The window ends before it starts.');
    await withOrg(ctx, async (tx) => {
      await lockDispatch(tx, ctx.orgId);
      const exists = await tx.job.findFirst({ where: { ...inOrg(ctx), date: dayOf(i.date), ref: i.ref }, select: { id: true } });
      if (exists) throw new Refused(`Job ${i.ref} already exists on ${i.date}.`);
      const j = await tx.job.create({ data: { ...inOrg(ctx), ...i, customerPhone: customerPhone || null, date: dayOf(i.date) } });
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
      await lockDispatch(tx, ctx.orgId);
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
      await lockDispatch(tx, ctx.orgId);
      const [job, tech] = await Promise.all([
        tx.job.findFirst({ where: { ...inOrg(ctx), id: i.id }, select: { id: true, date: true, status: true, skill: true, ref: true } }),
        tx.technician.findFirst({ where: { ...inOrg(ctx), id: i.techId }, select: { id: true, skills: true, name: true } }),
      ]);
      if (!job || !tech) notFound();
      if (job.status !== 'unscheduled' && job.status !== 'scheduled') throw new Refused('That job is already underway.');
      if (!tech.skills.includes(job.skill)) throw new Refused(`${tech.name} doesn't have the ${job.skill} skill job ${job.ref} needs.`);
      await tx.job.update({ where: { id: job.id }, data: { pinTechId: tech.id, pinPosition: i.position || null } });
      await audit(ctx, 'dispatch.job_pinned', { targetType: 'job', targetId: job.id, data: { techId: tech.id, position: i.position || null } }, tx);
      return job.date.toISOString().slice(0, 10);
    });
    redirect(board(ctx, d));
  },
);

export const unpinJob = orgAction(DISPATCH, z.object({ id: ref('job') }), async (ctx, i) => {
  const d = await withOrg(ctx, async (tx) => {
    await lockDispatch(tx, ctx.orgId);
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
  const { problem, pins } = await withOrg(
    ctx,
    async (tx) => {
      const problem = await buildProblem(tx, ctx.orgId, d);
      return { problem, pins: await pinConflictMessage(tx, ctx.orgId, problem) };
    },
    { atomic: false },
  );
  // D-37: pins the checker already knows can't all be kept → say which, without asking the solver for a plan it can't give.
  if (pins) throw new Refused(pins);
  // D-42: a whole-day plan would drop started work from the saved plan; only a re-plan keeps it in place (TR-03).
  if (await withOrg(ctx, (tx) => startedJobs(tx, ctx.orgId, d), { atomic: false }))
    throw new Refused('Work has started on this day, so it can’t be planned from scratch. Use “Re-plan from” instead: started jobs stay where they are.');
  let output: unknown;
  try {
    output = await solveProblem(problem);
  } catch (e) {
    if (e instanceof SolverUnavailable) throw new Refused('The planner is unavailable right now. Nothing was changed; try again in a minute.');
    throw e;
  }
  const result = await withOrg(ctx, async (tx) => {
    await lockDispatch(tx, ctx.orgId); // no other dispatch write can change the day between this re-read and the commit
    const again = await buildProblem(tx, ctx.orgId, d);
    if (JSON.stringify(again) !== JSON.stringify(problem)) throw new Refused('Jobs changed while planning. Nothing was saved; plan again.');
    if (await startedJobs(tx, ctx.orgId, d)) throw new Refused('Work started on this day while planning. Nothing was saved; use “Re-plan from” instead.');
    return savePlanIfValid(tx, ctx, problem, output);
  });
  if (!result.ok && result.pinConflict) throw new Refused(result.pinConflict);
  if (!result.ok) throw new Refused(`The planner returned a plan that failed the checks (${result.codes.join(', ')}). Nothing was saved.`);
  redirect(`${board(ctx, d)}&saved=1`);
});

// ---------- Phase 3: mid-day re-plan, emergency insert, technician statuses ----------

const asOfField = clock('Re-plan time');

/**
 * The re-plan itself (PRD §3 "Re-plan", TR-03): open work only, techs starting where their statuses put them, started
 * jobs and pins kept. Same shape as planDay: read → solver (outside any transaction) → re-read under the dispatch lock
 * and refuse if anything changed (D-28) → checkPlan + checkReplan → save. Throws Refused with the dispatcher's message.
 */
async function replan(ctx: OrgCtx, d: string, asOf: number): Promise<{ emergencies: { placed: string[]; unplaced: string[] } }> {
  const state = await withOrg(ctx, (tx) => loadReplan(tx, ctx.orgId, d, asOf), { atomic: false });
  const pins = replanPinMessage(state); // D-37/D-43: the same pin-conflict message Plan the day gives, before any solve
  if (pins) throw new Refused(pins);
  let output: unknown;
  try {
    output = await solveProblem(state.build.problem);
  } catch (e) {
    if (e instanceof SolverUnavailable) throw new Refused('The planner is unavailable right now. Nothing was changed; try again in a minute.');
    throw e;
  }
  const result = await withOrg(ctx, async (tx) => {
    await lockDispatch(tx, ctx.orgId);
    const again = await loadReplan(tx, ctx.orgId, d, asOf);
    if (again.basePlanId !== state.basePlanId || JSON.stringify(again.build) !== JSON.stringify(state.build) || JSON.stringify(again.input) !== JSON.stringify(state.input))
      throw new Refused('The day changed while re-planning (a status, a job or a plan). Nothing was saved; re-plan again.');
    return saveReplanIfValid(tx, ctx, state, output);
  });
  if (!result.ok && result.pinConflict) throw new Refused(result.pinConflict);
  if (!result.ok) throw new Refused(`The planner returned a re-plan that failed the checks (${result.codes.join(', ')}). Nothing was saved.`);
  return { emergencies: result.emergencies! };
}

const replanned = (ctx: OrgCtx, d: string, asOf: number) => `${board(ctx, d)}&replanned=${hhmm(asOf).replace(':', '')}`;

export const replanDay = orgAction(DISPATCH, z.object({ date, asOf: asOfField }), async (ctx, { date: d, asOf }) => {
  await replan(ctx, d, asOf);
  redirect(replanned(ctx, d, asOf));
});

/**
 * Emergency insert (PRD §3): add an emergency job and re-plan from the given time in one step (D-45). The job is saved
 * first; if the re-plan then fails, the job stays on the board unassigned and the dispatcher is told why.
 */
export const insertEmergency = orgAction(
  DISPATCH,
  z.object({
    date,
    asOf: asOfField,
    ref: z.string().trim().min(1, 'Give the job a number.').max(32),
    customer: z.string().trim().min(1, 'Customer name is required.').max(120),
    address: z.string().trim().min(1, 'Address is required.').max(200),
    lat: num('Latitude', -90, 90),
    lng: num('Longitude', -180, 180),
    windowEnd: clock('Window end'),
    durationMin: num('Duration', 1, 720).int('Duration is whole minutes.'),
    skill: z.enum(SKILLS, { message: 'Pick a skill.' }),
    customerPhone: phone,
  }),
  async (ctx, { asOf, customerPhone, ...i }) => {
    if (i.windowEnd < asOf) throw new Refused('The window ends before the re-plan time.');
    await withOrg(ctx, async (tx) => {
      await lockDispatch(tx, ctx.orgId);
      if (!(await currentPlan(tx, ctx.orgId, i.date))) throw new Refused('There is no plan for this day yet. Plan the day first, then insert the emergency.');
      const exists = await tx.job.findFirst({ where: { ...inOrg(ctx), date: dayOf(i.date), ref: i.ref }, select: { id: true } });
      if (exists) throw new Refused(`Job ${i.ref} already exists on ${i.date}.`);
      const j = await tx.job.create({ data: { ...inOrg(ctx), ...i, customerPhone: customerPhone || null, date: dayOf(i.date), windowStart: asOf, priority: 'emergency' } });
      await audit(ctx, 'dispatch.job_created', { targetType: 'job', targetId: j.id, data: { ref: i.ref, date: i.date, emergency: true, asOf: hhmm(asOf) } }, tx);
    });
    try {
      await replan(ctx, i.date, asOf);
    } catch (e) {
      if (e instanceof Refused) throw new Refused(`Emergency job ${i.ref} was added, but the re-plan didn’t go through: ${e.message}`);
      throw e;
    }
    redirect(replanned(ctx, i.date, asOf));
  },
);

/**
 * A technician's status for one of their stops (PRD §2): en route → on site → done, or can't complete. A technician
 * may only touch a job on their own route in the day's current plan; anything else is notFound, the same as a missing
 * id (TR-05). The dispatcher may set any stop's status. One active job (en route / on site) per technician.
 */
export const setJobStatus = orgAction(
  null,
  z.object({
    id: ref('job'),
    status: z.enum(['en_route', 'on_site', 'done', 'cant_complete'], { message: 'Pick a status.' }),
    note: z.string().trim().max(500, 'Keep the note under 500 characters.').optional(),
    back: z.enum(['my-day', 'stop', 'board']).optional(),
  }),
  async (ctx, i) => {
    const where = await withOrg(ctx, async (tx) => {
      await lockDispatch(tx, ctx.orgId);
      const job = await tx.job.findFirst({ where: { ...inOrg(ctx), id: i.id } });
      if (!job) notFound();
      const day = isoDay(job.date);
      const plan = await currentPlan(tx, ctx.orgId, day);
      const stop = plan ? await tx.planStop.findFirst({ where: { ...inOrg(ctx), planId: plan.id, jobId: job.id }, include: { tech: { select: { id: true, userId: true, name: true } } } }) : null;
      const dispatcher = isDispatcher(ctx.role);
      if (!dispatcher && (!stop || stop.tech.userId !== ctx.userId)) notFound();
      if (!stop) throw new Refused(`Job ${job.ref} is not on the current plan, so it has no technician to update.`);
      const from = job.status as JobStatus;
      if (!NEXT[from].includes(i.status)) throw new Refused(`Job ${job.ref} is ${STATUS_LABEL[from]}; it can’t go to ${STATUS_LABEL[i.status]}.`);
      if (i.status === 'cant_complete' && !i.note) throw new Refused('Say why the job can’t be completed.');
      if (ACTIVE.includes(i.status)) {
        const busy = await tx.planStop.findFirst({
          where: { ...inOrg(ctx), planId: plan!.id, techId: stop.tech.id, jobId: { not: job.id }, job: { status: { in: [...ACTIVE] } } },
          include: { job: { select: { ref: true, status: true } } },
        });
        if (busy) throw new Refused(`${stop.tech.name} is already ${STATUS_LABEL[busy.job.status as JobStatus]} for job ${busy.job.ref}. Finish that one first.`);
      }
      const now = new Date();
      await tx.job.update({
        where: { id: job.id },
        data: {
          status: i.status,
          ...(i.status === 'en_route' ? { enRouteAt: now } : {}),
          ...(i.status === 'on_site' ? { onSiteAt: now } : {}),
          ...(i.status === 'done' || i.status === 'cant_complete' ? { doneAt: now } : {}),
          ...(i.status === 'cant_complete' ? { statusNote: i.note } : {}),
        },
      });
      await audit(ctx, 'dispatch.job_status', { targetType: 'job', targetId: job.id, data: { from, to: i.status, techId: stop.tech.id, by: dispatcher ? 'dispatcher' : 'technician' } }, tx);
      return { day, stopId: stop.id };
    });
    const base = `/o/${ctx.slug}/dispatch`;
    if (i.back === 'stop') redirect(`${base}/stops/${where.stopId}`);
    if (i.back === 'board') redirect(`${base}?date=${where.day}`);
    redirect(`${base}/my-day?date=${where.day}`);
  },
);

// ---------- Phase 4: customer ETA texts (PRD §3, TR-06) ----------

const etaBoard = (ctx: OrgCtx, d: string, flag?: string) => `${board(ctx, d)}${flag ? `&${flag}` : ''}#eta`;

/**
 * Draft one ETA text per job of the day's current plan: Claude through withBudget when ANTHROPIC_API_KEY is set,
 * otherwise (or when the model's text fails the validator) the template (D-06, D-50, D-51). Nothing is sent.
 */
export const draftEtas = orgAction(DISPATCH, z.object({ date }), async (ctx, { date: d }) => {
  const r = await draftEtaTexts(ctx, d, etaModelFromEnv());
  redirect(etaBoard(ctx, d, `drafted=${r.drafted}`));
});

export const editEta = orgAction(
  DISPATCH,
  z.object({ id: ref('etaText'), body: z.string().trim().min(1, 'The text can’t be empty.').max(ETA_EDIT_MAX_CHARS, `Keep the text under ${ETA_EDIT_MAX_CHARS} characters.`) }),
  async (ctx, i) => {
    const d = await withOrg(ctx, async (tx) => {
      await lockDispatch(tx, ctx.orgId);
      return editEtaText(tx, ctx, i.id, i.body);
    });
    if (d === 'notFound') notFound();
    redirect(etaBoard(ctx, d));
  },
);

export const discardEta = orgAction(DISPATCH, z.object({ id: ref('etaText') }), async (ctx, i) => {
  const d = await withOrg(ctx, async (tx) => {
    await lockDispatch(tx, ctx.orgId);
    return discardEtaText(tx, ctx, i.id);
  });
  if (d === 'notFound') notFound();
  redirect(etaBoard(ctx, d));
});

/**
 * Approve and send (TR-06): for each chosen draft, the dispatcher's approval goes into the audit log, then the text is
 * "sent" into the captured-message store (no real SMS, D-05/D-49). All or nothing: one bad draft sends none.
 */
export const approveEtas = orgAction(
  DISPATCH,
  z.object({ ids: z.array(ref('etaText')).min(1, 'Tick at least one ETA text to approve.').max(200) }),
  async (ctx, i) => {
    const r = await withOrg(ctx, async (tx) => {
      await lockDispatch(tx, ctx.orgId);
      return approveAndSend(tx, ctx, i.ids);
    });
    if (r === 'notFound') notFound();
    redirect(etaBoard(ctx, r.date, `sent=${r.sent}`));
  },
);
