-- DDR5-3600 is a valid JEDEC bin (JESD79-5) but was omitted from the original
-- RAM_SPEED seed list (which jumped 3200 → 4000). It now shows up on real
-- DDR5 SODIMM stock. Submit form is free-text since 0058+app changes, but
-- inventory filter chips still render from this catalog — add it so the chip
-- is offered when matching rows exist.
INSERT INTO catalog_options ("group", value, position) VALUES
  ('RAM_SPEED', '3600', 10)
ON CONFLICT ("group", value) DO NOTHING;
