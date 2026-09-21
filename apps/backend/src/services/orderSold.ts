import type { SqlLike } from './orderAudit';

// The one place a PO becomes 'sold': a Done order with at least one line and
// no line that is not Sold. Called from every transaction that can make that
// true — a sell order reaching Done, a PO landing on Done, a line hand-set to
// Sold — and a no-op otherwise, so callers need not check first. Never set by
// hand. Archive is orthogonal: every caller already refuses an archived order,
// and a sale cannot consume an archived order's lines.
//
// One statement so the flip and its audit row cannot disagree. The row is
// stamped clock_timestamp() rather than the transaction's NOW(): the caller
// has usually just written the `advanced … → done` row in the same
// transaction, and two rows with an identical created_at sort by id.
export async function settleSoldTx(tx: SqlLike, orderId: string, actorId: string | null): Promise<boolean> {
  const rows = await tx`
    WITH flip AS (
      UPDATE orders o SET lifecycle = 'sold'
      WHERE o.id = ${orderId}
        AND o.lifecycle = 'done'
        AND EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id = o.id AND l.status <> 'Sold')
      RETURNING o.id
    )
    INSERT INTO order_events (order_id, actor_id, kind, detail, created_at)
    SELECT f.id, ${actorId}::uuid, 'advanced',
           '{"from":"done","to":"sold"}'::jsonb, clock_timestamp()
    FROM flip f
    RETURNING order_id
  ` as unknown as { order_id: string }[];
  return rows.length > 0;
}
