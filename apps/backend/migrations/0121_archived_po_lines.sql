-- Archiving a PO now takes its goods out of stock by moving every non-Sold
-- line to 'Archived' (services/orderAdvance.ts, archiveOrderLinesTx). Orders
-- archived before that rule still hold their lines at a stock status, so the
-- inventory and sellable views keep counting goods the business no longer has.
--
-- Backfill those, with the same audit row per line the cascade writes, so a
-- later unarchive can put each line back. A line an open sell order still
-- names is left alone: releasing it is the user's call, which the archive
-- endpoint asks for — unarchive and re-archive the PO to get the prompt.

WITH targets AS (
  SELECT ol.id, ol.status AS old_status
  FROM order_lines ol
  JOIN orders o ON o.id = ol.order_id
  WHERE o.archived_at IS NOT NULL
    AND ol.status NOT IN ('Sold', 'Archived')
    AND NOT EXISTS (
      SELECT 1
      FROM sell_order_lines sol
      JOIN sell_orders so ON so.id = sol.sell_order_id
      WHERE sol.inventory_id = ol.id
        AND so.status IN ('Draft', 'Shipped', 'Awaiting payment')
    )
),
upd AS (
  UPDATE order_lines ol SET status = 'Archived'
  FROM targets t WHERE ol.id = t.id
)
INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
SELECT t.id, NULL, 'status',
       jsonb_build_object('field', 'status', 'from', t.old_status, 'to', 'Archived')
FROM targets t;
