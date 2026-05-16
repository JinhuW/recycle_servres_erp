-- The RAM `type` column historically stored the DDR generation
-- (DDR3/DDR4/DDR5). Rename it to `generation` and introduce a fresh `type`
-- column that stores the device class (Desktop / Server / Laptop). Backfill
-- the new `type` for existing RAM rows from the DIMM form factor.
-- Fully idempotent: the runner re-applies every migration on each run.

DO $$
BEGIN
  IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'order_lines'
          AND column_name = 'generation')
     AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'order_lines'
          AND column_name = 'type') THEN
    ALTER TABLE order_lines RENAME COLUMN type TO generation;
  END IF;
END $$;

ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS type TEXT;

-- RAM rows whose classification is NULL or outside the four DIMM values keep
-- type = NULL by design (the CASE has no ELSE); type is nullable.
UPDATE order_lines
SET type = CASE classification
  WHEN 'SODIMM' THEN 'Laptop'
  WHEN 'UDIMM'  THEN 'Desktop'
  WHEN 'RDIMM'  THEN 'Server'
  WHEN 'LRDIMM' THEN 'Server'
END
WHERE category = 'RAM' AND type IS NULL;
