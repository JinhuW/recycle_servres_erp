// SQL half of the canonical-part-number rule used to decide whether two lines
// describe the same product. The JS half is canonicalPartNumber in
// @recycle-erp/shared — both apps import it, so the key a client asks under is
// the key this keys its answers with. Both halves come off the same prefix
// template; only the whitespace class differs.
//
// POSIX bracket classes ([[:space:]]) are used instead of \s so the pattern
// survives as plain SQL text inside REGEXP_REPLACE, and because migration 0085
// builds a functional index on ref_prices from this exact string — change its
// bytes and the index silently stops being used.

import postgres, { type TransactionSql } from 'postgres';
import { canonicalPartNumber, partPrefixPattern } from '@recycle-erp/shared';

type Sql = ReturnType<typeof postgres>;
// Either the top-level pool or a `tx` inside a sql.begin block — both are
// valid callers of canonPartCol/canonPartArg below.
type SqlLike = Sql | TransactionSql;

export const PART_PREFIX_RE = partPrefixPattern('[[:space:]]');

// Canonical form of a part_number COLUMN expression.
// Pass the column as a fragment, e.g. canonPartCol(sql, sql`l.part_number`).
export function canonPartCol(sql: SqlLike, col: postgres.Fragment) {
  return sql`UPPER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(${col}, ''), ${PART_PREFIX_RE}, '', 'i'), '[[:space:]]+', '', 'g'))`;
}

// Canonical form of a literal string argument.
export function canonPartArg(sql: Sql, raw: string) {
  return sql`UPPER(REGEXP_REPLACE(REGEXP_REPLACE(${raw}, ${PART_PREFIX_RE}, '', 'i'), '[[:space:]]+', '', 'g'))`;
}

// JS twin of the SQL canonicaliser above, for grouping rows in application code
// before a DB round-trip.
//
// The two agree on ASCII whitespace and on the spaces POSIX [[:space:]] leaves
// alone — U+00A0, U+2007, U+202F, U+FEFF, the ones a part number pasted from a
// vendor sheet actually carries. They do NOT agree on the U+2000 block, U+205F,
// U+3000 or U+1680: under a UTF-8 locale Postgres counts those as space and the
// ASCII class does not, so a stored part number containing one canonicalises
// differently here than in SQL and the id-lookup joins in sellOrderMarket.ts /
// marketAutoTrack.ts miss. Narrowing the SQL side means rebuilding 0085's
// index; widening this side would tie the key to the database's locale.
export const canonPartNumberJs = canonicalPartNumber;
