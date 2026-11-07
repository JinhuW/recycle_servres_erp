import type { AgentRule } from '../types';
import { NO_PARAMS } from '../types';

// The runtime sends the honest line (guards.ts) before the thread hands off.
const rule: AgentRule = {
  kind: 'bot_question',
  label: 'The seller asks if they are talking to a bot',
  params: NO_PARAMS,
  check({ extract }) {
    return extract.intent === 'bot_question'
      ? { fire: true, reason: 'The seller asked whether they are talking to a person.' }
      : { fire: false };
  },
};
export default rule;
