// Single source of truth for the canonical-part-number rule used to decide
// whether two PO lines describe the same product. Kept in lockstep with the
// frontend canonicalPartNumber() (frontend/src/lib/format.ts) and the
// scan-time rule in ai/normalize.ts. Strips a leading P/N | S/N | PART(NO|
// NUMBER) prefix, drops ALL whitespace, upper-cases.
//
// POSIX bracket classes ([[:space:]]) are used instead of \s so the pattern
// survives as plain SQL text inside REGEXP_REPLACE.

import postgres from 'postgres';

type Sql = ReturnType<typeof postgres>;

export const PART_PREFIX_RE =
  '^[[:space:]]*(P[[:space:]]*/?[[:space:]]*N|S[[:space:]]*/?[[:space:]]*N|PART[[:space:]]*(NO|NUMBER)?)[[:space:]]*[:#]?[[:space:]]*';

// Canonical form of a part_number COLUMN expression.
// Pass the column as a fragment, e.g. canonPartCol(sql, sql`l.part_number`).
export function canonPartCol(sql: Sql, col: ReturnType<Sql>) {
  return sql`UPPER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(${col}, ''), ${PART_PREFIX_RE}, '', 'i'), '[[:space:]]+', '', 'g'))`;
}

// Canonical form of a literal string argument.
export function canonPartArg(sql: Sql, raw: string) {
  return sql`UPPER(REGEXP_REPLACE(REGEXP_REPLACE(${raw}, ${PART_PREFIX_RE}, '', 'i'), '[[:space:]]+', '', 'g'))`;
}

// JS twin of the SQL canonicaliser above, for grouping rows in application
// code before a DB round-trip. Keep in lockstep with PART_PREFIX_RE.
export function canonPartNumberJs(pn: string): string {
  return pn
    .replace(/^\s*(?:P\s*\/?\s*N|S\s*\/?\s*N|PART\s*(?:NO|NUMBER)?)\s*[:#]?\s*/i, '')
    .replace(/\s+/g, '')
    .toUpperCase();
}
