-- Index for the canonical-part-number lookup behind POST /api/market/lookup.
--
-- ref_prices.part_number is nullable and carries no index at all, so matching a
-- PO's part numbers against it was a sequential scan with a regex applied per
-- row. The predicate canonicalises the column (strip a P/N/S/N prefix, drop
-- whitespace, upper-case), so a plain btree on part_number cannot serve it —
-- the index has to be on the same expression.
--
-- Legality: upper() and every regexp_replace() overload are provolatile='i'
-- (IMMUTABLE) and COALESCE is a special form, so the expression qualifies.
--
-- The expression below must stay byte-identical to PART_PREFIX_RE in
-- src/lib/part-number.ts or the planner silently stops matching and the query
-- quietly degrades to a seq scan. tests/market-canon-index.test.ts asserts
-- that by comparing pg_get_indexdef against the TS constant.
--
-- upper() is collation-dependent-but-marked-immutable, so a glibc/ICU upgrade
-- technically invalidates this index: REINDEX after one.

CREATE INDEX IF NOT EXISTS ref_prices_canon_part_idx ON ref_prices (
  UPPER(
    REGEXP_REPLACE(
      REGEXP_REPLACE(
        COALESCE(part_number, ''),
        '^[[:space:]]*(P[[:space:]]*/?[[:space:]]*N|S[[:space:]]*/?[[:space:]]*N|PART[[:space:]]*(NO|NUMBER)?)[[:space:]]*[:#]?[[:space:]]*',
        '',
        'i'
      ),
      '[[:space:]]+',
      '',
      'g'
    )
  )
);
