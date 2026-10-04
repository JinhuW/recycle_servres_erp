-- The manager of a PO: the manager who took it into review. Set by the move
-- into Reviewing (or later, for a PO that reaches it with none), and changed
-- only when another manager moving it chooses to take it over. Sticky across
-- a send-back to Draft, so a re-submission returns to the same manager.
--
-- IF NOT EXISTS and the `manager_id IS NULL` guard let a test replay the file.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS manager_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS orders_manager_id_idx ON orders(manager_id);

-- History holds who moved each PO into Reviewing; the latest such move names
-- its manager, if that user still is one. A manager's jump straight out of
-- Draft records a `submitted` event with no `to`, so those POs start empty
-- and fill in on their next manager move.
UPDATE orders o
SET manager_id = e.actor_id
FROM (
  SELECT DISTINCT ON (order_id) order_id, actor_id
  FROM order_events
  WHERE kind = 'advanced' AND detail->>'to' = 'reviewing' AND actor_id IS NOT NULL
  ORDER BY order_id, created_at DESC
) e
JOIN users u ON u.id = e.actor_id AND u.role = 'manager'
WHERE o.id = e.order_id AND o.manager_id IS NULL;
