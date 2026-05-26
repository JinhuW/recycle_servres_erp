-- Repopulate the RAM_SPEED catalog. Deployed DBs that never ran db:seed (or
-- ran it before the catalog was promoted to a lookup table) ended up with an
-- empty RAM_SPEED group, which left the Speed (MHz) dropdown on submit/edit
-- showing no options. Mirrors the seed list in apps/backend/scripts/seed.mjs.
--
-- Idempotent: catalog_options has UNIQUE("group", value); ON CONFLICT skips
-- existing rows. Same pattern as 0043_ram_rank_options.sql — a fresh deploy
-- that never ran db:seed still gets a usable Speed dropdown from migrations
-- alone, while existing rows keep their position.
INSERT INTO catalog_options ("group", value, position) VALUES
  ('RAM_SPEED', '800',  0),
  ('RAM_SPEED', '1066', 1),
  ('RAM_SPEED', '1333', 2),
  ('RAM_SPEED', '1600', 3),
  ('RAM_SPEED', '1866', 4),
  ('RAM_SPEED', '2133', 5),
  ('RAM_SPEED', '2400', 6),
  ('RAM_SPEED', '2666', 7),
  ('RAM_SPEED', '2933', 8),
  ('RAM_SPEED', '3200', 9),
  ('RAM_SPEED', '4000', 10),
  ('RAM_SPEED', '4400', 11),
  ('RAM_SPEED', '4800', 12),
  ('RAM_SPEED', '5200', 13),
  ('RAM_SPEED', '5600', 14),
  ('RAM_SPEED', '6000', 15),
  ('RAM_SPEED', '6400', 16),
  ('RAM_SPEED', '6800', 17),
  ('RAM_SPEED', '7200', 18),
  ('RAM_SPEED', '7600', 19),
  ('RAM_SPEED', '8000', 20)
ON CONFLICT ("group", value) DO NOTHING;
