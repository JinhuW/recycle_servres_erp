-- Purchase orders were historically allocated as `SO-####`, an artifact from
-- before sell-orders existed as a separate concept. The prefix is now
-- misleading (purchasers create *purchase* orders) so rename every existing
-- orders.id from `SO-` to `PO-` and migrate the id_counters row alongside.
--
-- Children that reference orders(id) carry the same prefix in TEXT columns
-- (order_lines.order_id, order_events.order_id) so they're updated in lock-step
-- here, with the FKs temporarily dropped to allow the parent UPDATE.
--
-- order_events has an append-only BEFORE UPDATE trigger (0037 + 0038) that
-- raises on any UPDATE. DISABLE TRIGGER USER turns off user-defined triggers
-- for the table without touching the FK-enforcement system triggers; the
-- explicit ENABLE at the end restores the lock.
--
-- Idempotent: every UPDATE is qualified with `LIKE 'SO-%'`, so re-running on
-- an already-migrated database is a no-op. The id_counters rename is also
-- guarded against double-application by name.

ALTER TABLE order_lines DROP CONSTRAINT IF EXISTS order_lines_order_id_fkey;
ALTER TABLE order_events DROP CONSTRAINT IF EXISTS order_events_order_id_fkey;
ALTER TABLE order_events DISABLE TRIGGER USER;

UPDATE orders        SET id       = 'PO-' || SUBSTRING(id FROM 4)
  WHERE id       LIKE 'SO-%';
UPDATE order_lines   SET order_id = 'PO-' || SUBSTRING(order_id FROM 4)
  WHERE order_id LIKE 'SO-%';
UPDATE order_events  SET order_id = 'PO-' || SUBSTRING(order_id FROM 4)
  WHERE order_id LIKE 'SO-%';

ALTER TABLE order_events ENABLE TRIGGER USER;
ALTER TABLE order_lines  ADD CONSTRAINT order_lines_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
ALTER TABLE order_events ADD CONSTRAINT order_events_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;

-- Rename the counter row. If a fresh deployment never had an SO row this is
-- a no-op; if both happen to exist (impossible in practice) the PK conflict
-- would surface here, which is the desired loud failure.
UPDATE id_counters SET name = 'PO' WHERE name = 'SO';
