import type { AgentRule } from '../types';
import { NO_PARAMS } from '../types';

// The worker could not tell who wrote a message, so the agent cannot be sure
// whose words it would be answering.
const rule: AgentRule = {
  kind: 'unknown_direction',
  label: 'A message of unknown author',
  params: NO_PARAMS,
  check({ input }) {
    return input.messages.some((m) => m.direction === 'unknown')
      ? { fire: true, reason: 'The conversation has a message we cannot attribute to either side.' }
      : { fire: false };
  },
};
export default rule;
