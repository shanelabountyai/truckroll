import { beforeEach, describe, expect, it } from 'vitest';
import { approveEtas, discardEta, draftEtas, editEta } from '@/app/o/[org]/dispatch/actions';
import { audit } from '@/core/audit';
import { AuthzError } from '@/core/authz/guards';
import { withOrg } from '@/core/db/rls';
import { dbSystem as db } from '@/core/db/system';
import { Refused } from '@/core/errors';
import { bodySha256 } from '@/lib/dispatch/eta';
import { APPROVED, editEtaText, sendApprovedEta } from '@/lib/dispatch/eta-store';
import { resetAuthTables, signInAs } from '../helpers/auth';
import { NavSignal } from '../helpers/next';
import { actAs } from '../helpers/org';
import { etaWorld, savePlan, type EtaWorld } from './eta-setup';

// TR-06: ETA text drafts are never "sent" without a dispatcher approval event in the audit log. "Sent" = a
// CapturedMessage (no real SMS, D-05/D-49). Three layers are tested: the actions, the send guard itself
// (sendApprovedEta, which re-reads the audit log), and the database trigger (truckroll_phase4 migration).

let w: EtaWorld;
beforeEach(async () => {
  await resetAuthTables();
  delete process.env.ANTHROPIC_API_KEY; // the template path; the model path is eta-llm.test.ts
  w = await etaWorld();
});

type Out = { error?: string; redirected?: string; notFound?: true; guard?: string };
async function as(user: string, fn: (slug: string, input: unknown) => Promise<unknown>, input: unknown): Promise<Out> {
  await signInAs(user, { mfa: true });
  try {
    return ((await fn(w.slug, input)) ?? {}) as Out;
  } catch (e) {
    if (e instanceof NavSignal) return e.kind === 'redirect' ? { redirected: e.to } : { notFound: true };
    if (e instanceof Refused) return { error: e.message };
    if (e instanceof AuthzError) return { guard: e.message };
    throw e;
  }
}

const drafts = () => db.etaText.findMany({ where: { orgId: w.orgId, status: 'draft' }, orderBy: { id: 'asc' } });
const captured = () => db.capturedMessage.findMany({ where: { subject: 'sms' } });
const approvals = () => db.auditEvent.findMany({ where: { orgId: w.orgId, action: APPROVED }, orderBy: { id: 'asc' } });
const STOPS = 24; // the demo day's golden plan routes every job

/** Every sent text has its dispatcher approval for exactly that body, made before it was sent; every captured SMS is one of them. */
async function sweep() {
  const sent = await db.etaText.findMany({ where: { status: 'sent' } });
  const events = await db.auditEvent.findMany({ where: { action: { in: [APPROVED, 'dispatch.eta_sent'] } }, orderBy: { id: 'asc' } });
  for (const t of sent) {
    const ok = events.find((e) => e.action === APPROVED && e.targetId === t.id && (e.data as { bodySha256: string }).bodySha256 === bodySha256(t.body) && e.actorUserId === t.approvedById);
    expect(ok, `sent ETA ${t.id} has no matching approval`).toBeDefined();
    const sentEvent = events.find((e) => e.action === 'dispatch.eta_sent' && e.targetId === t.id)!;
    expect(ok!.id < sentEvent.id).toBe(true);
    const m = await db.membership.findUniqueOrThrow({ where: { orgId_userId: { orgId: t.orgId, userId: t.approvedById! } } });
    expect(['owner', 'admin']).toContain(m.role);
  }
  const msgs = await captured();
  expect(msgs.map((m) => m.id).sort()).toEqual(sent.map((t) => t.capturedMessageId).sort());
  for (const m of msgs) expect(sent.find((t) => t.capturedMessageId === m.id)).toMatchObject({ body: m.body, phone: m.to });
}

describe('TR-06: the approve action', () => {
  it('drafting sends nothing; approving sends exactly the approved drafts, each after its approval event', async () => {
    expect((await as(w.admin, draftEtas, { date: w.seeded.date })).redirected).toBe(`/o/${w.slug}/dispatch?date=${w.seeded.date}&drafted=${STOPS}#eta`);
    const d = await drafts();
    expect(d).toHaveLength(STOPS);
    expect(d.every((t) => t.source === 'template' && t.planId === w.planId && t.phone)).toBe(true);
    expect(await captured()).toHaveLength(0);
    expect(await approvals()).toHaveLength(0);

    const some = d.slice(0, 3).map((t) => t.id);
    expect((await as(w.admin, approveEtas, { ids: some })).redirected).toBe(`/o/${w.slug}/dispatch?date=${w.seeded.date}&sent=3#eta`);
    expect(await captured()).toHaveLength(3);
    expect(await approvals()).toHaveLength(3);
    expect(await drafts()).toHaveLength(STOPS - 3);
    await sweep();

    // A sent text is never sent twice.
    expect((await as(w.admin, approveEtas, { ids: [some[0]] })).error).toMatch(/already sent/);
    expect(await captured()).toHaveLength(3);
  });

  it('a technician can draft, edit or approve nothing', async () => {
    await as(w.admin, draftEtas, { date: w.seeded.date });
    const id = (await drafts())[0]!.id;
    for (const [fn, input] of [[draftEtas, { date: w.seeded.date }], [approveEtas, { ids: [id] }], [editEta, { id, body: 'hi' }], [discardEta, { id }]] as const) {
      const r = await as(w.tech, fn, input);
      expect(r, JSON.stringify(r)).toEqual({ guard: 'Missing permission: org.update' });
    }
    expect(await captured()).toHaveLength(0);
    expect(await approvals()).toHaveLength(0);
    expect((await drafts())[0]!.body).not.toBe('hi');
  });

  it('another org’s draft is notFound and nothing is sent', async () => {
    await as(w.admin, draftEtas, { date: w.seeded.date });
    const mine = w;
    w = await etaWorld('other');
    await as(w.admin, draftEtas, { date: w.seeded.date });
    const theirs = (await drafts())[0]!.id;
    w = mine;
    expect(await as(w.admin, approveEtas, { ids: [theirs] })).toEqual({ notFound: true });
    expect(await as(w.admin, approveEtas, { ids: [(await drafts())[0]!.id, theirs] })).toEqual({ notFound: true });
    expect(await captured()).toHaveLength(0);
    expect(await db.auditEvent.count({ where: { action: APPROVED } })).toBe(0);
  });

  it('all or nothing: one draft without a phone sends none', async () => {
    await as(w.admin, draftEtas, { date: w.seeded.date });
    const [a, b] = await drafts();
    await db.etaText.update({ where: { id: b!.id }, data: { phone: null } });
    expect((await as(w.admin, approveEtas, { ids: [a!.id, b!.id] })).error).toMatch(/no customer phone number/);
    expect(await captured()).toHaveLength(0);
    expect(await approvals()).toHaveLength(0);
  });

  it('drafts of an older plan can’t be sent; drafting again discards them', async () => {
    await as(w.admin, draftEtas, { date: w.seeded.date });
    const old = (await drafts())[0]!.id;
    await savePlan(w.slug, w.orgId, w.admin, w.seeded); // a new current plan (a re-plan does the same)
    expect((await as(w.admin, approveEtas, { ids: [old] })).error).toMatch(/older plan/);
    expect(await captured()).toHaveLength(0);
    await as(w.admin, draftEtas, { date: w.seeded.date });
    expect((await db.etaText.findUniqueOrThrow({ where: { id: old } })).status).toBe('discarded');
    expect(await drafts()).toHaveLength(STOPS);
  });

  it('an edited draft is sent as edited, and the approval records the edited text', async () => {
    await as(w.admin, draftEtas, { date: w.seeded.date });
    const t = (await drafts())[0]!;
    expect((await as(w.admin, editEta, { id: t.id, body: 'Edited by the dispatcher.' })).redirected).toBeDefined();
    await as(w.admin, approveEtas, { ids: [t.id] });
    const [m] = await captured();
    expect(m!.body).toBe('Edited by the dispatcher.');
    expect((await approvals())[0]!.data).toMatchObject({ bodySha256: bodySha256('Edited by the dispatcher.') });
    await sweep();
  });
});

describe('TR-06: the send guard trusts only the audit log', () => {
  // The app's guard answers with Refused before the database trigger is reached (that layer is tested below).
  let send: (id: string) => Promise<void>;
  async function ctxAndDraft() {
    await as(w.admin, draftEtas, { date: w.seeded.date });
    const ctx = await actAs(w.admin, w.slug);
    send = async (id) => {
      try {
        await withOrg(ctx, (tx) => sendApprovedEta(tx, ctx, id));
      } catch (e) {
        expect(e).toBeInstanceOf(Refused);
        throw e;
      }
    };
    return { ctx, t: (await drafts())[0]! };
  }

  it('no approval event → refused, nothing captured', async () => {
    const { t } = await ctxAndDraft();
    await expect(send(t.id)).rejects.toThrow(/TR-06: .*no dispatcher approval/);
    expect(await captured()).toHaveLength(0);
    expect((await db.etaText.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('draft');
  });

  it('an approval of the text before it was edited → refused', async () => {
    const { ctx, t } = await ctxAndDraft();
    await withOrg(ctx, (tx) => audit(ctx, APPROVED, { targetType: 'etaText', targetId: t.id, data: { planId: t.planId, jobId: t.jobId, bodySha256: bodySha256(t.body) } }, tx));
    await withOrg(ctx, (tx) => editEtaText(tx, ctx, t.id, `${t.body} Changed after approval.`));
    await expect(send(t.id)).rejects.toThrow(/TR-06/);
    expect(await captured()).toHaveLength(0);
  });

  it('an approval for another plan, or another draft → refused', async () => {
    const { ctx, t } = await ctxAndDraft();
    const other = (await drafts())[1]!;
    await withOrg(ctx, async (tx) => {
      await audit(ctx, APPROVED, { targetType: 'etaText', targetId: t.id, data: { planId: '00000000-0000-4000-8000-000000000000', jobId: t.jobId, bodySha256: bodySha256(t.body) } }, tx);
      await audit(ctx, APPROVED, { targetType: 'etaText', targetId: other.id, data: { planId: t.planId, jobId: t.jobId, bodySha256: bodySha256(t.body) } }, tx);
    });
    await expect(send(t.id)).rejects.toThrow(/TR-06/);
    expect(await captured()).toHaveLength(0);
  });

  it('an "approval" by a technician → refused', async () => {
    const { t } = await ctxAndDraft();
    await db.auditEvent.createMany({ data: [{ orgId: w.orgId, actorUserId: w.tech, action: APPROVED, targetType: 'etaText', targetId: t.id, data: { planId: t.planId, jobId: t.jobId, bodySha256: bodySha256(t.body) } }] });
    await expect(send(t.id)).rejects.toThrow(/not approved by a dispatcher/);
    expect(await captured()).toHaveLength(0);
  });

  it('with a matching dispatcher approval it sends (negative control)', async () => {
    const { ctx, t } = await ctxAndDraft();
    await withOrg(ctx, async (tx) => {
      await audit(ctx, APPROVED, { targetType: 'etaText', targetId: t.id, data: { planId: t.planId, jobId: t.jobId, bodySha256: bodySha256(t.body) } }, tx);
      await sendApprovedEta(tx, ctx, t.id);
    });
    expect(await captured()).toHaveLength(1);
    await sweep();
  });
});

describe('TR-06: the database refuses a sent row without the approval event', () => {
  async function draft() {
    await as(w.admin, draftEtas, { date: w.seeded.date });
    return (await drafts())[0]!;
  }
  const sentFields = async (body = 'x') => ({ status: 'sent' as const, approvedById: w.admin, approvedAt: new Date(), sentAt: new Date(), capturedMessageId: (await db.capturedMessage.create({ data: { to: 'nobody', subject: 'test', body } })).id });

  it('no approval event → the update fails', async () => {
    const t = await draft();
    await expect(db.etaText.update({ where: { id: t.id }, data: await sentFields() })).rejects.toThrow(/TR-06: no dispatcher approval/);
    expect((await db.etaText.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('draft');
  });

  it('an approval for a different body → the update fails', async () => {
    const t = await draft();
    await db.auditEvent.createMany({ data: [{ orgId: w.orgId, actorUserId: w.admin, action: APPROVED, targetType: 'etaText', targetId: t.id, data: { planId: t.planId, bodySha256: bodySha256('something else') } }] });
    await expect(db.etaText.update({ where: { id: t.id }, data: await sentFields() })).rejects.toThrow(/TR-06/);
  });

  it('missing approver or captured message → the update fails', async () => {
    const t = await draft();
    await expect(db.etaText.update({ where: { id: t.id }, data: { ...(await sentFields()), capturedMessageId: null } })).rejects.toThrow(/TR-06/);
    await expect(db.etaText.update({ where: { id: t.id }, data: { ...(await sentFields()), approvedById: null } })).rejects.toThrow(/TR-06/);
  });

  it('inserting a row as sent without approval fails too', async () => {
    const t = await draft();
    await db.etaText.delete({ where: { id: t.id } }); // free the (plan, job) slot
    await expect(db.etaText.create({ data: { orgId: w.orgId, planId: t.planId, jobId: t.jobId, phone: '918-555-0100', body: 'x', source: 'template', ...(await sentFields()) } })).rejects.toThrow(/TR-06/);
  });

  it('a sent row never changes and never goes back to draft', async () => {
    const t = await draft();
    await as(w.admin, approveEtas, { ids: [t.id] });
    await expect(db.etaText.update({ where: { id: t.id }, data: { body: 'rewritten after sending' } })).rejects.toThrow(/never change/);
    await expect(db.etaText.update({ where: { id: t.id }, data: { status: 'draft' } })).rejects.toThrow(/never change/);
    await expect(db.etaText.update({ where: { id: t.id }, data: { phone: '918-555-0000' } })).rejects.toThrow(/never change/);
    await sweep();
  });

  it('with the matching approval event the database accepts it (negative control)', async () => {
    const t = await draft();
    await db.auditEvent.createMany({ data: [{ orgId: w.orgId, actorUserId: w.admin, action: APPROVED, targetType: 'etaText', targetId: t.id, data: { planId: t.planId, bodySha256: bodySha256(t.body) } }] });
    await db.etaText.update({ where: { id: t.id }, data: await sentFields() });
    expect((await db.etaText.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('sent');
  });
});
