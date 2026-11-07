import { AGENT_INTENTS, type AgentExtract, type AgentInput, type FbAgentProfile } from '@recycle-erp/shared';
import type { AgentLlm } from './types';

// Every request the agent sends a model is built here, and only from the
// conversation, the listing title, the profile's prompts and what the seller
// said they have. AgentInput.market, AgentInput.settings, the thread's offer
// and any ceiling never reach these functions' output (guard 1); the test
// serialises every request and looks for those numbers.

export type LlmRequest = Parameters<AgentLlm>[0];

const SELLER = 'user' as const;
const US = 'assistant' as const;

/** The conversation as chat turns: the seller is the user, we are the assistant. */
export function conversationTurns(input: AgentInput): LlmRequest['messages'] {
  const turns: LlmRequest['messages'] = [];
  for (const m of input.messages) {
    const photo = m.has_image ? ' [sent a photo]' : '';
    if (m.direction === 'out') turns.push({ role: US, content: m.body });
    else if (m.direction === 'in') turns.push({ role: SELLER, content: `${m.body}${photo}`.trim() || '[empty message]' });
    else turns.push({ role: SELLER, content: `[a message whose author is unclear] ${m.body}${photo}`.trim() });
  }
  // A chat model expects the conversation to end on the other side's turn.
  if (turns.length === 0 || turns[turns.length - 1]!.role !== SELLER) {
    turns.push({ role: SELLER, content: '[no new message from the seller]' });
  }
  return turns;
}

function listingLine(input: AgentInput): string {
  const t = input.thread.listing_title.trim();
  return t ? `The conversation started from our listing titled: ${t}` : '';
}

export const EXTRACT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'seller_ask_usd', 'intent', 'agreeing', 'confidence'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['part_number', 'description', 'qty'],
        properties: {
          part_number: { type: ['string', 'null'] },
          description: { type: 'string' },
          qty: { type: ['integer', 'null'] },
        },
      },
    },
    seller_ask_usd: { type: ['number', 'null'] },
    intent: { type: 'string', enum: [...AGENT_INTENTS] },
    agreeing: { type: 'boolean' },
    confidence: { type: 'number' },
  },
};

export function extractRequest(profile: FbAgentProfile, input: AgentInput): LlmRequest {
  return {
    model: profile.models.extract,
    system: [profile.prompts.extract, listingLine(input)].filter(Boolean).join('\n\n'),
    messages: conversationTurns(input),
    schema: EXTRACT_SCHEMA,
  };
}

export const REPLY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['reply'],
  properties: { reply: { type: 'string' } },
};

/** What the seller has, in words, without any price. */
function itemsLine(extract: AgentExtract): string {
  if (extract.items.length === 0) return 'The seller has not named any item yet.';
  const parts = extract.items.map((it) => {
    const pn = it.part_number ? `part number ${it.part_number}` : 'no part number given';
    const qty = it.qty === null ? 'quantity not given' : `quantity ${it.qty}`;
    return `${it.description || 'item'} (${pn}, ${qty})`;
  });
  return `What the seller has told us so far: ${parts.join('; ')}.`;
}

export function replyRequest(profile: FbAgentProfile, skill: string, input: AgentInput, extract: AgentExtract): LlmRequest {
  const instructions = profile.prompts.skills[skill] ?? '';
  return {
    model: profile.models.reply,
    system: [profile.prompts.system, listingLine(input), itemsLine(extract), instructions,
      'Answer with the JSON the schema asks for: the reply text only, one paragraph.'].filter(Boolean).join('\n\n'),
    messages: conversationTurns(input),
    schema: REPLY_SCHEMA,
  };
}

export const CHECK_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['commits', 'reason'],
  properties: { commits: { type: 'boolean' }, reason: { type: 'string' } },
};

/** Guard 4's second opinion: the extract model reads our draft on its own. */
export function commitCheckRequest(profile: FbAgentProfile, draft: string): LlmRequest {
  return {
    model: profile.models.extract,
    system: 'You check a message a buyer\'s automated assistant is about to send to a seller on Facebook Marketplace. '
      + 'Set commits to true if the message accepts a deal, confirms a sale, agrees to a price, promises payment, '
      + 'proposes or agrees to pickup, shipping, delivery, a meeting or an address, or claims to be a human. '
      + 'The placeholder {{offer}} stands for an amount and is allowed. Otherwise set commits to false. Give a short reason.',
    messages: [{ role: 'user', content: draft }],
    schema: CHECK_SCHEMA,
  };
}
