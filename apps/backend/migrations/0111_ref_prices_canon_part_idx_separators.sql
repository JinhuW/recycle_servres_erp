-- Rebuilds 0089's functional index after the canonical-part-number rule started
-- folding `-` and `_` alongside whitespace, so one part spelled i5-10500t,
-- i5 10500t or i5_10500t is one key (0110 merged the rows that spelling had
-- already split).
--
-- The expression has to stay byte-identical to PART_PREFIX_RE + PART_SEP_RE in
-- src/lib/part-number.ts; tests/market-batch-lookup.test.ts compares
-- pg_get_indexdef against both constants. DROP first — CREATE INDEX IF NOT
-- EXISTS matches on name alone and would leave the old expression in place.

DROP INDEX IF EXISTS ref_prices_canon_part_idx;

CREATE INDEX IF NOT EXISTS ref_prices_canon_part_idx ON ref_prices (
  UPPER(
    REGEXP_REPLACE(
      REGEXP_REPLACE(
        COALESCE(part_number, ''),
        '^[[:space:]]*(P[[:space:]]*/?[[:space:]]*N|S[[:space:]]*/?[[:space:]]*N|PART[[:space:]]*(NO|NUMBER)?)([[:space:]]*[:#][[:space:]]*|[[:space:]]+)',
        '',
        'i'
      ),
      '[[:space:]_-]+',
      '',
      'g'
    )
  )
);
