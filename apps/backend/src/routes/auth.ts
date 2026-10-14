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
import { clientIp } from '../lib/clientIp';
import { reserveAttempt } from '../lib/loginAttempts';
import { isEmail } from '../lib/email';
import { MAX_PASSWORD_LEN } from '@recycle-erp/shared';
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
  // Bounded before anything durable: an arbitrary near-megabyte "email" was
  // otherwise lowercased, queried and written to login_attempts, and the
  // password handed to bcrypt whatever its length. No account can match
  // either, so the refusal gives nothing away.
  if (!isEmail(email) || password.length > MAX_PASSWORD_LEN) {
    return c.json({ error: 'email and password required' }, 400);
  }
  const ip = clientIp((n) => c.req.header(n));
  // Only the Worker's X-Client-IP names one caller; without it every request
  // shares a Cloudflare egress address, and a per-address budget would lock
  // everyone out together.
  const ipKnown = !!c.req.header('x-client-ip');

  const sql = getDb(c.env);

  // Brute-force throttle, shared with the password change (lib/loginAttempts):
  // reserved before the count so a concurrent burst counts against itself.
  const tooMany = () => {
    c.header('Retry-After', '900');
    return c.json({ error: 'too many failed attempts; try again later' }, 429);
  };
  const attempt = await reserveAttempt(sql, { email, ip, ipKnown });
  if (attempt.locked) return tooMany();
  try {
    const rows = await sql<
      {
        id: string; email: string; name: string; initials: string;
        role: string; team: string | null; language: string;
        defaultWarehouseId: string | null;
        preferences: Record<string, unknown>; password_hash: string;
        credential_version: number;
      }[]
    >`
      SELECT id, email, name, initials, role, team, language,
             default_warehouse_id AS "defaultWarehouseId",
             COALESCE(preferences, '{}'::jsonb) AS preferences,
             password_hash, credential_version
      FROM users
      WHERE email = ${email} AND active = TRUE
      LIMIT 1
    `;
    const u = rows[0];
    if (!u) {
      // Burn the same bcrypt work as the known-user path so response timing
      // doesn't reveal whether the email exists (fixed hash of a throwaway value).
      await verifyPassword(password, '$2a$10$/fcBigHOjk6nVxcvSz4qvephw3ZjwoDPD5zFkLsPu4mMpgzGnlt9G');
      await attempt.settle(false);
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const ok = await verifyPassword(password, u.password_hash);
    await attempt.settle(ok);
    if (!ok) return c.json({ error: 'Invalid credentials' }, 401);

    await sql`UPDATE users SET last_seen_at = NOW() WHERE id = ${u.id}`;

    const { raw: refreshRaw, familyId } = await issueRefresh(sql, u.id);
    const token = await signToken(
      c.env, { id: u.id, email: u.email, role: u.role, credentialVersion: u.credential_version }, familyId,
    );
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
    await attempt.release();
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

  const u = (await sql<{ id: string; email: string; role: string; credential_version: number }[]>`
    SELECT id, email, role, credential_version FROM users WHERE id = ${res.userId} AND active LIMIT 1
  `)[0];
  if (!u) {
    clearAuthCookies(c, c.env as Env);
    return c.json({ error: 'invalid refresh' }, 401);
  }

  const at = await signToken(
    c.env, { id: u.id, email: u.email, role: u.role, credentialVersion: u.credential_version }, res.familyId,
  );
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
