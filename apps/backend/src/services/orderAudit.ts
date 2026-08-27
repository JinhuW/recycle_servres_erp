// PO audit-log helpers — used by routes/orders.ts to record activity from the
// moment an order is created. Lives outside the routes file so the diffing
// logic is reusable from scripts/tests and the call sites in the PATCH /
// advance handlers stay readable.
//
// All writes go through `writeOrderEvent` and assume they are running inside
// the caller's transaction, so an audit row is committed only if the change
// it describes is also committed.

import type { Sql, TransactionSql } from 'postgres';

export { diff, type AuditChange } from './auditDiff';

export type SqlLike = Sql | TransactionSql;

export type EventKind =
  | 'created'
  | 'submitted'
  | 'advanced'
  // A purchaser edited the order after submitting it, sending it back to
  // Draft. Carries the whole change set so the manager review dialog can
  // render it from one row.
  | 'reverted'
  | 'revert_ack'
  | 'line_added'
  | 'line_removed'
  | 'line_edited'
  | 'meta_changed'
  | 'owner_changed'
  | 'status_meta_changed'
  | 'line_photo_added'
  | 'line_photo_removed'
  | 'archived'
  | 'unarchived'
  | 'shipment_created'
  | 'shipment_purchased'
  | 'shipment_voided'
  | 'shipment_seller_filled';

// Order-level fields whose mutation we surface as `meta_changed`. These are
// exactly the fields PATCH /api/orders/:id may touch on the orders row.
export const META_FIELDS = [
  'notes',
  'warehouse_id',
  'payment',
  'total_cost',
  'commission_rate',
  'other_fees',
  'other_fees_note',
  'paypal_txn_id',
] as const;

// Line-level fields PATCH may update. Excludes ids/positions/scan refs and the
// status column (which is driven by advance events, not free edits) — every
// other column PATCH can write is listed here, so no edit goes unrecorded.
//
// `category` is deliberately here and deliberately absent from META_FIELDS: a
// line moving between categories is a real edit worth recording, while the
// order's own category is derived from its lines and would otherwise emit a
// meta_changed on every add and remove.
export const LINE_FIELDS = [
  'category',
  'sell_price',
  'qty',
  'unit_cost',
  'brand',
  'capacity',
  'type',
  'generation',
  'classification',
  'rank',
  'speed',
  'interface',
  'form_factor',
  'description',
  'item_type',
  'part_number',
  'serial_number',
  'chip_number',
  'condition',
  'health',
  'rpm',
] as const;

export async function writeOrderEvent(
  tx: SqlLike,
  orderId: string,
  actorId: string | null,
  kind: EventKind,
  detail: Record<string, unknown>,
): Promise<void> {
  // postgres.js' .json() is strict about its argument type. The detail blobs
  // we build are guaranteed to be JSON-safe (strings, numbers, nulls, plain
  // arrays/objects) — cast through `never` to satisfy the JSONValue contract.
  await tx`
    INSERT INTO order_events (order_id, actor_id, kind, detail)
    VALUES (${orderId}, ${actorId}, ${kind}, ${tx.json(detail as never)})
  `;
}
