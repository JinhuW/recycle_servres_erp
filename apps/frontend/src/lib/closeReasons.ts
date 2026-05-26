// Closed set of sell-order close reasons. Mirrors the CHECK constraint on
// sell_orders.close_reason_id (backend migration 0056) and the validator in
// apps/backend/src/routes/sellOrders.ts. Labels render through useT() with
// the soCloseReason_<id> key, so the picker translates with the rest of the
// UI rather than serving English-only strings from the DB.

export const CLOSE_REASON_IDS = [
  'customer_cancelled', 'lost_deal', 'returned', 'duplicate', 'other',
] as const;
export type CloseReasonId = typeof CLOSE_REASON_IDS[number];

export function closeReasonLabelKey(id: string): string {
  return `soCloseReason_${id}`;
}
