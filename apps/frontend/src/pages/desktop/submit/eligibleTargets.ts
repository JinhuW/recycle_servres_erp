import type { Category, OrderSummary } from '../../../lib/types';

// Draft POs the current purchaser may append the in-progress submit lines to:
// their own, same category, and never the throwaway draft this submit session
// created on mount (passed as excludeId).
export function eligibleDraftTargets(
  orders: ReadonlyArray<OrderSummary>,
  opts: { category: Category; meId: string | undefined; excludeId: string | null },
): OrderSummary[] {
  const { category, meId, excludeId } = opts;
  if (!meId) return [];
  return orders.filter(o =>
    o.lifecycle === 'draft' &&
    o.category === category &&
    o.userId === meId &&
    o.id !== excludeId,
  );
}
