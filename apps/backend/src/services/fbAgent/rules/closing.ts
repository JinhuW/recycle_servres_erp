import type { AgentRule } from '../types';
import { numParam } from '../types';

// A deal about to close is a person's call (owner, 2026-11-07): the seller
// agrees, the gap is small, or the next offer would be our last.
const rule: AgentRule = {
  kind: 'closing',
  label: 'Deal about to close',
  params: {
    type: 'object',
    properties: { gap_pct: { type: 'number', label: 'Gap between ask and offer (% of the ask)', minimum: 0, maximum: 100, default: 10 } },
    required: ['gap_pct'],
  },
  check({ input, extract, offer, params }) {
    if (extract.agreeing || extract.intent === 'agree') return { fire: true, reason: 'The seller is agreeing to a deal.' };
    const gapPct = numParam(params, 'gap_pct', 10);
    if (offer.ok && extract.seller_ask_usd !== null && extract.seller_ask_usd > 0) {
      const gap = (extract.seller_ask_usd - offer.offer_usd) / extract.seller_ask_usd * 100;
      if (gap <= gapPct) return { fire: true, reason: `The seller's ask is within ${gapPct}% of our next offer.` };
    }
    if (offer.round >= input.settings.max_rounds) {
      return { fire: true, reason: 'The next offer would be the last round.' };
    }
    return { fire: false };
  },
};
export default rule;
