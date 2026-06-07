// SO audit-log helpers — parallel to services/orderAudit.ts (PO) but scoped to
// sell_orders + sell_order_events. PO and SO timelines are independent.
//
// All writes assume they are running inside the caller's transaction, so an
// audit row is committed only if the change it describes is also committed.

import type { Sql, TransactionSql } from 'postgres';
export { diff, type AuditChange } from './auditDiff';

export type SqlLike = Sql | TransactionSql;

export type SellOrderEventKind =
  | 'created'
  | 'status_changed'
  | 'line_added'
  | 'line_removed'
  | 'line_edited'
  | 'meta_changed'
  | 'status_meta_changed'
  | 'archived'
  | 'unarchived'
  | 'closed'
  | 'reopened';

// Header fields PATCH /api/sell-orders/:id may touch on the sell_orders row.
// Status is intentionally excluded — it moves through POST /:id/status which
// emits its own status_changed / closed / reopened event.
export const META_FIELDS_SO = [
  'notes',
  'customer_id',
  'currency_code',
] as const;
export type MetaFieldSO = typeof META_FIELDS_SO[number];

// Per-line fields whose change we surface as line_edited. Excludes ids,
// position (reorder is not a meaningful event), and sell_order_id.
export const LINE_FIELDS_SO = [
  'qty',
  'unit_price',
  'condition',
  'category',
  'label',
  'sub_label',
  'part_number',
  'warehouse_id',
  'inventory_id',
] as const;
export type LineFieldSO = typeof LINE_FIELDS_SO[number];

export async function writeSellOrderEvent(
  tx: SqlLike,
  sellOrderId: string,
  actorId: string | null,
  kind: SellOrderEventKind,
  detail: Record<string, unknown>,
): Promise<void> {
  await tx`
    INSERT INTO sell_order_events (sell_order_id, actor_id, kind, detail)
    VALUES (${sellOrderId}, ${actorId}, ${kind}, ${tx.json(detail as never)})
  `;
}
