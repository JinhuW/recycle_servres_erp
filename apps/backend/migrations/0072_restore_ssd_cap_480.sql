-- An earlier revision of 0071 (already applied on dev before the PR was
-- amended) replaced the SSD_CAP group with DELETE + INSERT, dropping the
-- historical 480GB option. Restore it and pin it after the 0071 list so
-- dev and prod converge on the same catalog. Idempotent upsert.
INSERT INTO catalog_options ("group", value, position) VALUES
  ('SSD_CAP', '480GB', 20)
ON CONFLICT ("group", value) DO UPDATE SET position = EXCLUDED.position;
