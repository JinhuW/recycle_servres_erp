-- 0121 moved the lines of POs archived before the cascade to 'Archived', but
-- left alone any line an open sell order still named, on the reasoning that
-- releasing it was the user's call. In practice those lines stayed at a stock
-- status on an archived PO: they kept showing in the inventory and the
-- sellable picker, and could be put on new sell orders. The call is now made:
-- release them the way the Archive button does (services/orderAdvance.ts,
-- archiveOrderLinesTx) — drop them from every open sell order with the same
-- line_removed audit row, reset that order's negotiated total, then archive.
--
-- One deviation from the runtime: the button refuses the whole archive when a
-- line is out on a pending transfer; this backfill skips just that line (as
-- 0121 + 0122 settled it) so the rest of the PO still leaves stock.
--
-- Idempotent: a second run finds no targets. 0121 stays as deployed.

WITH targets AS (
  SELECT ol.id, ol.order_id, ol.status AS old_status
  FROM order_lines ol
  JOIN orders o ON o.id = ol.order_id
  WHERE o.archived_at IS NOT NULL
    AND ol.status NOT IN ('Sold', 'Archived')
    AND NOT EXISTS (
      SELECT 1 FROM transfer_orders t
      WHERE t.id = ol.transfer_order_id AND t.status = 'Pending'
    )
),
claimed AS (
  SELECT sol.id AS sol_id, sol.sell_order_id, t.order_id,
         sol.inventory_id, sol.qty, sol.unit_price, sol.condition,
         sol.category, sol.label, sol.sub_label, sol.part_number, sol.warehouse_id
  FROM sell_order_lines sol
  JOIN sell_orders so ON so.id = sol.sell_order_id
  JOIN targets t ON t.id = sol.inventory_id
  WHERE so.status IN ('Draft', 'Shipped', 'Awaiting payment')
),
audited AS (
  INSERT INTO sell_order_events (sell_order_id, actor_id, kind, detail)
  SELECT c.sell_order_id, NULL, 'line_removed',
         jsonb_build_object(
           'snapshot', jsonb_build_object(
             'inventory_id', c.inventory_id, 'qty', c.qty,
             'unit_price', c.unit_price::float, 'condition', c.condition,
             'category', c.category, 'label', c.label, 'sub_label', c.sub_label,
             'part_number', c.part_number, 'warehouse_id', c.warehouse_id),
           'reason', 'po_archived',
           'orderId', c.order_id)
  FROM claimed c
),
removed AS (
  DELETE FROM sell_order_lines sol
  USING claimed c WHERE sol.id = c.sol_id
),
reset_totals AS (
  UPDATE sell_orders so
  SET pre_adjust_native_total = NULL, adjusted_at = NULL, adjusted_by = NULL,
      updated_at = NOW()
  WHERE so.id IN (SELECT DISTINCT sell_order_id FROM claimed)
),
upd AS (
  UPDATE order_lines ol SET status = 'Archived'
  FROM targets t WHERE ol.id = t.id
)
INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
SELECT t.id, NULL, 'status',
       jsonb_build_object('field', 'status', 'from', t.old_status, 'to', 'Archived')
FROM targets t;
