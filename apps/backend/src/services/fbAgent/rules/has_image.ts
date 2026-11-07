import type { AgentRule } from '../types';
import { NO_PARAMS } from '../types';

// The agent reads text only; a photo needs a person's eyes.
const rule: AgentRule = {
  kind: 'has_image',
  label: 'The seller sent a photo',
  params: NO_PARAMS,
  check({ latest }) {
    return latest?.has_image ? { fire: true, reason: 'The seller sent a photo.' } : { fire: false };
  },
};
export default rule;
