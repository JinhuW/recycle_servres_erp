-- Backfill rank for RAM ref_prices created before 0004 added the column.
-- Idempotent: only updates rows whose rank is still NULL. Mapping uses the
-- same spec table as the seed, with a capacity/classification fallback for
-- any custom rows.

UPDATE ref_prices SET rank = '4Rx4'
  WHERE category = 'RAM' AND rank IS NULL AND classification = 'LRDIMM';

UPDATE ref_prices SET rank = '1Rx8'
  WHERE category = 'RAM' AND rank IS NULL AND capacity = '16GB' AND classification = 'UDIMM';

UPDATE ref_prices SET rank = '2Rx8'
  WHERE category = 'RAM' AND rank IS NULL AND capacity = '32GB' AND classification = 'UDIMM';

UPDATE ref_prices SET rank = '1Rx4'
  WHERE category = 'RAM' AND rank IS NULL AND capacity = '16GB';

UPDATE ref_prices SET rank = '2Rx8'
  WHERE category = 'RAM' AND rank IS NULL AND capacity IN ('8GB', '32GB') AND type = 'DDR5';

UPDATE ref_prices SET rank = '2Rx4'
  WHERE category = 'RAM' AND rank IS NULL AND capacity = '32GB';

UPDATE ref_prices SET rank = '2Rx4'
  WHERE category = 'RAM' AND rank IS NULL AND capacity = '64GB';

UPDATE ref_prices SET rank = '2Rx8'
  WHERE category = 'RAM' AND rank IS NULL;
