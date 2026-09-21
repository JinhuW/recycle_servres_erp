-- A Done PO whose every line has sold is now 'sold' (services/orderSold.ts
-- settles it the moment that becomes true: a sell order reaching Done, or the
-- PO landing on Done). Orders that reached that state before the rule existed
-- are flipped here, with the same audit row the live path writes so the
-- activity feed explains the change. Archive is orthogonal, so archived orders
-- flip too. Idempotent: a second run matches nothing.

WITH flip AS (
  UPDATE orders o SET lifecycle = 'sold'
  WHERE o.lifecycle = 'done'
    AND EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id = o.id)
    AND NOT EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id = o.id AND l.status <> 'Sold')
  RETURNING o.id
)
INSERT INTO order_events (order_id, actor_id, kind, detail)
SELECT f.id, NULL, 'advanced', '{"from":"done","to":"sold"}'::jsonb
FROM flip f;
