-- `Other` lines created before 0082 added item_type carry NULL, so they show
-- up in the Untyped bucket and drop out of every item-type filter, chip and
-- export column. The description is the only classifier those rows ever had,
-- so read the type back out of it.
--
-- Patterns are deliberately narrow — an unrecognised description stays NULL
-- rather than being guessed into the wrong bucket. Scoped to NULL item_type
-- so a re-run never overwrites a value someone chose by hand.

UPDATE order_lines SET item_type = 'GPU'
WHERE category = 'Other'
  AND (item_type IS NULL OR btrim(item_type) = '')
  AND description ~* '(rtx|quadro|geforce|radeon|nvidia|tesla)';

UPDATE order_lines SET item_type = 'CPU'
WHERE category = 'Other'
  AND (item_type IS NULL OR btrim(item_type) = '')
  AND description ~* '(xeon|pentium|celeron|\mi[3579][ -]?[0-9]{4}|core i[3579]|\me-[0-9]{4})';

-- Two types the seeded vocabulary lacks. A complete PowerEdge is not a
-- 'Chassis' — the bare enclosure and a populated server carry very different
-- money — and 'HDD' exists only as a top-level category, which an Other line
-- cannot reach without losing its spec columns.
INSERT INTO item_types (name) VALUES ('Server'), ('HDD')
ON CONFLICT (lower(name)) DO NOTHING;

UPDATE order_lines SET item_type = 'Server'
WHERE category = 'Other'
  AND (item_type IS NULL OR btrim(item_type) = '')
  AND description ~* '\mr[0-9]{3}\M';

UPDATE order_lines SET item_type = 'HDD'
WHERE category = 'Other'
  AND (item_type IS NULL OR btrim(item_type) = '')
  AND description ~* '\m(hdd|hard drive)\M';

-- Last pass: descriptions that simply name their own type ("NIC — Mellanox
-- CX5", "PSU — 750W Platinum"). It runs after the passes above so a line whose
-- model number already identified it keeps that answer — "R740 XD missing fan"
-- is a Server, not a Fan. 'GPU Cooler' is deliberately unreachable here: it
-- matches no pattern and stays NULL rather than becoming a GPU.
-- `prio` breaks ties deterministically: "PSU cable" is a cable, so the
-- accessory patterns outrank the component they attach to. Without the
-- DISTINCT ON, a two-pattern description would take an arbitrary row.
UPDATE order_lines SET item_type = m.name
FROM (
  SELECT DISTINCT ON (l.id) l.id, t.name
  FROM order_lines l
  JOIN (VALUES
    ('Cable',           '\mcables?\M',                     1),
    ('Fan',             '\mfans?\M',                       2),
    ('Heatsink',        '\mheat ?sinks?\M',                3),
    ('Riser card',      '\mriser\M',                       4),
    ('Backplane',       '\mbackplanes?\M',                 5),
    ('RAID controller', '\mraid\M',                        6),
    ('NIC',             '\mnics?\M',                       7),
    ('PSU',             '\m(psu|power supply)\M',          8),
    ('Motherboard',     '\m(motherboard|mainboard|mobo)\M', 9),
    ('Chassis',         '\mchassis\M',                     10)
  ) AS t(name, pattern, prio) ON l.description ~* t.pattern
  WHERE l.category = 'Other'
    AND (l.item_type IS NULL OR btrim(l.item_type) = '')
  ORDER BY l.id, t.prio
) AS m
WHERE order_lines.id = m.id;
