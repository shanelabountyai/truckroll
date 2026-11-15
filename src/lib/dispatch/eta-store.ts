import { audit } from '@/core/audit';
import { inOrg, type OrgCtx } from '@/core/authz/guards';
import { withOrg, type Tx } from '@/core/db/rls';
import { Refused } from '@/core/errors';
import { Plan as PlanSchema } from './contract';
import { bodySha256, etaFacts, type EtaFacts, type EtaJob } from './eta';
import { draftEta, type EtaModel } from './eta-llm';
import { currentPlan, lockDispatch } from './plan-store';
import { isDispatcher } from './roles';
import { isoDay } from './time';

// The database side of ETA texts (PRD §3, Phase 4, TR-06). Draft → (edit) → approve and send. "Send" writes a
// CapturedMessage (no real SMS in v1, D-05/D-49) and only sendApprovedEta does it, after finding the dispatcher's
// approval event for exactly this text in the audit log. The truckroll_phase4 trigger checks the same thing again.

/** Jobs that get an ETA text: on a route and not yet reached or finished (en route still gets one: the truck is coming). */
export const ETA_STATUSES = ['scheduled', 'en_route'] as const;
export const APPROVED = 'dispatch.eta_approved';

/**
 * Drafts one text per job of the day's current plan that has none sent yet. Model calls (if any) run outside any
 * transaction; the drafts are written under the dispatch lock only if the plan is still the current one (D-28, D-53).
 * Older plans' unsent drafts for the day are discarded: they describe a plan that is no longer live.
 */
export async function draftEtaTexts(ctx: OrgCtx, date: string, model: EtaModel | null): Promise<{ drafted: number; llm: number; template: number; skipped: number }> {
  const read = await withOrg(
    ctx,
    async (tx) => {
      const plan = await currentPlan(tx, ctx.orgId, date);
      if (!plan) throw new Refused('There is no plan for this day yet. Plan the day first, then draft ETA texts.');
      const parsed = PlanSchema.safeParse(plan.plan);
      if (!parsed.success) throw new Refused('The current plan could not be read. Plan the day again.');
      const [org, jobs, techs, sent] = await Promise.all([
        tx.org.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true } }),
        tx.job.findMany({ where: { ...inOrg(ctx), date: plan.date, status: { in: [...ETA_STATUSES] } } }),
        tx.technician.findMany({ where: inOrg(ctx), select: { id: true, name: true } }),
        tx.etaText.findMany({ where: { ...inOrg(ctx), planId: plan.id, status: 'sent' }, select: { jobId: true } }),
      ]);
      const done = new Set(sent.map((s) => s.jobId));
      const jobMap = new Map<string, EtaJob & { phone: string | null }>(jobs.filter((j) => !done.has(j.id)).map((j) => [j.id, { ...j, phone: j.customerPhone }]));
      const facts = etaFacts({ plan: parsed.data, date, shop: org.name, jobs: jobMap, techNames: new Map(techs.map((t) => [t.id, t.name])) });
      return { planId: plan.id, facts, phones: new Map([...jobMap].map(([id, j]) => [id, j.phone])), skipped: done.size };
    },
    { atomic: false },
  );
  if (!read.facts.length) throw new Refused(read.skipped ? 'Every job on the current plan already has its ETA text sent.' : 'No jobs on the current plan need an ETA text.');

  const drafts: { f: EtaFacts; body: string; source: string; fallbackReason: string | null }[] = [];
  for (const f of read.facts) drafts.push({ f, ...(await draftEta(ctx, f, model)) }); // one at a time: the budget is checked per call

  return withOrg(ctx, async (tx) => {
    await lockDispatch(tx, ctx.orgId);
    const plan = await currentPlan(tx, ctx.orgId, date);
    if (plan?.id !== read.planId) throw new Refused('The plan changed while drafting. Nothing was saved; draft the ETA texts again.');
    const sentNow = new Set((await tx.etaText.findMany({ where: { ...inOrg(ctx), planId: plan.id, status: 'sent' }, select: { jobId: true } })).map((s) => s.jobId));
    let drafted = 0;
    for (const d of drafts) {
      if (sentNow.has(d.f.jobId)) continue;
      const data = { phone: read.phones.get(d.f.jobId) ?? null, body: d.body, source: d.source, fallbackReason: d.fallbackReason, status: 'draft' as const, createdById: ctx.userId, createdAt: new Date(), editedAt: null };
      await tx.etaText.upsert({ where: { planId_jobId: { planId: plan.id, jobId: d.f.jobId } }, create: { ...inOrg(ctx), planId: plan.id, jobId: d.f.jobId, ...data }, update: data });
      drafted++;
    }
    const stale = await tx.etaText.updateMany({ where: { ...inOrg(ctx), plan: { date: plan.date }, planId: { not: plan.id }, status: 'draft' }, data: { status: 'discarded' } });
    const llm = drafts.filter((d) => d.source === 'llm').length;
    await audit(ctx, 'dispatch.eta_drafted', { targetType: 'dispatchPlan', targetId: plan.id, data: { date, drafted, llm, template: drafts.length - llm, staleDiscarded: stale.count } }, tx);
    return { drafted, llm, template: drafts.length - llm, skipped: read.skipped };
  });
}

async function findDraft(tx: Tx, ctx: OrgCtx, id: string) {
  const t = await tx.etaText.findFirst({ where: { ...inOrg(ctx), id }, include: { job: { select: { ref: true } }, plan: { select: { id: true, date: true } } } });
  return t;
}

/** A dispatcher's edit of a draft. The body changes, so any approval of the old body no longer matches (TR-06). */
export async function editEtaText(tx: Tx, ctx: OrgCtx, id: string, body: string): Promise<string> {
  const t = await findDraft(tx, ctx, id);
  if (!t) return 'notFound';
  if (t.status !== 'draft') throw new Refused(`The ETA text for job ${t.job.ref} was already ${t.status}; it can’t be edited.`);
  await tx.etaText.update({ where: { id: t.id }, data: { body, editedAt: new Date() } });
  await audit(ctx, 'dispatch.eta_edited', { targetType: 'etaText', targetId: t.id, data: { jobId: t.jobId, bodySha256: bodySha256(body) } }, tx);
  return isoDay(t.plan.date);
}

export async function discardEtaText(tx: Tx, ctx: OrgCtx, id: string): Promise<string> {
  const t = await findDraft(tx, ctx, id);
  if (!t) return 'notFound';
  if (t.status !== 'draft') throw new Refused(`The ETA text for job ${t.job.ref} was already ${t.status}.`);
  await tx.etaText.update({ where: { id: t.id }, data: { status: 'discarded' } });
  await audit(ctx, 'dispatch.eta_discarded', { targetType: 'etaText', targetId: t.id, data: { jobId: t.jobId } }, tx);
  return isoDay(t.plan.date);
}

/**
 * Approve and send (PRD §3: "reviewed by the dispatcher, 'sent'"). Every id is checked first (a missing or other-org id
 * is notFound before anything is written); then, per text, the approval event goes into the audit log and only then
 * sendApprovedEta sends it. Caller holds the dispatch lock and has checked the dispatcher role.
 */
export async function approveAndSend(tx: Tx, ctx: OrgCtx, ids: string[]): Promise<{ date: string; sent: number } | 'notFound'> {
  const rows = [];
  for (const id of [...new Set(ids)]) {
    const t = await findDraft(tx, ctx, id);
    if (!t) return 'notFound';
    rows.push(t);
  }
  const dates = new Set(rows.map((r) => isoDay(r.plan.date)));
  if (dates.size !== 1) throw new Refused('Approve the ETA texts of one day at a time.');
  const date = [...dates][0]!;
  const current = await currentPlan(tx, ctx.orgId, date);
  for (const t of rows) {
    if (t.status !== 'draft') throw new Refused(`The ETA text for job ${t.job.ref} was already ${t.status}.`);
    if (t.planId !== current?.id) throw new Refused(`The ETA text for job ${t.job.ref} was drafted for an older plan. Draft the ETA texts again for the current plan. Nothing was sent.`);
    if (!t.phone) throw new Refused(`Job ${t.job.ref} has no customer phone number, so its ETA text can’t be sent. Nothing was sent.`);
  }
  for (const t of rows) {
    await audit(ctx, APPROVED, { targetType: 'etaText', targetId: t.id, data: { planId: t.planId, jobId: t.jobId, bodySha256: bodySha256(t.body), phone: t.phone } }, tx);
    await sendApprovedEta(tx, ctx, t.id);
  }
  return { date, sent: rows.length };
}

/**
 * TR-06, the only writer of a captured ETA message. Trusts nothing the caller says: re-reads the draft and the audit
 * log, and sends only if a dispatcher's `dispatch.eta_approved` event exists for this draft, this plan and this exact
 * body (SHA-256), and the plan is still the day's current one. Otherwise Refused and nothing is written.
 */
export async function sendApprovedEta(tx: Tx, ctx: OrgCtx, id: string): Promise<void> {
  const t = await findDraft(tx, ctx, id);
  if (!t) throw new Refused('That ETA text does not exist.');
  if (t.status !== 'draft') throw new Refused(`The ETA text for job ${t.job.ref} was already ${t.status}.`);
  if (!t.phone) throw new Refused(`Job ${t.job.ref} has no customer phone number.`);
  const current = await currentPlan(tx, ctx.orgId, isoDay(t.plan.date));
  if (current?.id !== t.planId) throw new Refused(`The ETA text for job ${t.job.ref} belongs to an older plan.`);
  const sha = bodySha256(t.body);
  const events = await tx.auditEvent.findMany({ where: { orgId: ctx.orgId, action: APPROVED, targetType: 'etaText', targetId: t.id }, orderBy: { id: 'desc' } });
  const approval = events.find((e) => {
    const d = (e.data ?? {}) as { bodySha256?: unknown; planId?: unknown };
    return d.bodySha256 === sha && d.planId === t.planId; // an edit changes the hash, so an older approval can't match
  });
  if (!approval?.actorUserId) throw new Refused(`TR-06: the ETA text for job ${t.job.ref} has no dispatcher approval for this exact text. Nothing was sent.`);
  const approver = await tx.membership.findUnique({ where: { orgId_userId: { orgId: ctx.orgId, userId: approval.actorUserId } }, select: { role: true } });
  if (!approver || !isDispatcher(approver.role)) throw new Refused(`TR-06: the ETA text for job ${t.job.ref} was not approved by a dispatcher. Nothing was sent.`);
  const msg = await tx.capturedMessage.create({ data: { to: t.phone, subject: 'sms', body: t.body }, select: { id: true } });
  await tx.etaText.update({ where: { id: t.id }, data: { status: 'sent', approvedById: approval.actorUserId, approvedAt: approval.at, sentAt: new Date(), capturedMessageId: msg.id } });
  await audit(ctx, 'dispatch.eta_sent', { targetType: 'etaText', targetId: t.id, data: { jobId: t.jobId, capturedMessageId: msg.id } }, tx);
}
