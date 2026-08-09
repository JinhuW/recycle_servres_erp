-- Rebuilds 0085's functional index after the canonical-part-number rule gained
-- a required separator after the P/N | S/N | PART label.
--
-- Without one the label also matched part numbers that merely start with those
-- letters — SNK-P0048AP4 (Supermicro heatsinks) and Dell's SNP112P/8G both lost
-- their first two characters, and SNK-… and PNK-… canonicalised to the same key.
--
-- The expression has to stay byte-identical to PART_PREFIX_RE in
-- src/lib/part-number.ts; tests/market-batch-lookup.test.ts compares
-- pg_get_indexdef against the TS constant. DROP first — CREATE INDEX IF NOT
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
      '[[:space:]]+',
      '',
      'g'
    )
  )
);
