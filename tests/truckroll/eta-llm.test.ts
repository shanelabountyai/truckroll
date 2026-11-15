import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { draftEtas } from '@/app/o/[org]/dispatch/actions';
import { setPaused } from '@/core/ai/budget';
import { costMicros } from '@/core/ai/prices';
import { dbSystem as db } from '@/core/db/system';
import { etaPrompt, type EtaFacts } from '@/lib/dispatch/eta';
import { anthropicModel, ETA_FEATURE, ETA_MAX_TOKENS, ETA_MODEL, etaMaxCostMicros, etaModelFromEnv, type EtaModel } from '@/lib/dispatch/eta-llm';
import { draftEtaTexts } from '@/lib/dispatch/eta-store';
import { resetAuthTables, signInAs } from '../helpers/auth';
import { NavSignal } from '../helpers/next';
import { actAs } from '../helpers/org';
import { etaWorld, type EtaWorld } from './eta-setup';

// Phase 4: ETA drafts by Claude through withBudget (PRD §3, D-06, D-50, D-51). The model is a stub: no test reaches the
// network. Drafts from the model still need a dispatcher's approval to be sent (TR-06, covered in tr-06-eta-approval).

let w: EtaWorld;
beforeEach(async () => {
  await resetAuthTables();
  w = await etaWorld();
  await db.aiBudget.create({ data: { orgId: w.orgId, monthlyCapMicros: 25_000_000n } });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
});

const STOPS = 24;
const usage = { provider: 'anthropic', model: ETA_MODEL, inputTokens: 180, outputTokens: 60 };
/** A model that writes a valid text from the facts it was given (it reads the prompt's JSON, like Claude would). */
const goodModel: EtaModel = async ({ user }) => {
  const f = JSON.parse(user) as { technician: string; arrivalFrom: string; arrivalTo?: string; customer: string };
  return { text: `Hi ${f.customer}, ${f.technician} will arrive ${f.arrivalTo ? `between ${f.arrivalFrom} and ${f.arrivalTo}` : `at about ${f.arrivalFrom}`}. Thanks!`, usage };
};

const draftsNow = () => db.etaText.findMany({ where: { orgId: w.orgId, status: 'draft' } });

describe('drafting with a model', () => {
  it('a valid model text becomes the draft; each call is one AiUsage row under feature truckroll.eta', async () => {
    const ctx = await actAs(w.admin, w.slug);
    const model = vi.fn(goodModel);
    expect(await draftEtaTexts(ctx, w.seeded.date, model)).toEqual({ drafted: STOPS, llm: STOPS, template: 0, skipped: 0 });
    expect(model).toHaveBeenCalledTimes(STOPS);
    expect(model.mock.calls[0]![0].maxTokens).toBe(ETA_MAX_TOKENS);
    const d = await draftsNow();
    expect(d.every((t) => t.source === 'llm' && t.fallbackReason === null && t.body.includes('will arrive'))).toBe(true);
    const rows = await db.aiUsage.findMany({ where: { orgId: w.orgId } });
    expect(rows).toHaveLength(STOPS);
    expect(rows.every((r) => r.feature === ETA_FEATURE && r.model === ETA_MODEL && r.actorId === w.admin)).toBe(true);
    expect(await db.capturedMessage.count()).toBe(0); // drafted, not sent
  });

  it('a text that fails the validator → the template, with the reason; the call is still paid for', async () => {
    const ctx = await actAs(w.admin, w.slug);
    const r = await draftEtaTexts(ctx, w.seeded.date, async () => ({ text: 'Your tech arrives soon! Details: https://example.test', usage }));
    expect(r).toMatchObject({ llm: 0, template: STOPS });
    const d = await draftsNow();
    expect(d.every((t) => t.source === 'template' && /AI draft was not used: contains a link/.test(t.fallbackReason ?? ''))).toBe(true);
    expect(await db.aiUsage.count({ where: { orgId: w.orgId } })).toBe(STOPS);
  });

  it('over the monthly cap → the template, the model is never called, no usage row', async () => {
    await db.aiBudget.update({ where: { orgId: w.orgId }, data: { monthlyCapMicros: 1n } });
    const ctx = await actAs(w.admin, w.slug);
    const model = vi.fn(goodModel);
    await draftEtaTexts(ctx, w.seeded.date, model);
    expect(model).not.toHaveBeenCalled();
    expect((await draftsNow()).every((t) => t.source === 'template' && /spending limit/.test(t.fallbackReason ?? ''))).toBe(true);
    expect(await db.aiUsage.count()).toBe(0);
  });

  it('AI paused for the org → the template, the model is never called', async () => {
    const owner = await actAs(w.admin, w.slug);
    await setPaused(owner, true);
    const model = vi.fn(goodModel);
    await draftEtaTexts(owner, w.seeded.date, model);
    expect(model).not.toHaveBeenCalled();
    expect((await draftsNow()).every((t) => /paused/.test(t.fallbackReason ?? ''))).toBe(true);
  });

  it('a failing model → the template, its hold released, no usage row', async () => {
    const ctx = await actAs(w.admin, w.slug);
    await draftEtaTexts(ctx, w.seeded.date, async () => {
      throw new Error('boom');
    });
    expect((await draftsNow()).every((t) => t.source === 'template' && /could not be reached/.test(t.fallbackReason ?? ''))).toBe(true);
    expect(await db.aiUsage.count()).toBe(0);
    expect(await db.aiHold.count()).toBe(0);
  });

  it('the worst-case estimate given to withBudget is never below the real cost', () => {
    const f: EtaFacts = { jobId: 'j', ref: 'J01', shop: 'Acme Heating', customer: 'Dana Ö’Brien', service: 'repair', tech: 'Muskogee One', dateLabel: 'Mon, Nov 16', from: 540, to: 600, fromLabel: '9:00 AM', toLabel: '10:00 AM', emergency: false };
    const req = { ...etaPrompt(f), maxTokens: ETA_MAX_TOKENS };
    const bound = etaMaxCostMicros(req);
    // A token is at least one byte, so the prompt's byte count bounds its tokens; output is capped at max_tokens.
    expect(bound).toBeGreaterThanOrEqual(costMicros('anthropic', ETA_MODEL, Buffer.byteLength(req.system + req.user), ETA_MAX_TOKENS));
  });
});

describe('the model transport and the key', () => {
  it('no ANTHROPIC_API_KEY → no model at all, and the draft action never calls fetch', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(etaModelFromEnv({})).toBeNull();
    expect(etaModelFromEnv({ ANTHROPIC_API_KEY: '  ' })).toBeNull();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await signInAs(w.admin, { mfa: true });
    await expect(draftEtas(w.slug, { date: w.seeded.date })).rejects.toBeInstanceOf(NavSignal);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await draftsNow()).every((t) => t.source === 'template' && t.fallbackReason === null)).toBe(true);
    expect(await db.aiUsage.count()).toBe(0);
  });

  it('with a key, the Messages API request is well-formed and its reply is parsed (fake fetch, no network)', async () => {
    const fake = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hello there.' }], usage: { input_tokens: 123, output_tokens: 7 } }), { status: 200 }),
    );
    const model = anthropicModel('test-key-not-real', fake as unknown as typeof fetch);
    const reply = await model({ system: 'sys', user: '{"a":1}', maxTokens: 50 });
    expect(reply).toEqual({ text: 'Hello there.', usage: { provider: 'anthropic', model: ETA_MODEL, inputTokens: 123, outputTokens: 7 } });
    const [url, init] = fake.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init!.headers as Record<string, string>)['x-api-key']).toBe('test-key-not-real');
    expect(JSON.parse(init!.body as string)).toEqual({ model: ETA_MODEL, max_tokens: 50, system: 'sys', messages: [{ role: 'user', content: '{"a":1}' }] });
  });

  it('an HTTP error from the API is a failed call (→ template upstream)', async () => {
    const model = anthropicModel('k', (async () => new Response('nope', { status: 529 })) as unknown as typeof fetch);
    await expect(model({ system: 's', user: 'u', maxTokens: 10 })).rejects.toThrow(/529/);
  });
});
