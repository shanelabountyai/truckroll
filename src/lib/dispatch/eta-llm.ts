import { BudgetExceeded, withBudget, type AiUsageReport } from '@/core/ai/budget';
import { costMicros } from '@/core/ai/prices';
import { log } from '@/core/log';
import { etaPrompt, etaTemplate, etaTextProblem, type EtaFacts } from './eta';

// PRD §3 "ETA texts": Claude drafts the text through the foundation's AI spend guard (withBudget, INV-39); the template
// is the fallback (D-06, D-50). The key is read here, not in core env.ts (template-owned), like SOLVER_URL (D-26).
// Logs never carry the text, the customer or the phone (INV-13 spirit).

export const ETA_PROVIDER = 'anthropic';
export const ETA_MODEL = 'claude-haiku-5-5'; // priced in src/core/ai/prices.ts
export const ETA_MAX_TOKENS = 200;
export const ETA_FEATURE = 'truckroll.eta';

export type EtaModelRequest = { system: string; user: string; maxTokens: number };
export type EtaModelReply = { text: string; usage: AiUsageReport };
/** One model call. Injected so tests never reach the network. */
export type EtaModel = (req: EtaModelRequest) => Promise<EtaModelReply>;

/** Claude over the Messages API with plain fetch (no SDK, like the foundation's Twilio and Resend calls). */
export function anthropicModel(apiKey: string, fetchImpl: typeof fetch = fetch): EtaModel {
  return async ({ system, user, maxTokens }) => {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: ETA_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`model call failed: ${res.status}`);
    const j = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    return { text, usage: { provider: ETA_PROVIDER, model: ETA_MODEL, inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 } };
  };
}

/** The configured model, or null (no key → the template, and no model call at all). */
export function etaModelFromEnv(env: Record<string, string | undefined> = process.env): EtaModel | null {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key ? anthropicModel(key) : null;
}

/**
 * withBudget's worst case for one draft: every UTF-8 byte of the prompt counted as a token (a token is at least one
 * byte), plus framing, plus the full `max_tokens` of output. An over-estimate only makes the cap refuse sooner.
 */
export function etaMaxCostMicros(req: EtaModelRequest): bigint {
  const inputBound = Buffer.byteLength(req.system, 'utf8') + Buffer.byteLength(req.user, 'utf8') + 64;
  return costMicros(ETA_PROVIDER, ETA_MODEL, inputBound, req.maxTokens);
}

export type EtaDraft = { body: string; source: 'llm' | 'template'; fallbackReason: string | null };

/**
 * One ETA draft. With a model: the call runs under withBudget (feature `truckroll.eta`), and its text is used only if
 * it passes etaTextProblem (D-51). A refused call (AI off, paused, over the cap), a failed call or a rejected text all
 * fall back to the template, with the reason kept for the dispatcher. Never throws for a model problem.
 */
export async function draftEta(ctx: { orgId: string; userId: string }, f: EtaFacts, model: EtaModel | null): Promise<EtaDraft> {
  if (!model) return { body: etaTemplate(f), source: 'template', fallbackReason: null };
  const req: EtaModelRequest = { ...etaPrompt(f), maxTokens: ETA_MAX_TOKENS };
  let reply: EtaModelReply;
  try {
    reply = await withBudget(ctx, ETA_FEATURE, etaMaxCostMicros(req), () => model(req));
  } catch (e) {
    if (e instanceof BudgetExceeded) return { body: etaTemplate(f), source: 'template', fallbackReason: e.message };
    log('truckroll.eta.model_failed', { orgId: ctx.orgId, error: e instanceof Error ? e.name : 'unknown' });
    return { body: etaTemplate(f), source: 'template', fallbackReason: 'The AI model could not be reached.' };
  }
  const text = reply.text.trim();
  const problem = etaTextProblem(text, f);
  if (problem) return { body: etaTemplate(f), source: 'template', fallbackReason: `The AI draft was not used: ${problem}.` };
  return { body: text, source: 'llm', fallbackReason: null };
}
