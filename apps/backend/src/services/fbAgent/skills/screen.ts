import type { AgentSkill } from '../types';
import { NO_PARAMS } from '../types';
import { replyRequest } from '../prompt';
import { replyText } from './reply';

// Asks for what an offer needs: exact part numbers and quantities.
const skill: AgentSkill = {
  kind: 'screen',
  label: 'Screen: ask what they have',
  params: NO_PARAMS,
  when({ extract }) {
    if (extract.intent === 'decline' || extract.intent === 'question') return false;
    return extract.items.length === 0 || extract.items.some((it) => !it.part_number || it.qty === null);
  },
  async reply(ctx, llm) {
    const text = await replyText(llm, replyRequest(ctx.profile, 'screen', ctx.input, ctx.extract));
    return { text, stage: 'screening', wants_offer: false };
  },
};
export default skill;
