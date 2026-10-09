-- SSD form factor gains 3.5": HPE's LFF SAS SSDs are sold under 3.5" part
-- numbers, and native 3.5" SATA/SAS SSDs exist. It sits after 2.5". M.2 2230
-- was added to prod by hand and no migration carried it, so a fresh database
-- lacked a value the label scanner can emit; it is inserted here too, which on
-- prod only moves it. Values-only re-rank: a hand-added form keeps its position.
INSERT INTO catalog_options ("group", value, position) VALUES
  ('SSD_FORM', '3.5"',     1),
  ('SSD_FORM', 'M.2 2230', 2)
ON CONFLICT ("group", value) DO UPDATE SET position = EXCLUDED.position, active = TRUE;

UPDATE catalog_options AS c SET position = v.pos
FROM (VALUES
  ('M.2 2280',  3),
  ('M.2 22110', 4),
  ('U.2',       5),
  ('AIC',       6)
) AS v(value, pos)
WHERE c."group" = 'SSD_FORM' AND c.value = v.value;
