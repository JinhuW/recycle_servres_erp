-- Item types: the classifier for `Other` order lines, which until now carried
-- nothing but a free-text description.
-- See docs/superpowers/specs/2026-08-03-other-item-types-design.md

CREATE TABLE IF NOT EXISTS item_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive identity: "PSU" and "psu" are the same type, so the
-- inline-create path can dedupe instead of growing near-duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS item_types_name_key ON item_types (lower(name));
CREATE INDEX IF NOT EXISTS item_types_created_by_idx ON item_types (created_by);

-- Distinct from the existing `type` column, which holds the RAM device type
-- (RDIMM/UDIMM) and applies only to that category.
--
-- The name verbatim, not an FK: every other spec column on order_lines
-- (brand, capacity, classification) is stored this way, so exports, inventory
-- and the audit snapshot read it without a join. Rename propagates here in the
-- same transaction that renames the type row.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS item_type TEXT;
CREATE INDEX IF NOT EXISTS order_lines_item_type_idx ON order_lines (item_type);

INSERT INTO item_types (name) VALUES
  ('CPU'), ('GPU'), ('Motherboard'), ('PSU'), ('Heatsink'), ('NIC'),
  ('RAID controller'), ('Riser card'), ('Backplane'), ('Chassis'),
  ('Fan'), ('Cable')
ON CONFLICT DO NOTHING;
