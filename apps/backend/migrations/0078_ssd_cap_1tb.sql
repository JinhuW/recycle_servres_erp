-- SSD capacity dropdown: 1024GB is not how these drives are labelled or listed,
-- and sitting next to 1000GB it made the pick ambiguous. Replace it with 1TB in
-- the same slot (after 1000GB, before 1.6TB) so 0073's ascending order holds.
--
-- Existing order_lines / inventory rows still holding '1024GB' are left alone:
-- CatSelect renders a stored value that's no longer in the catalog as a one-off
-- option, so historical records keep displaying correctly.
INSERT INTO catalog_options ("group", value, position) VALUES
  ('SSD_CAP', '1TB', 10)
ON CONFLICT ("group", value) DO UPDATE SET position = EXCLUDED.position;

DELETE FROM catalog_options WHERE "group" = 'SSD_CAP' AND value = '1024GB';
