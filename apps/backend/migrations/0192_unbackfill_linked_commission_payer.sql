-- 0189 named the screenshot's uploader as payer even where a live bank row is
-- linked as the commission, which the upload route deliberately leaves empty:
-- the link says the company paid, and unlinking it later would surface a
-- guessed manager. Those orders go back to nobody on file, with a backfilled
-- Activity line saying so, unless Paid by has been changed since.
WITH backfilled AS (
  SELECT e.order_id, e.actor_id, e.created_at
  FROM order_events e
  WHERE e.kind = 'meta_changed'
    AND (e.detail->>'backfilled')::boolean
    AND e.detail->'changes' @> '[{"field": "commission_paid_by"}]'
), cleared AS (
  UPDATE orders o
     SET commission_paid_by = NULL
    FROM backfilled b
   WHERE o.id = b.order_id
     AND o.commission_paid_by = b.actor_id
     AND NOT o.commission_paid_by_company
     AND EXISTS (
       SELECT 1 FROM bank_transactions bt
       WHERE bt.order_id = o.id AND bt.link_kind = 'commission'
         AND bt.settle_status <> 'failed' AND bt.settle_status <> 'reversed')
     AND NOT EXISTS (
       SELECT 1 FROM order_events later
       WHERE later.order_id = o.id AND later.created_at > b.created_at
         AND later.kind = 'meta_changed'
         AND later.detail->'changes' @> '[{"field": "commission_paid_by"}]')
  RETURNING o.id, b.actor_id
)
INSERT INTO order_events (order_id, actor_id, kind, detail)
SELECT c.id, c.actor_id, 'meta_changed',
       jsonb_build_object('backfilled', true, 'changes', jsonb_build_array(
         jsonb_build_object('field', 'commission_paid_by', 'from', u.name, 'to', NULL)))
FROM cleared c JOIN users u ON u.id = c.actor_id;
