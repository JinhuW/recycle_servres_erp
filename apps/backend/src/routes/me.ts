import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { MIN_PASSWORD_LEN, MAX_PASSWORD_LEN } from '@recycle-erp/shared';
import { getDb } from '../db';
import { hashPassword, verifyPassword } from '../auth';
import { validatePreferencePatch } from '../preferences';
import type { Env, User } from '../types';

const me = new Hono<{ Bindings: Env; Variables: { user: User } }>();

me.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  // Lifetime stats for the Profile screen. Realized model: revenue, profit
  // and commission all come from actual sales (sell_order_lines of Done sell
  // orders), priced at the sell-order unit_price (NOT the PO-side sell_price,
  // which is a projection). Commission is credited to the purchaser whose PO
  // brought the source inventory in. `count` is the number of sold line items
  // attributed to this purchaser.
  const stats = (await sql`
    SELECT
      COUNT(*)::int                                                                AS count,
      COALESCE(SUM(sol.unit_price * sol.qty), 0)::float                            AS revenue,
      COALESCE(SUM((sol.unit_price - ol.unit_cost) * sol.qty), 0)::float           AS profit,
      COALESCE(SUM((sol.unit_price - ol.unit_cost) * sol.qty
                   * COALESCE(po.commission_rate, 0)), 0)::float                   AS commission
    FROM sell_order_lines sol
    JOIN sell_orders so ON so.id = sol.sell_order_id
    JOIN order_lines ol ON ol.id = sol.inventory_id
    JOIN orders po      ON po.id = ol.order_id
    WHERE so.status = 'Done' AND po.user_id = ${u.id}
  `)[0] as { count: number; revenue: number; profit: number; commission: number };

  const r2dp = (v: number) => Math.round(v * 100) / 100;
  return c.json({
    user: u,
    stats: {
      count: stats.count,
      revenue: r2dp(stats.revenue),
      profit: r2dp(stats.profit),
      commission: r2dp(stats.commission),
    },
  });
});

me.patch('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { language?: 'en' | 'zh' } | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const u = c.var.user;
  const sql = getDb(c.env);
  if (body.language && (body.language === 'en' || body.language === 'zh')) {
    await sql`UPDATE users SET language = ${body.language} WHERE id = ${u.id}`;
  }
  return c.json({ ok: true });
});

// PATCH /api/me/preferences — partial merge into users.preferences JSONB.
// Body: { [key]: value }. Pass `null` to unset a key. Keys are allowlisted.
me.patch('/preferences', async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = validatePreferencePatch(body);
  if (!result.ok) return c.json({ error: result.error }, result.status);

  const u = c.var.user;
  const sql = getDb(c.env);

  // Read-modify-write. Per-user concurrency is effectively nil (the only
  // writer is the user themselves), and this keeps the merge logic in TS.
  const next: Record<string, unknown> = { ...(u.preferences ?? {}) };
  for (const [k, v] of Object.entries(result.cleaned)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }

  // Mirror language to the column so legacy code paths keep working.
  const nextLanguage =
    'language' in result.cleaned && result.cleaned['language'] !== null
      ? (result.cleaned['language'] as 'en' | 'zh')
      : u.language;

  // Allowlist values are JSON-safe (strings, string unions, string arrays),
  // but TS's strict JSONValue rejects `unknown`; cast at the boundary.
  await sql`
    UPDATE users
       SET preferences = ${sql.json(next as Record<string, never>)}::jsonb,
           language    = ${nextLanguage}
     WHERE id = ${u.id}
  `;

  return c.json({
    user: { ...u, preferences: next, language: nextLanguage },
  });
});

// POST /api/me/password — change the signed-in user's own password.
// Verifies currentPassword against the live hash, writes the new hash, and
// revokes every OTHER refresh-token family (this session stays alive so the
// user doesn't get bounced to login). Failed currentPassword attempts are
// throttled through the same durable login_attempts table the login route
// uses, so the defence survives restarts and is shared across replicas
// (an in-memory map would be per-process and reset on every deploy).

const PW_MAX_FAILS = 5;

me.post('/password', async (c) => {
  const u = c.var.user;
  const body = (await c.req.json().catch(() => null)) as
    | { currentPassword?: string; newPassword?: string }
    | null;
  if (!body || typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string') {
    return c.json({ error: 'currentPassword and newPassword required' }, 400);
  }

  const { currentPassword, newPassword } = body;
  if (newPassword.length < MIN_PASSWORD_LEN || newPassword.length > MAX_PASSWORD_LEN) {
    return c.json({ error: `New password must be ${MIN_PASSWORD_LEN}–${MAX_PASSWORD_LEN} characters` }, 400);
  }
  if (newPassword === currentPassword) {
    return c.json({ error: 'New password must differ from the current one' }, 400);
  }

  const sql = getDb(c.env);
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    null;

  // Throttle check before any bcrypt work — keeps it un-timeable. Counts
  // failed attempts on this account since its last success, in a 15-min
  // window, sharing the login route's table and semantics.
  const recentFails = (await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM login_attempts
    WHERE email = ${u.email} AND success = FALSE
      AND attempted_at > NOW() - INTERVAL '15 minutes'
      AND attempted_at > COALESCE(
        (SELECT MAX(attempted_at) FROM login_attempts
          WHERE email = ${u.email} AND success = TRUE),
        'epoch'::timestamptz)
  `)[0].n;
  if (recentFails >= PW_MAX_FAILS) {
    c.header('Retry-After', '900');
    return c.json({ error: 'Too many failed attempts; try again later' }, 429);
  }

  const recordAttempt = (success: boolean) =>
    sql`INSERT INTO login_attempts (email, ip, success) VALUES (${u.email}, ${ip}, ${success})`
      .catch((e) => console.error('login_attempts write failed', e));

  const row = (await sql<{ password_hash: string }[]>`
    SELECT password_hash FROM users WHERE id = ${u.id} AND active = TRUE LIMIT 1
  `)[0];
  if (!row) return c.json({ error: 'User not found' }, 404);

  if (!(await verifyPassword(currentPassword, row.password_hash))) {
    await recordAttempt(false);
    // 403 (not 401) — the JWT is still valid, only this specific action
    // failed. The frontend treats 401 as session-expired and would bounce
    // the user to the login screen on a mistyped current password.
    return c.json({ error: 'Current password is incorrect' }, 403);
  }
  await recordAttempt(true);

  const newHash = await hashPassword(newPassword);
  const rtRaw = getCookie(c, 'rt');
  const currentFamilyId = rtRaw
    ? (await sql<{ family_id: string }[]>`
        SELECT family_id FROM refresh_tokens
        WHERE token_hash = ${createHash('sha256').update(rtRaw).digest('hex')}
        LIMIT 1
      `)[0]?.family_id ?? null
    : null;

  await sql.begin(async (tx) => {
    await tx`UPDATE users SET password_hash = ${newHash} WHERE id = ${u.id}`;
    if (currentFamilyId) {
      await tx`UPDATE refresh_tokens SET revoked_at = NOW()
               WHERE user_id = ${u.id} AND revoked_at IS NULL
                 AND family_id != ${currentFamilyId}`;
    } else {
      await tx`UPDATE refresh_tokens SET revoked_at = NOW()
               WHERE user_id = ${u.id} AND revoked_at IS NULL`;
    }
  });

  return c.json({ ok: true });
});

export default me;
