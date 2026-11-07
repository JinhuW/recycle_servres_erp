import type { AgentSkill } from '../types';
import { NO_PARAMS } from '../types';
import { replyRequest } from '../prompt';
import { replyText } from './reply';

const skill: AgentSkill = {
  kind: 'answer',
  label: 'Answer a question',
  params: NO_PARAMS,
  when({ extract }) {
    return extract.intent === 'question';
  },
  async reply(ctx, llm) {
    const text = await replyText(llm, replyRequest(ctx.profile, 'answer', ctx.input, ctx.extract));
    return { text, stage: ctx.input.thread.stage === 'new' ? 'screening' : ctx.input.thread.stage, wants_offer: false };
  },
};
export default skill;
