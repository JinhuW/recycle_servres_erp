-- Disk health % field and HDD as a sibling category to RAM/SSD/Other.
-- See docs/superpowers/specs/2026-05-12-disk-health-and-hdd-category-design.md

ALTER TABLE order_lines
  ADD COLUMN IF NOT EXISTS health NUMERIC(4,1)
    CHECK (health IS NULL OR (health >= 0 AND health <= 100)),
  ADD COLUMN IF NOT EXISTS rpm    SMALLINT
    CHECK (rpm IS NULL OR rpm > 0);

ALTER TABLE ref_prices
  ADD COLUMN IF NOT EXISTS health NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS rpm    SMALLINT;

-- HDD-specific catalog dropdowns. SSD groups stay untouched.
INSERT INTO catalog_options ("group", value, position) VALUES
  ('HDD_BRAND',     'Seagate',   0),
  ('HDD_BRAND',     'WD',        1),
  ('HDD_BRAND',     'Toshiba',   2),
  ('HDD_BRAND',     'HGST',      3),
  ('HDD_INTERFACE', 'SATA',      0),
  ('HDD_INTERFACE', 'SAS',       1),
  ('HDD_FORM',      '2.5"',      0),
  ('HDD_FORM',      '3.5"',      1),
  ('HDD_CAP',       '500GB',     0),
  ('HDD_CAP',       '1TB',       1),
  ('HDD_CAP',       '2TB',       2),
  ('HDD_CAP',       '4TB',       3),
  ('HDD_CAP',       '8TB',       4),
  ('HDD_CAP',       '16TB',      5),
  ('HDD_RPM',       '5400',      0),
  ('HDD_RPM',       '7200',      1),
  ('HDD_RPM',       '10000',     2),
  ('HDD_RPM',       '15000',     3)
ON CONFLICT ("group", value) DO NOTHING;
