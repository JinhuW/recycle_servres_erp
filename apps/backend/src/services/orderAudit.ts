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
  | 'line_added'
  | 'line_removed'
  | 'line_edited'
  | 'meta_changed'
  | 'status_meta_changed'
  | 'archived'
  | 'unarchived';

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
] as const;

// Line-level fields PATCH may update. Excludes ids/positions/scan refs and the
// status column (which is driven by advance events, not free edits) — every
// other column PATCH can write is listed here, so no edit goes unrecorded.
export const LINE_FIELDS = [
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
