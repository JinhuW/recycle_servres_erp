// Sell-order close reasons. The id list is the shared single source of truth
// (@recycle-erp/shared, also used by the backend validator and mirrored by the
// SQL CHECK on sell_orders.close_reason_id). Labels render through useT() with
// the soCloseReason_<id> key, so the picker translates with the rest of the UI
// rather than serving English-only strings from the DB.
export { CLOSE_REASON_IDS } from '@recycle-erp/shared';
export type { CloseReasonId } from '@recycle-erp/shared';

export function closeReasonLabelKey(id: string): string {
  return `soCloseReason_${id}`;
}
