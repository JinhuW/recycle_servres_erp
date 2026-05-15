export type Cursor = { ts: string; id: string };

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
  try { return JSON.parse(fromBase64Url(raw)); }
  catch { return null; }
}

export function clampLimit(raw: string | null | undefined, def = 50, max = 200): number {
  const n = Number(raw ?? def);
  if (Number.isNaN(n) || n <= 0) return def;
  return Math.min(n, max);
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
