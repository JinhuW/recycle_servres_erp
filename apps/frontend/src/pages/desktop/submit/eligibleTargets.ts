import type { OrderSummary } from '../../../lib/types';

// Draft POs the current purchaser may append the in-progress submit lines to:
// their own, and never the throwaway draft this submit session created on mount
// (passed as excludeId).
//
// No category filter: a PO may hold lines of any mix, so there is nothing left
// for one to protect. It used to exist because appending an SSD line to a RAM
// order was rejected by the API.
export function eligibleDraftTargets(
  orders: ReadonlyArray<OrderSummary>,
  opts: { meId: string | undefined; excludeId: string | null },
): OrderSummary[] {
  const { meId, excludeId } = opts;
  if (!meId) return [];
  return orders.filter(o =>
    o.lifecycle === 'draft' &&
    o.userId === meId &&
    o.id !== excludeId,
  );
}
