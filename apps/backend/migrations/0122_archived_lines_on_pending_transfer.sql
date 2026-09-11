-- 0121 moved the lines of already-archived POs to 'Archived', excluding only
-- Sold lines and lines an open sell order names. It did not exclude a line out
-- on a pending transfer order, which the runtime archive refuses for a reason:
-- receive looks for the line at 'In Transit', so once it sits at 'Archived'
-- receive marks the transfer Received having moved nothing, and both discard
-- (wants 'In Transit') and reopen (wants 'Done') refuse it forever.
--
-- Put those lines back at 'In Transit' — the only status the transfer guard
-- lets such a line hold — with the audit row the return would have written.
-- 0121 stays as deployed; this is the repair on top of it.

WITH targets AS (
  SELECT ol.id
  FROM order_lines ol
  JOIN transfer_orders t ON t.id = ol.transfer_order_id
  WHERE ol.status = 'Archived'
    AND t.status = 'Pending'
),
upd AS (
  UPDATE order_lines ol SET status = 'In Transit'
  FROM targets t WHERE ol.id = t.id
)
INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
SELECT t.id, NULL, 'status',
       jsonb_build_object('field', 'status', 'from', 'Archived', 'to', 'In Transit')
FROM targets t;
