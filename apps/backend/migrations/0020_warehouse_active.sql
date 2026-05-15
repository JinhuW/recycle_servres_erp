-- 0020_warehouse_active.sql
-- Soft-archive flag for warehouses. active = FALSE hides the warehouse from
-- every UI surface (inventory filter, submit/transfer/order pickers, and the
-- Settings list) while keeping the row + its FK references intact. There is no
-- in-app un-archive path by design; reactivation is a direct DB edit.

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
