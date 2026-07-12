-- Order the SSD capacity dropdown by size ascending (0071/0072 left it in
-- entry order). Values-only update; unknown/hand-added values keep their
-- position and sort wherever that lands them.
UPDATE catalog_options AS c SET position = v.pos
FROM (VALUES
  ('120GB',    0),
  ('128GB',    1),
  ('240GB',    2),
  ('256GB',    3),
  ('400GB',    4),
  ('480GB',    5),
  ('512GB',    6),
  ('800GB',    7),
  ('960GB',    8),
  ('1000GB',   9),
  ('1024GB',  10),
  ('1.6TB',   11),
  ('1.92TB',  12),
  ('3.2TB',   13),
  ('3.84TB',  14),
  ('6.4TB',   15),
  ('7.68TB',  16),
  ('8TB',     17),
  ('12.8TB',  18),
  ('15.36TB', 19),
  ('30.72TB', 20)
) AS v(value, pos)
WHERE c."group" = 'SSD_CAP' AND c.value = v.value;
