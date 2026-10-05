-- SSD capacity gains 2TB, which the list skipped (1.92TB → 3.2TB), and RAM
-- class gains CAMM, the compression-attached laptop module. 2TB takes 3.2TB's
-- slot and the larger sizes move down one, so 0073's ascending order holds.
-- Values-only re-rank: a hand-added size keeps its position.
INSERT INTO catalog_options ("group", value, position) VALUES
  ('SSD_CAP',   '2TB',  13),
  ('RAM_CLASS', 'CAMM',  4)
ON CONFLICT ("group", value) DO UPDATE SET position = EXCLUDED.position, active = TRUE;

UPDATE catalog_options AS c SET position = v.pos
FROM (VALUES
  ('3.2TB',   14),
  ('3.84TB',  15),
  ('6.4TB',   16),
  ('7.68TB',  17),
  ('8TB',     18),
  ('12.8TB',  19),
  ('15.36TB', 20),
  ('30.72TB', 21)
) AS v(value, pos)
WHERE c."group" = 'SSD_CAP' AND c.value = v.value;
