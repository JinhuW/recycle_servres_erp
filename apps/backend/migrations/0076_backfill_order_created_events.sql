-- Orders created before the `created` audit event existed have no timeline
-- entry for their own creation, and drafts (which were never audited at all)
-- render a completely empty Activity panel. Synthesise the baseline row from
-- the orders/order_lines data we already have so every PO has a start.
--
-- created_at is set from orders.created_at, not NOW(), so the timeline stays
-- chronological. Guarded by NOT EXISTS so a re-run is a no-op.

INSERT INTO order_events (order_id, actor_id, kind, detail, created_at)
SELECT
  o.id,
  o.user_id,
  'created',
  jsonb_build_object(
    'category',  o.category,
    'lineCount', COALESCE(l.line_count, 0),
    'qty',       COALESCE(l.qty_total, 0),
    'totalCost', o.total_cost,
    'backfilled', true
  ),
  o.created_at
FROM orders o
LEFT JOIN (
  SELECT order_id, COUNT(*) AS line_count, SUM(qty) AS qty_total
  FROM order_lines GROUP BY order_id
) l ON l.order_id = o.id
WHERE NOT EXISTS (
  SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind = 'created'
);
