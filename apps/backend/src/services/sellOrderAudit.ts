// SO audit-log helpers — parallel to services/orderAudit.ts (PO) but
// scoped to sell_orders + sell_order_events. No cross-references; PO and
// SO timelines are independent.
//
// All writes assume they are running inside the caller's transaction, so
// an audit row is committed only if the change it describes is also
// committed.

import type { Sql, TransactionSql } from 'postgres';

export type SqlLike = Sql | TransactionSql;

export type SellOrderEventKind =
  | 'archived'
  | 'unarchived'
  | 'closed'
  | 'reopened';

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
