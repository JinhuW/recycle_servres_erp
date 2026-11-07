import type { AgentRule } from '../types';
import { stringsParam } from '../types';

const rule: AgentRule = {
  kind: 'keyword',
  label: 'The seller\'s message matches a pattern',
  params: {
    type: 'object',
    properties: { patterns: { type: 'array', label: 'Regular expressions, case-insensitive', items: { type: 'string' }, default: [] } },
  },
  check({ latest, params }) {
    const text = latest?.body ?? '';
    for (const p of stringsParam(params, 'patterns')) {
      let re: RegExp;
      // A pattern that does not compile can only hand off: the manager meant to catch something.
      try { re = new RegExp(p, 'i'); } catch { return { fire: true, reason: `The pattern "${p}" is not a valid regular expression.` }; }
      if (re.test(text)) return { fire: true, reason: `The seller's message matches "${p}".` };
    }
    return { fire: false };
  },
};
export default rule;
