-- Replace the SSD capacity catalog with the full range the business actually
-- buys (120GB–30.72TB). The PO form's capacity field becomes a strict select
-- at the same time, so the list must cover every real-world size; lines that
-- stored a now-removed value (e.g. 480GB) still render via the orphan-safe
-- select pattern in the frontend.
DELETE FROM catalog_options WHERE "group" = 'SSD_CAP';

INSERT INTO catalog_options ("group", value, position) VALUES
  ('SSD_CAP', '256GB',   0),
  ('SSD_CAP', '240GB',   1),
  ('SSD_CAP', '128GB',   2),
  ('SSD_CAP', '400GB',   3),
  ('SSD_CAP', '512GB',   4),
  ('SSD_CAP', '120GB',   5),
  ('SSD_CAP', '960GB',   6),
  ('SSD_CAP', '1000GB',  7),
  ('SSD_CAP', '1024GB',  8),
  ('SSD_CAP', '800GB',   9),
  ('SSD_CAP', '1.6TB',  10),
  ('SSD_CAP', '1.92TB', 11),
  ('SSD_CAP', '3.2TB',  12),
  ('SSD_CAP', '3.84TB', 13),
  ('SSD_CAP', '7.68TB', 14),
  ('SSD_CAP', '8TB',    15),
  ('SSD_CAP', '6.4TB',  16),
  ('SSD_CAP', '12.8TB', 17),
  ('SSD_CAP', '15.36TB', 18),
  ('SSD_CAP', '30.72TB', 19)
ON CONFLICT ("group", value) DO UPDATE SET position = EXCLUDED.position;
