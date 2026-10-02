import type postgres from 'postgres';
import type { SqlLike } from '../db';

type SqlFragment = postgres.PendingQuery<postgres.Row[]>;

// `ts` carries the value of the active sort column for the last row of the
// previous page (an ISO timestamp for created_at, a number for total_cost,
// text for lifecycle). `id` is the stable tiebreaker. The keyset WHERE clause
// must compare on the SAME column the query is ordered by, or pages silently
// skip/duplicate rows.
export type Cursor = { ts: string | number; id: string };

// uuid-typed columns make Postgres throw on a malformed id, so routes check
// this first and answer 400/404 instead of a 500.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// base64url is base64 with URL-safe chars and no padding. We use btoa/atob so
// this works on both Cloudflare Workers and Node — no Buffer dependency.
function toBase64Url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

export function encodeCursor(c: Cursor): string {
  return toBase64Url(JSON.stringify(c));
}

export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(fromBase64Url(raw)) as unknown;
    // Shape-checked here, not per route: consumers interpolate ts/id straight
    // into ::timestamptz / ::uuid casts, so a crafted or truncated cursor
    // would otherwise 500 instead of falling back to the first page.
    if (
      typeof c === 'object' && c !== null
      && (typeof (c as Cursor).ts === 'string' || typeof (c as Cursor).ts === 'number')
      && typeof (c as Cursor).id === 'string'
    ) {
      return c as Cursor;
    }
    return null;
  } catch { return null; }
}

// A keyset cursor on a timestamptz has to keep its microseconds. postgres.js
// parses the column into a JS Date, which keeps milliseconds, so a cursor
// encoded from `row.created_at` sat up to 999µs before the last row shown:
// page two skipped every row in that window, or repeated the boundary row.
// A burst insert (a sync, an import) puts dozens of rows in one millisecond.
// Encode from `cursorTsSelect` (text, µs, UTC), and compare with
// `cursorTsParam`, which casts through text so the value never meets a Date.
// `inventory.ts`'s transfer-orders list was the first to do this.
export function cursorTsSelect(sql: SqlLike, col: SqlFragment): SqlFragment {
  return sql`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/** The cursor's timestamp, or null when it is not one: a page-one fallback. */
export function cursorTs(c: Cursor | null): string | null {
  return c && typeof c.ts === 'string' && CURSOR_TS_RE.test(c.ts) ? c.ts : null;
}

export function cursorTsParam(sql: SqlLike, ts: string): SqlFragment {
  return sql`(${ts}::text)::timestamptz`;
}

export function clampLimit(raw: string | null | undefined, def = 50, max = 200): number {
  const n = Number(raw ?? def);
  if (Number.isNaN(n) || n <= 0) return def;
  return Math.min(n, max);
}

// A user's search box is not a pattern language. Without this an ACH
// descriptor containing `%` turns `id ILIKE $1` into "every row", and `_`
// quietly matches a character the person did not type. Backslash is LIKE's
// default escape, so escaping it first keeps a literal one literal.
export function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => '\\' + c);
}

const ALLOWED_SORT: Record<string, Set<string>> = {
  orders: new Set(['created_at', 'total_cost', 'lifecycle']),
  inventory: new Set(['created_at', 'qty', 'sell_price', 'unit_cost']),
  'sell-orders': new Set(['created_at', 'status']),
};

export function parseSort(scope: keyof typeof ALLOWED_SORT, raw: string | null | undefined):
  | { col: string; dir: 'asc' | 'desc' }
  | null {
  if (!raw) return null;
  const [col, dirRaw] = raw.split(':');
  if (!ALLOWED_SORT[scope].has(col)) return null;
  const dir = (dirRaw === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';
  return { col, dir };
}
