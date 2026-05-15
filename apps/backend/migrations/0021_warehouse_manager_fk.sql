-- 0021_warehouse_manager_fk.sql
-- Replace the free-text warehouse manager fields with a foreign key to the
-- user who manages the warehouse. Manager name / phone / email are now derived
-- from the linked users row (single source of truth) instead of being typed in
-- per warehouse. Existing free-text manager strings are intentionally dropped
-- — they were never linked to real user records.

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS manager_user_id UUID REFERENCES users(id);

ALTER TABLE warehouses
  DROP COLUMN IF EXISTS manager,
  DROP COLUMN IF EXISTS manager_phone,
  DROP COLUMN IF EXISTS manager_email;
