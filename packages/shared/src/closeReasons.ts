// Fixed sell-order close-reason taxonomy — the single source of truth shared
// by the backend status validator (apps/backend/src/routes/sellOrders.ts) and
// the frontend picker (apps/frontend/src/lib/closeReasons.ts). The SQL CHECK
// constraint on sell_orders.close_reason_id must list the same values (it can't
// import TS); adding a reason means extending this array AND writing a new
// migration to widen the CHECK.
export const CLOSE_REASON_IDS = [
  'customer_cancelled', 'lost_deal', 'returned', 'duplicate', 'other',
] as const;
export type CloseReasonId = (typeof CLOSE_REASON_IDS)[number];
