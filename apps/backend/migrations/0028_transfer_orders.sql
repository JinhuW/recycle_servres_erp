-- 0028_transfer_orders.sql
-- First-class transfer orders. A transfer groups the moved lines under one
-- TO-<n> order with its own Pending → Received lifecycle. order_lines points
-- to the order it is *currently* moving under; durable history stays in
-- inventory_events. Greenfield — no backfill of pre-change transfers.

CREATE TABLE IF NOT EXISTS transfer_orders (
  id                 TEXT PRIMARY KEY,
  from_warehouse_id  TEXT REFERENCES warehouses(id),   -- NULL = mixed sources
  to_warehouse_id    TEXT NOT NULL REFERENCES warehouses(id),
  note               TEXT,
  created_by         UUID REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status             TEXT NOT NULL DEFAULT 'Pending',  -- Pending | Received
  received_at        TIMESTAMPTZ,
  received_by        UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS transfer_orders_status_idx
  ON transfer_orders(status, created_at DESC);

ALTER TABLE order_lines
  ADD COLUMN IF NOT EXISTS transfer_order_id TEXT REFERENCES transfer_orders(id);
CREATE INDEX IF NOT EXISTS order_lines_transfer_order_idx
  ON order_lines(transfer_order_id);
