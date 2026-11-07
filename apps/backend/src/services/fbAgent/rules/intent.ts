import { AGENT_INTENTS } from '@recycle-erp/shared';
import type { AgentRule } from '../types';
import { stringsParam } from '../types';

const rule: AgentRule = {
  kind: 'intent',
  label: 'The seller\'s message is of a kind a person answers',
  params: {
    type: 'object',
    properties: { kinds: { type: 'array', label: 'Intents to hand off', items: { type: 'string', enum: [...AGENT_INTENTS] }, default: ['hostile', 'off_topic'] } },
    required: ['kinds'],
  },
  check({ extract, params }) {
    return stringsParam(params, 'kinds').includes(extract.intent)
      ? { fire: true, reason: `The seller's message reads as ${extract.intent.replace('_', ' ')}.` }
      : { fire: false };
  },
};
export default rule;
