-- Backfill catalog groups that only existed in seed.mjs and never landed in a
-- migration. Prod deploys that didn't run db:seed (most do not) end up with
-- empty RAM_BRAND / RAM_CAP / RAM_CLASS / RAM_TYPE / SSD_* dropdowns; the UI
-- then renders only the AI-prefilled value as an orphan option, so the user
-- can't switch brand from "Samsung" to "SK Hynix" because no other option
-- exists in the dropdown.
--
-- Mirrors the values in apps/backend/scripts/seed.mjs. Idempotent via the
-- ("group", value) unique constraint; positions match seed.mjs ordering so
-- the dropdowns sort the same on freshly-seeded and migration-only DBs.
INSERT INTO catalog_options ("group", value, position) VALUES
  ('RAM_BRAND', 'Samsung',  0),
  ('RAM_BRAND', 'SK Hynix', 1),
  ('RAM_BRAND', 'Micron',   2),
  ('RAM_BRAND', 'Kingston', 3),
  ('RAM_BRAND', 'Other',    4),

  ('RAM_TYPE', 'DDR3', 0),
  ('RAM_TYPE', 'DDR4', 1),
  ('RAM_TYPE', 'DDR5', 2),

  ('RAM_CLASS', 'UDIMM',  0),
  ('RAM_CLASS', 'RDIMM',  1),
  ('RAM_CLASS', 'LRDIMM', 2),
  ('RAM_CLASS', 'SODIMM', 3),

  ('RAM_CAP', '4GB',   0),
  ('RAM_CAP', '8GB',   1),
  ('RAM_CAP', '16GB',  2),
  ('RAM_CAP', '32GB',  3),
  ('RAM_CAP', '64GB',  4),
  ('RAM_CAP', '128GB', 5),

  ('SSD_BRAND', 'Samsung', 0),
  ('SSD_BRAND', 'Intel',   1),
  ('SSD_BRAND', 'Micron',  2),
  ('SSD_BRAND', 'WD',      3),
  ('SSD_BRAND', 'Seagate', 4),
  ('SSD_BRAND', 'Kioxia',  5),

  ('SSD_INTERFACE', 'SATA', 0),
  ('SSD_INTERFACE', 'SAS',  1),
  ('SSD_INTERFACE', 'NVMe', 2),
  ('SSD_INTERFACE', 'U.2',  3),

  ('SSD_FORM', '2.5"',      0),
  ('SSD_FORM', 'M.2 2280',  1),
  ('SSD_FORM', 'M.2 22110', 2),
  ('SSD_FORM', 'U.2',       3),
  ('SSD_FORM', 'AIC',       4),

  ('SSD_CAP', '240GB',  0),
  ('SSD_CAP', '480GB',  1),
  ('SSD_CAP', '960GB',  2),
  ('SSD_CAP', '1.92TB', 3),
  ('SSD_CAP', '3.84TB', 4),
  ('SSD_CAP', '7.68TB', 5),

  ('CONDITION', 'New',                0),
  ('CONDITION', 'Pulled — Tested',    1),
  ('CONDITION', 'Pulled — Untested',  2),
  ('CONDITION', 'Used',               3)
ON CONFLICT ("group", value) DO NOTHING;
