-- Add a "Mixed" SSD brand for batches of assorted-brand drives entered as one
-- line. When the user picks Mixed and leaves the part number blank, the backend
-- derives a synthetic id (MIXED_<cap>_<iface>_<form>) — see lib partNumberSynth
-- in @recycle-erp/shared. Idempotent via the ("group", value) unique constraint.
INSERT INTO catalog_options ("group", value, position) VALUES
  ('SSD_BRAND', 'Mixed', 6)
ON CONFLICT ("group", value) DO NOTHING;
