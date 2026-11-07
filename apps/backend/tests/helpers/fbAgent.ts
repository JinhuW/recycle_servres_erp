// Written fixtures for the seller agent's tests. No real seller conversation
// is in here: every message is made up.

import { canonicalPartNumber, type AgentExtract, type AgentInput, type FbAgentProfile } from '@recycle-erp/shared';
import { CHECK_SCHEMA, EXTRACT_SCHEMA, REPLY_SCHEMA, type LlmRequest } from '../../src/services/fbAgent/prompt';
import type { AgentLlm } from '../../src/services/fbAgent';
import { getTestDb } from './db';

export const PN = 'M393A4K40CB2-CTD';
// Distinctive on purpose: the prompt test looks for these digits.
export const MAX_BUY = 37.13;
export const QTY = 8;
export const CEILING = 297.04;          // 8 × 37.13
export const FIRST_OFFER = 208;         // round(297.04 × 0.70)
export const NOW = '2026-11-07T18:00:00.000Z';

export function agentInput(over: Partial<AgentInput> = {}): AgentInput {
  return {
    thread: { id: 1, stage: 'screening', round: 0, offer_usd: null, listing_title: 'We buy server memory' },
    messages: [
      { seq: 1, direction: 'in', author: 'seller', body: 'hey saw your post, I have some server ram', has_image: false },
      { seq: 2, direction: 'out', author: 'agent', body: 'Thanks for reaching out! What part numbers and how many?', has_image: false },
      { seq: 3, direction: 'in', author: 'seller', body: `${QTY} sticks of ${PN}, pulled from a working R740`, has_image: false },
    ],
    market: [{
      canon: canonicalPartNumber(PN), part_number: PN, label: 'Samsung 32GB DDR4 RDIMM',
      max_buy_unit: MAX_BUY, price_at: '2026-11-05T12:00:00.000Z',
    }],
    settings: { opening_pct: 70, step_pct: 10, max_rounds: 3, price_max_age_days: 30 },
    now: NOW,
    ...over,
  };
}

export function sellerSays(body: string, over: Partial<AgentInput> = {}): AgentInput {
  const base = agentInput(over);
  return { ...base, messages: [...base.messages, { seq: base.messages.length + 1, direction: 'in', author: 'seller', body, has_image: false }] };
}

export function extractOf(over: Partial<AgentExtract> = {}): AgentExtract {
  return {
    items: [{ part_number: PN, description: 'Samsung 32GB RDIMM', qty: QTY }],
    seller_ask_usd: null, intent: 'offer_items', agreeing: false, confidence: 0.9,
    ...over,
  };
}

export type Script = {
  extract?: AgentExtract | Record<string, unknown> | Error;
  reply?: string | Error;
  check?: { commits: boolean; reason: string } | Error;
};

/** A stub model: answers each request by its schema, and keeps every request it saw. */
export function scriptedLlm(script: Script = {}): AgentLlm & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  const fn = (async (req: LlmRequest) => {
    requests.push(req);
    const usage = { model: req.model, prompt_tokens: 100, completion_tokens: 20, cost_usd: 0.001 };
    const pick = req.schema === EXTRACT_SCHEMA ? script.extract ?? extractOf()
      : req.schema === REPLY_SCHEMA ? script.reply ?? 'Thanks! We can offer {{offer}} for all of them, based on current resale prices.'
        : req.schema === CHECK_SCHEMA ? script.check ?? { commits: false, reason: 'asks only' }
          : new Error('unknown schema');
    if (pick instanceof Error) throw pick;
    return { json: typeof pick === 'string' ? { reply: pick } : pick as Record<string, unknown>, usage };
  }) as AgentLlm & { requests: LlmRequest[] };
  fn.requests = requests;
  return fn;
}

export async function activeProfile(): Promise<FbAgentProfile> {
  const [p] = await getTestDb()<FbAgentProfile[]>`
    SELECT id::int AS id, name, version, state, prompts, skills, rules, models, notes
    FROM fb_agent_profiles WHERE state = 'active'`;
  return p!;
}
