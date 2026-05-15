-- 0022_warehouse_drop_cutoff_sqft.sql
-- Remove the warehouse "receiving cutoff" and "floor area" attributes. They
-- are no longer surfaced or edited anywhere in the product. Any stored values
-- are intentionally discarded.

ALTER TABLE warehouses
  DROP COLUMN IF EXISTS cutoff_local,
  DROP COLUMN IF EXISTS sqft;
