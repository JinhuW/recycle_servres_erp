import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { MIN_PASSWORD_LEN, MAX_PASSWORD_LEN } from '@recycle-erp/shared';
import { getDb } from '../db';
import { clientIp } from '../lib/clientIp';
import { reserveAttempt } from '../lib/loginAttempts';
import { epochSeconds, hashPassword, verifyPassword, verifyToken } from '../auth';
import { revokeUserOAuthTokens } from '../oauth/tokens';
import { validatePreferencePatch } from '../preferences';
import { log } from '../lib/log';
import { effUnitCost, poFeeBasis } from '../lib/po-cost';
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
      COALESCE(SUM((sol.unit_price - ${effUnitCost(sql)}) * sol.qty), 0)::float    AS profit,
      COALESCE(SUM((sol.unit_price - ${effUnitCost(sql)}) * sol.qty
                   * COALESCE(po.commission_rate, 0)), 0)::float                   AS commission
    FROM sell_order_lines sol
    JOIN sell_orders so ON so.id = sol.sell_order_id
    JOIN order_lines ol ON ol.id = sol.inventory_id
    JOIN orders po      ON po.id = ol.order_id
    ${poFeeBasis(sql)}
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
  const body = (await c.req.json().catch(() => null)) as
    | { language?: 'en' | 'zh'; defaultWarehouseId?: string | null }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const u = c.var.user;
  const sql = getDb(c.env);
  if (body.language && (body.language === 'en' || body.language === 'zh')) {
    await sql`UPDATE users SET language = ${body.language} WHERE id = ${u.id}`;
  }
  // null clears the default; a non-null value must name a real warehouse so a
  // stale client can't wedge an id the FK would 500 on.
  if (body.defaultWarehouseId !== undefined) {
    const whId = body.defaultWarehouseId;
    if (whId !== null) {
      if (typeof whId !== 'string') {
        return c.json({ error: 'defaultWarehouseId must be a warehouse id or null' }, 400);
      }
      const wh = await sql<{ id: string }[]>`
        SELECT id FROM warehouses WHERE id = ${whId} LIMIT 1
      `;
      if (!wh.length) return c.json({ error: 'Unknown warehouse' }, 400);
    }
    await sql`UPDATE users SET default_warehouse_id = ${whId} WHERE id = ${u.id}`;
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

  // Merged in SQL against the live row, not the copy auth loaded at request
  // start: two tabs saving different keys would otherwise each write back the
  // whole document and the later one erase the other's change.
  const sets: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(result.cleaned)) {
    if (v === null) removed.push(k);
    else sets[k] = v;
  }
  // Mirror language to the column so legacy code paths keep working — only
  // when this patch carries it, so an unrelated save can't revert a
  // concurrent language change.
  const nextLanguage =
    'language' in result.cleaned && result.cleaned['language'] !== null
      ? (result.cleaned['language'] as 'en' | 'zh')
      : null;

  // Allowlist values are JSON-safe (strings, string unions, string arrays),
  // but TS's strict JSONValue rejects `unknown`; cast at the boundary.
  const [row] = await sql<{ preferences: Record<string, unknown>; language: 'en' | 'zh' }[]>`
    UPDATE users
       SET preferences = (COALESCE(preferences, '{}'::jsonb)
                          || ${sql.json(sets as Record<string, never>)}::jsonb)
                         - ${removed}::text[],
           language    = COALESCE(${nextLanguage}, language)
     WHERE id = ${u.id}
     RETURNING COALESCE(preferences, '{}'::jsonb) AS preferences, language
  `;

  return c.json({
    user: { ...u, preferences: row.preferences, language: row.language },
  });
});

// POST /api/me/password — change the signed-in user's own password.
// Verifies currentPassword against the live hash, writes the new hash, and
// revokes every OTHER refresh-token family. Every access token issued so far
// stops working, this session's included; this session keeps its refresh
// family, so its next request 401s once and refreshes instead of bouncing the
// user to login. Failed currentPassword attempts are
// throttled through the same durable login_attempts reservation the login
// route uses, so the defence survives restarts and is shared across replicas.

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
  const ip = clientIp((n) => c.req.header(n));

  // The same durable reservation login takes (lib/loginAttempts), before any
  // bcrypt work: counting first let a concurrent burst of guesses all pass one
  // stale count and reach bcrypt past the five-attempt budget.
  const attempt = await reserveAttempt(sql, {
    email: u.email, ip, ipKnown: !!c.req.header('x-client-ip'),
  });
  if (attempt.locked) {
    c.header('Retry-After', '900');
    return c.json({ error: 'Too many failed attempts; try again later' }, 429);
  }
  try {
    const row = (await sql<{ password_hash: string }[]>`
      SELECT password_hash FROM users WHERE id = ${u.id} AND active = TRUE LIMIT 1
    `)[0];
    if (!row) return c.json({ error: 'User not found' }, 404);

    if (!(await verifyPassword(currentPassword, row.password_hash))) {
      await attempt.settle(false);
      // 403 (not 401) — the JWT is still valid, only this specific action
      // failed. The frontend treats 401 as session-expired and would bounce
      // the user to the login screen on a mistyped current password.
      return c.json({ error: 'Current password is incorrect' }, 403);
    }
    await attempt.settle(true);

    const newHash = await hashPassword(newPassword);
    // The caller's session is the refresh family its access token was minted
    // with. The `rt` cookie itself never reaches this path (it is scoped to
    // /api/auth), so reading it here found nothing and revoked the caller too.
    // A token minted before the claim existed has no fid: every family goes.
    const currentFamilyId = (await verifyToken(c.env, getCookie(c, 'at') ?? ''))?.fid ?? null;

    await sql.begin(async (tx) => {
      // No fresh cookies are set here: setAuthCookies also rewrites `rt`, which
      // this path never sees, so the caller is left to refresh into a new token.
      await tx`UPDATE users
               SET password_hash = ${newHash}, tokens_valid_after = to_timestamp(${epochSeconds()}),
                   credential_version = credential_version + 1
               WHERE id = ${u.id}`;
      if (currentFamilyId) {
        await tx`UPDATE refresh_tokens SET revoked_at = NOW()
                 WHERE user_id = ${u.id} AND revoked_at IS NULL
                   AND family_id != ${currentFamilyId}`;
      } else {
        await tx`UPDATE refresh_tokens SET revoked_at = NOW()
                 WHERE user_id = ${u.id} AND revoked_at IS NULL`;
      }
      // OAuth grants must die with the old password too — they otherwise keep
      // minting access tokens through rotation regardless of the credential change.
      await revokeUserOAuthTokens(tx, u.id);
    });

    return c.json({ ok: true });
  } finally {
    await attempt.release();
  }
});

export default me;
