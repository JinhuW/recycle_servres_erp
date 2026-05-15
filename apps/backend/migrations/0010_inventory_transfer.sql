-- 0010_inventory_transfer.sql
-- Per-line warehouse override so a manager can transfer inventory between
-- warehouses without rewriting the parent order. NULL = inherit from
-- orders.warehouse_id (existing behaviour). A non-NULL value overrides.

ALTER TABLE order_lines
  ADD COLUMN IF NOT EXISTS warehouse_id TEXT REFERENCES warehouses(id);

CREATE INDEX IF NOT EXISTS order_lines_warehouse_idx ON order_lines(warehouse_id);
