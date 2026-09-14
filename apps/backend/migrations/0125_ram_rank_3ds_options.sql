-- The RAM_RANK catalog held only the plain JEDEC NRxM grid, so a high-density
-- module could not be recorded with the rank actually printed on it. Two
-- notations were missing, and they describe different constructions rather than
-- two vendors' spellings of one thing:
--
--   nDRxm   D = dual-die package (DDP)      4DRx4, 8DRx4
--   nSmRxk  S = an n-high 3DS stack         2S2Rx4, 2S4Rx4, 4S2Rx4
--
-- Samsung, SK Hynix and Micron each print both, depending on the module.
-- Production already carried three order_lines reading 4DRx4 — typed in past a
-- dropdown that never offered it.
--
-- Appended at 13-17 rather than interleaved with the plain ranks: lookups.ts
-- orders by (position, value), so the common grid stays at the top of the
-- dropdown and no existing row needs re-ranking. DO NOTHING (not 0071's
-- DO UPDATE SET position) for the same reason — 0043 set that precedent for
-- this group. Mirrors the list in apps/backend/scripts/seed.mjs, which deletes
-- and rewrites catalog_options wholesale; the two must agree.
INSERT INTO catalog_options ("group", value, position) VALUES
  ('RAM_RANK', '4DRx4',  13),
  ('RAM_RANK', '8DRx4',  14),
  ('RAM_RANK', '2S2Rx4', 15),
  ('RAM_RANK', '2S4Rx4', 16),
  ('RAM_RANK', '4S2Rx4', 17)
ON CONFLICT ("group", value) DO NOTHING;
