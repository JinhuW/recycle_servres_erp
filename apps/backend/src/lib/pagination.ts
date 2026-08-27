// `ts` carries the value of the active sort column for the last row of the
// previous page (an ISO timestamp for created_at, a number for total_cost,
// text for lifecycle). `id` is the stable tiebreaker. The keyset WHERE clause
// must compare on the SAME column the query is ordered by, or pages silently
// skip/duplicate rows.
export type Cursor = { ts: string | number; id: string };

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
