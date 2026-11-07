import type { AgentIntent } from '@recycle-erp/shared';
import type { AgentLlm } from './types';

// The agent's model without a key, for dev and local end-to-end walks: the same
// role the stub OCR plays for label scans. Production refuses to boot without
// OPENROUTER_API_KEY, so this never answers a real seller. It reads the
// conversation with a few regexes and answers each of the three request shapes
// (extract, reply, commit check) the way a careful model would, so a walk can
// reach screening, an offer, a counter and a hand-off. Deterministic.

const PART_RE = /\b[A-Za-z0-9][A-Za-z0-9-]{4,}\b/g;
const SIZE_RE = /^\d+(?:gb|tb|mb|mhz|x|pcs)$/i;
/** A part number has a few digits; a server model ("R650s") does not count. */
const looksLikePart = (tok: string) => /[A-Za-z]/.test(tok) && (tok.match(/\d/g)?.length ?? 0) >= 4 && !SIZE_RE.test(tok);
const QTY_RES = [/\b(\d{1,4})\s*(?:x\b|pcs\b|pieces\b|sticks\b|units\b|drives\b|of them\b)/i, /\bx\s*(\d{1,4})\b/i, /\b(?:qty|quantity)\s*:?\s*(\d{1,4})\b/i];
const ASK_RE = /\$\s?(\d[\d,]*(?:\.\d+)?)|\b(\d[\d,]*)\s*(?:dollars|usd|bucks)\b/i;
const HARDWARE_RE = /\b(ram|memory|dimms?|server|drives?|ssds?|cpus?|processors?)\b/i;

const sellerTurns = (messages: { role: string; content: string }[]) =>
  messages.filter((m) => m.role === 'user' && !m.content.startsWith('[no new message')).map((m) => m.content);

function itemsIn(texts: string[]) {
  const items: { part_number: string | null; description: string; qty: number | null }[] = [];
  let qty: number | null = null;
  let hardware: string | null = null;
  for (const t of texts) {
    for (const m of t.matchAll(PART_RE)) {
      const tok = m[0];
      if (!looksLikePart(tok)) continue;
      if (!items.some((i) => i.part_number === tok)) items.push({ part_number: tok, description: 'item', qty: null });
    }
    for (const re of QTY_RES) {
      const q = t.match(re);
      if (q) { qty = Number(q[1]); break; }
    }
    hardware ??= t.match(HARDWARE_RE)?.[0] ?? null;
  }
  for (const it of items) it.qty = qty;
  if (items.length === 0 && hardware) items.push({ part_number: null, description: hardware, qty });
  return items;
}

function askIn(text: string): number | null {
  const m = text.match(ASK_RE);
  if (!m) return null;
  const n = Number((m[1] ?? m[2])!.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function intentOf(text: string, ask: number | null, weSpoke: boolean, hasItems: boolean): AgentIntent {
  if (/\b(bot|robot|real person|human|automated|chatgpt)\b/i.test(text) && text.includes('?')) return 'bot_question';
  if (/\b(scam\w*|lowball\w*|kidding me|wasting my time|idiot|screw you)\b/i.test(text)) return 'hostile';
  if (/\b(deal|sounds good|agreed|i accept|let'?s do it)\b/i.test(text)) return 'agree';
  if (/\b(pick ?up|ship|shipping|address|venmo|zelle|paypal)\b/i.test(text)) return 'logistics';
  if (/\b(no thanks|not interested|never ?mind)\b/i.test(text)) return 'decline';
  if (ask !== null && weSpoke) return 'counter';
  if (hasItems && !text.trim().endsWith('?')) return 'offer_items';
  if (text.trim().endsWith('?')) return 'question';
  return hasItems ? 'offer_items' : 'other';
}

export const stubAgentLlm: AgentLlm = async (req) => {
  const usage = { model: `stub:${req.model}`, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 };
  const required = (req.schema.required as string[] | undefined) ?? [];
  if (required.includes('commits')) return { json: { commits: false, reason: 'local stub: no commitment found' }, usage };

  const texts = sellerTurns(req.messages);
  const latest = texts[texts.length - 1] ?? '';
  if (required.includes('intent')) {
    const items = itemsIn(texts);
    const ask = askIn(latest);
    const intent = intentOf(latest, ask, req.messages.some((m) => m.role === 'assistant'), items.length > 0);
    // Nothing concrete to read (no item, no price, no question): the stub is unsure, as a model would be.
    const vague = intent === 'other' && ask === null;
    return { json: { items, seller_ask_usd: ask, intent, agreeing: intent === 'agree', confidence: vague ? 0.3 : 0.9 }, usage };
  }

  // A reply. The system prompt says what the seller has told us (prompt.ts's itemsLine).
  const complete = /What the seller has told us so far/.test(req.system) && !/not given/.test(req.system);
  const reply = latest.trim().endsWith('?') && !askIn(latest)
    ? 'We buy used server parts, mostly memory, drives and CPUs. Which part numbers do you have, and how many of each?'
    : complete
      ? 'Thanks for the details. For those we can offer {{offer}}.'
      : 'Thanks for reaching out! What are the exact part numbers, and how many of each do you have?';
  return { json: { reply }, usage };
};
