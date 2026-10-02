import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { getDb } from '../db';
import {
  signToken,
  verifyPassword,
  issueRefresh,
  rotateRefresh,
  revokeFamily,
  setAuthCookies,
  clearAuthCookies,
  sha256hex,
} from '../auth';
import { log } from '../lib/log';
import { clientIp } from '../lib/clientIp';
import type { Env } from '../types';

const auth = new Hono<{ Bindings: Env }>();

auth.post('/login', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { email?: unknown; password?: unknown }
    | null;
  if (typeof body?.email !== 'string' || typeof body.password !== 'string'
      || !body.email || !body.password) {
    return c.json({ error: 'email and password required' }, 400);
  }
  const email = body.email.toLowerCase().trim();
  const password = body.password;
  const ip = clientIp((n) => c.req.header(n));
  // Only the Worker's X-Client-IP names one caller; without it every request
  // shares a Cloudflare egress address, and a per-address budget would lock
  // everyone out together.
  const ipKnown = !!c.req.header('x-client-ip');

  const sql = getDb(c.env);

  // Brute-force throttle: once an email has FAILED_LIMIT failures in the
  // window since its last success it is locked, and an address that has failed
  // IP_FAILED_LIMIT times across any emails is too. The attempt is reserved
  // BEFORE the count — a NULL success row — so concurrent guesses count against
  // one another; counting first let a whole burst pass before any was recorded.
  // The reservation is settled once bcrypt answers, or deleted if this request
  // is refused or fails first, so a refusal never lengthens the lockout.
  const FAILED_LIMIT = 5;
  const IP_FAILED_LIMIT = 30;
  const [{ id: attemptId }] = await sql<{ id: string }[]>`
    INSERT INTO login_attempts (email, ip, ip_key, success)
    VALUES (${email}, ${ip.full}, ${ip.key}, NULL)
    RETURNING id
  `;
  let settled = false;
  // A failed write leaves `settled` false, so the finally below deletes the
  // reservation instead of leaving a NULL row that counts as a failure.
  const settle = async (success: boolean) => {
    await sql`UPDATE login_attempts SET success = ${success} WHERE id = ${attemptId}`
      .then(() => { settled = true; })
      .catch((e) => log.error('login_attempts write failed', e));
  };
  try {
    const [{ fails, ipFails }] = await sql<{ fails: number; ipFails: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM login_attempts
          WHERE email = ${email} AND success IS NOT TRUE AND id <> ${attemptId}
            AND attempted_at > NOW() - INTERVAL '15 minutes'
            AND attempted_at > COALESCE(
              (SELECT MAX(attempted_at) FROM login_attempts
                WHERE email = ${email} AND success = TRUE),
              'epoch'::timestamptz)) AS fails,
        (SELECT COUNT(*)::int FROM login_attempts
          WHERE ${ipKnown} AND ip_key = ${ip.key} AND success IS NOT TRUE
            AND id <> ${attemptId}
            AND attempted_at > NOW() - INTERVAL '15 minutes') AS "ipFails"
    `;
    if (fails >= FAILED_LIMIT || ipFails >= IP_FAILED_LIMIT) {
      c.header('Retry-After', '900');
      return c.json({ error: 'too many failed attempts; try again later' }, 429);
    }

    const rows = await sql<
      {
        id: string; email: string; name: string; initials: string;
        role: string; team: string | null; language: string;
        defaultWarehouseId: string | null;
        preferences: Record<string, unknown>; password_hash: string;
      }[]
    >`
      SELECT id, email, name, initials, role, team, language,
             default_warehouse_id AS "defaultWarehouseId",
             COALESCE(preferences, '{}'::jsonb) AS preferences,
             password_hash
      FROM users
      WHERE email = ${email} AND active = TRUE
      LIMIT 1
    `;
    const u = rows[0];
    if (!u) {
      // Burn the same bcrypt work as the known-user path so response timing
      // doesn't reveal whether the email exists (fixed hash of a throwaway value).
      await verifyPassword(password, '$2a$10$/fcBigHOjk6nVxcvSz4qvephw3ZjwoDPD5zFkLsPu4mMpgzGnlt9G');
      await settle(false);
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const ok = await verifyPassword(password, u.password_hash);
    await settle(ok);
    if (!ok) return c.json({ error: 'Invalid credentials' }, 401);

    await sql`UPDATE users SET last_seen_at = NOW() WHERE id = ${u.id}`;

    const { raw: refreshRaw, familyId } = await issueRefresh(sql, u.id);
    const token = await signToken(c.env, { id: u.id, email: u.email, role: u.role }, familyId);
    setAuthCookies(c, c.env as Env, token, refreshRaw);
    return c.json({
      user: {
        id: u.id, email: u.email, name: u.name, initials: u.initials,
        role: u.role, team: u.team, language: u.language,
        defaultWarehouseId: u.defaultWarehouseId,
        preferences: u.preferences ?? {},
      },
    });
  } finally {
    if (!settled) {
      await sql`DELETE FROM login_attempts WHERE id = ${attemptId}`
        .catch((e) => log.error('login_attempts cleanup failed', e));
    }
  }
});

// Demo-only: list purchaser/manager accounts so the role-picker login screen
// can render avatars. This enumerates valid login emails, so it is FAIL-CLOSED:
// BOTH conditions must hold — ENABLE_DEMO_ACCOUNTS=true AND NODE_ENV!='production'.
// Returns 404 (not 403) when not enabled so the endpoint is invisible to attackers.
// A misconfigured prod with NODE_ENV unset will NOT leak because the flag must
// be explicitly set to 'true'.
auth.get('/demo-accounts', async (c) => {
  const env = c.env as Env;
  const enabled = env.ENABLE_DEMO_ACCOUNTS === 'true' && env.NODE_ENV !== 'production';
  if (!enabled) return c.json({ error: 'Not found' }, 404);
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, email, name, initials, role, team
    FROM users
    WHERE role IN ('purchaser','manager')
    ORDER BY role DESC, name
  `;
  return c.json({ users: rows });
});

auth.post('/refresh', async (c) => {
  const raw = getCookie(c, 'rt');
  if (!raw) return c.json({ error: 'no refresh token' }, 401);

  const sql = getDb(c.env);
  const res = await rotateRefresh(sql, raw);
  if (!res.ok) {
    clearAuthCookies(c, c.env as Env);
    return c.json({ error: 'invalid refresh' }, 401);
  }

  const u = (await sql<{ id: string; email: string; role: string }[]>`
    SELECT id, email, role FROM users WHERE id = ${res.userId} AND active LIMIT 1
  `)[0];
  if (!u) {
    clearAuthCookies(c, c.env as Env);
    return c.json({ error: 'invalid refresh' }, 401);
  }

  const at = await signToken(c.env, { id: u.id, email: u.email, role: u.role }, res.familyId);
  setAuthCookies(c, c.env as Env, at, res.raw);
  return c.json({ ok: true });
});

auth.post('/logout', async (c) => {
  const raw = getCookie(c, 'rt');
  if (raw) {
    const sql = getDb(c.env);
    const hash = sha256hex(raw);
    const row = (await sql<{ family_id: string }[]>`
      SELECT family_id FROM refresh_tokens WHERE token_hash = ${hash} LIMIT 1
    `)[0];
    if (row) await revokeFamily(sql, row.family_id);
  }
  clearAuthCookies(c, c.env as Env);
  return c.json({ ok: true });
});

export default auth;
