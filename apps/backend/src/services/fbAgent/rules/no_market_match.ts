import type { AgentRule } from '../types';
import { NO_PARAMS } from '../types';
import { matchFor } from '../../../lib/fbOffer';

const rule: AgentRule = {
  kind: 'no_market_match',
  label: 'Item not on the Market board',
  params: NO_PARAMS,
  check({ input, extract }) {
    for (const it of extract.items) {
      if (!it.part_number) continue;
      if (!matchFor(input.market, it.part_number)) {
        return { fire: true, reason: `${it.part_number} has no exact match on the Market board.` };
      }
    }
    return { fire: false };
  },
};
export default rule;
