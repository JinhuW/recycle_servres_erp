-- RAM rank (e.g. 1Rx4, 2Rx8) is meaningful pricing context: dual-rank
-- modules trade at a different value than single-rank for the same speed
-- and capacity. Surface it on the Market Value screen alongside class +
-- speed.

ALTER TABLE ref_prices ADD COLUMN IF NOT EXISTS rank TEXT;
