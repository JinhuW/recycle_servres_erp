import type { AgentRule } from '../types';
import { stringsParam } from '../types';

function escape(w: string): string {
  return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
}

const rule: AgentRule = {
  kind: 'logistics',
  label: 'Payment, shipping, pickup or address',
  params: {
    type: 'object',
    properties: { words: { type: 'array', label: 'Words that mean logistics', items: { type: 'string' }, default: [] } },
  },
  check({ extract, latest, params }) {
    if (extract.intent === 'logistics') return { fire: true, reason: 'The seller is asking about payment, shipping or pickup.' };
    const text = latest?.body ?? '';
    for (const w of stringsParam(params, 'words')) {
      if (!w.trim()) continue;
      if (new RegExp(`\\b${escape(w.trim())}\\b`, 'i').test(text)) {
        return { fire: true, reason: `The seller mentioned "${w.trim()}".` };
      }
    }
    return { fire: false };
  },
};
export default rule;
