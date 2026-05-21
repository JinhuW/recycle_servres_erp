import { Hono } from 'hono';
import { getDb } from '../db';
import { SAFE_UPLOAD_MIME, UPLOAD_HARD_CAP_BYTES } from '../lib/settings';
import type { Env, User } from '../types';

const workspace = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// Keys the backend's pricing/upload math reads. A bad type/range here silently
// corrupts maxBuy / margin gates / upload limits, so these are validated.
// Free-form keys (currency, timezone, …) stay unconstrained.
const isFrac = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1;
const KNOWN_SETTINGS: Record<string, (v: unknown) => boolean> = {
  upload_max_bytes: v =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= UPLOAD_HARD_CAP_BYTES,
  // Restrict to the SAFE_UPLOAD_MIME allowlist — uploads land in a public R2
  // bucket served with the declared Content-Type, so allowing image/svg+xml
  // or text/html would open a stored-XSS hole. The default set covers PDFs +
  // raster images; a workspace may narrow further but never widen.
  upload_allowed_mime: v =>
    Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && SAFE_UPLOAD_MIME.has(x)),
  low_margin_floor: isFrac,
  target_margin: isFrac,
  category_default_margin: v => typeof v === 'number' && Number.isFinite(v) && v >= 0,
};

workspace.get('/', async (c) => {
  // Workspace settings expose internal pricing/margin config — manager-only,
  // matching the PATCH guard below.
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const rows = await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM workspace_settings`;
  const settings: Record<string, unknown> = {};
  for (const r of rows) settings[r.key] = r.value;
  return c.json({ settings });
});

workspace.patch('/', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'body required' }, 400);
  for (const [k, v] of Object.entries(body)) {
    const check = KNOWN_SETTINGS[k];
    if (check && !check(v)) {
      return c.json({ error: `invalid value for ${k}` }, 400);
    }
  }
  const sql = getDb(c.env);
  // All-or-nothing: a multi-key PATCH must not leave settings half-applied
  // if one upsert fails midway.
  await sql.begin(async (tx) => {
    for (const [k, v] of Object.entries(body)) {
      await tx`
        INSERT INTO workspace_settings (key, value, updated_at)
        VALUES (${k}, ${tx.json(v as never)}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `;
    }
  });
  return c.json({ ok: true });
});

export default workspace;
