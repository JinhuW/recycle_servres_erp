-- Item labels: the type classifier for `Other` order lines, which until now
-- carried nothing but a free-text description.
-- See docs/superpowers/specs/2026-08-03-other-item-labels-design.md

CREATE TABLE IF NOT EXISTS item_labels (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive identity: "PSU" and "psu" are the same label, so the
-- inline-create path can dedupe instead of growing near-duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS item_labels_name_key ON item_labels (lower(name));
CREATE INDEX IF NOT EXISTS item_labels_created_by_idx ON item_labels (created_by);

-- The name verbatim, not an FK: every other spec column on order_lines
-- (brand, capacity, classification) is stored this way, so exports, inventory
-- and the audit snapshot read it without a join. Rename propagates here in the
-- same transaction that renames the label row.
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS item_label TEXT;
CREATE INDEX IF NOT EXISTS order_lines_item_label_idx ON order_lines (item_label);

INSERT INTO item_labels (name) VALUES
  ('CPU'), ('GPU'), ('Motherboard'), ('PSU'), ('Heatsink'), ('NIC'),
  ('RAID controller'), ('Riser card'), ('Backplane'), ('Chassis'),
  ('Fan'), ('Cable')
ON CONFLICT DO NOTHING;
