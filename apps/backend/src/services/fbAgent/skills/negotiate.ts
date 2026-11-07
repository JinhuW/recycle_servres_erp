import type { AgentSkill } from '../types';
import { NO_PARAMS } from '../types';
import { replyRequest } from '../prompt';
import { replyText } from './reply';

// Makes the next offer on the ladder; the amount is fbOffer's, filled in by code.
const skill: AgentSkill = {
  kind: 'negotiate',
  label: 'Negotiate: make our offer',
  params: NO_PARAMS,
  when({ extract, offer }) {
    return offer.ok && (extract.intent === 'offer_items' || extract.intent === 'counter');
  },
  async reply(ctx, llm) {
    const text = await replyText(llm, replyRequest(ctx.profile, 'negotiate', ctx.input, ctx.extract));
    return { text, stage: 'negotiating', wants_offer: true };
  },
};
export default skill;
