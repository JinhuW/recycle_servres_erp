-- 0097_user_default_warehouse.sql
-- Each user carries a home warehouse, editable from their profile. New POs
-- default to the owner's warehouse (the purchaser the order is for — not the
-- manager filing it) instead of whichever warehouse happens to sort first.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_warehouse_id TEXT
    REFERENCES warehouses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS users_default_warehouse_idx
  ON users(default_warehouse_id);
