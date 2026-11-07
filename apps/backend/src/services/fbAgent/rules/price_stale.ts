import type { AgentRule } from '../types';
import { NO_PARAMS } from '../types';
import { matchFor } from '../../../lib/fbOffer';

const DAY_MS = 86_400_000;

const rule: AgentRule = {
  kind: 'price_stale',
  label: 'Market price missing or old',
  params: NO_PARAMS,
  check({ input, extract }) {
    const now = Date.parse(input.now);
    const maxAge = input.settings.price_max_age_days;
    for (const it of extract.items) {
      const m = matchFor(input.market, it.part_number);
      if (!m) continue;
      if (m.max_buy_unit === null || m.price_at === null) {
        return { fire: true, reason: `${m.part_number} has no Market price.` };
      }
      const days = Math.floor((now - Date.parse(m.price_at)) / DAY_MS);
      if (days > maxAge) return { fire: true, reason: `${m.part_number}'s Market price is ${days} days old.` };
    }
    return { fire: false };
  },
};
export default rule;
