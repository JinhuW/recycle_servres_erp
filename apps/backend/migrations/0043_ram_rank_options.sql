-- Expand the RAM_RANK catalog to cover all real-world server/desktop/laptop
-- ranks. The previous list (9 values from the seed) missed several common
-- modern modules — 1Rx32 / 2Rx32 on dense DDR5, 4Rx16 and 8Rx8 on LRDIMM
-- stacks — so labels for those modules read as "rank not in dropdown" and
-- the form silently dropped the field.
--
-- Idempotent: catalog_options has UNIQUE("group", value); ON CONFLICT skips
-- existing rows. Position values overlap with the seed defaults (the seed
-- is the canonical source) but a fresh deployment that never ran db:seed
-- still gets a usable rank dropdown from migrations alone.
INSERT INTO catalog_options ("group", value, position) VALUES
  ('RAM_RANK', '1Rx4',  0),
  ('RAM_RANK', '1Rx8',  1),
  ('RAM_RANK', '1Rx16', 2),
  ('RAM_RANK', '1Rx32', 3),
  ('RAM_RANK', '2Rx4',  4),
  ('RAM_RANK', '2Rx8',  5),
  ('RAM_RANK', '2Rx16', 6),
  ('RAM_RANK', '2Rx32', 7),
  ('RAM_RANK', '4Rx4',  8),
  ('RAM_RANK', '4Rx8',  9),
  ('RAM_RANK', '4Rx16', 10),
  ('RAM_RANK', '8Rx4',  11),
  ('RAM_RANK', '8Rx8',  12)
ON CONFLICT ("group", value) DO NOTHING;
