import type { AgentRule } from '../types';
import { numParam } from '../types';

const rule: AgentRule = {
  kind: 'confidence_below',
  label: 'The agent is unsure what the seller means',
  params: {
    type: 'object',
    properties: { min: { type: 'number', label: 'Lowest confidence the agent acts on (0 to 1)', minimum: 0, maximum: 1, default: 0.6 } },
  },
  check({ extract, params }) {
    const min = numParam(params, 'min', 0.6);
    return extract.confidence < min
      ? { fire: true, reason: `The agent read the seller with confidence ${extract.confidence.toFixed(2)}, below ${min}.` }
      : { fire: false };
  },
};
export default rule;
