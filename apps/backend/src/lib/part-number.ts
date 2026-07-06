// Single source of truth for the canonical-part-number rule used to decide
// whether two PO lines describe the same product. Kept in lockstep with the
// frontend canonicalPartNumber() (frontend/src/lib/format.ts) and the
// scan-time rule in ai/normalize.ts. Strips a leading P/N | S/N | PART(NO|
// NUMBER) prefix, drops ALL whitespace, upper-cases.
//
// POSIX bracket classes ([[:space:]]) are used instead of \s so the pattern
// survives as plain SQL text inside REGEXP_REPLACE.

import postgres, { type TransactionSql } from 'postgres';

type Sql = ReturnType<typeof postgres>;
// Either the top-level pool or a `tx` inside a sql.begin block — both are
// valid callers of canonPartCol/canonPartArg below.
type SqlLike = Sql | TransactionSql;

export const PART_PREFIX_RE =
  '^[[:space:]]*(P[[:space:]]*/?[[:space:]]*N|S[[:space:]]*/?[[:space:]]*N|PART[[:space:]]*(NO|NUMBER)?)[[:space:]]*[:#]?[[:space:]]*';

// Canonical form of a part_number COLUMN expression.
// Pass the column as a fragment, e.g. canonPartCol(sql, sql`l.part_number`).
export function canonPartCol(sql: SqlLike, col: postgres.Fragment) {
  return sql`UPPER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(${col}, ''), ${PART_PREFIX_RE}, '', 'i'), '[[:space:]]+', '', 'g'))`;
}

// Canonical form of a literal string argument.
export function canonPartArg(sql: Sql, raw: string) {
  return sql`UPPER(REGEXP_REPLACE(REGEXP_REPLACE(${raw}, ${PART_PREFIX_RE}, '', 'i'), '[[:space:]]+', '', 'g'))`;
}

// JS twin of the SQL canonicaliser above, for grouping rows in application
// code before a DB round-trip. Keep in lockstep with PART_PREFIX_RE.
//
// Uses an explicit ASCII whitespace class instead of \s: JS \s also matches
// NBSP, U+2007, U+FEFF, etc., which the SQL side's POSIX [[:space:]] (under
// the default locale) does not. A stray non-ASCII space in a sold line's PN
// would then canonicalise differently in JS vs SQL, the id-lookup join in
// sellOrderMarket.ts would miss, and the data point would be silently
// dropped — so the two must match byte-for-byte.
const ASCII_WS = '[ \\t\\n\\v\\f\\r]';
const PREFIX_JS_RE = new RegExp(
  `^${ASCII_WS}*(?:P${ASCII_WS}*/?${ASCII_WS}*N|S${ASCII_WS}*/?${ASCII_WS}*N|PART${ASCII_WS}*(?:NO|NUMBER)?)${ASCII_WS}*[:#]?${ASCII_WS}*`,
  'i',
);
const WS_JS_RE = new RegExp(`${ASCII_WS}+`, 'g');

export function canonPartNumberJs(pn: string): string {
  return pn
    .replace(PREFIX_JS_RE, '')
    .replace(WS_JS_RE, '')
    .toUpperCase();
}
