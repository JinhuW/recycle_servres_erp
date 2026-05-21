import { createHash } from 'node:crypto';
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
} from '../auth';
import type { Env } from '../types';

const auth = new Hono<{ Bindings: Env }>();

auth.post('/login', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { email?: string; password?: string }
    | null;
  if (!body?.email || !body.password) {
    return c.json({ error: 'email and password required' }, 400);
  }

  const email = body.email.toLowerCase().trim();
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    null;

  const sql = getDb(c.env);

  // Brute-force throttle: lock further attempts once an email accrues
  // FAILED_LIMIT failed logins within the window, since its last success.
  // Checked before any password work so it can't be timing-probed.
  const FAILED_LIMIT = 5;
  const recentFails = (await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM login_attempts
    WHERE email = ${email} AND success = FALSE
      AND attempted_at > NOW() - INTERVAL '15 minutes'
      AND attempted_at > COALESCE(
        (SELECT MAX(attempted_at) FROM login_attempts
          WHERE email = ${email} AND success = TRUE),
        'epoch'::timestamptz)
  `)[0].n;
  if (recentFails >= FAILED_LIMIT) {
    c.header('Retry-After', '900');
    return c.json({ error: 'too many failed attempts; try again later' }, 429);
  }

  const recordAttempt = (success: boolean) =>
    sql`INSERT INTO login_attempts (email, ip, success) VALUES (${email}, ${ip}, ${success})`
      .catch((e) => console.error('login_attempts write failed', e));

  const rows = await sql<
    {
      id: string; email: string; name: string; initials: string;
      role: string; team: string | null; language: string;
      preferences: Record<string, unknown>; password_hash: string;
    }[]
  >`
    SELECT id, email, name, initials, role, team, language,
           COALESCE(preferences, '{}'::jsonb) AS preferences,
           password_hash
    FROM users
    WHERE email = ${email} AND active = TRUE
    LIMIT 1
  `;
  const u = rows[0];
  if (!u) {
    await recordAttempt(false);
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const ok = await verifyPassword(body.password, u.password_hash);
  if (!ok) {
    await recordAttempt(false);
    return c.json({ error: 'Invalid credentials' }, 401);
  }
  await recordAttempt(true);

  await sql`UPDATE users SET last_seen_at = NOW() WHERE id = ${u.id}`;

  const token = await signToken(c.env, { id: u.id, email: u.email, role: u.role });
  const { raw: refreshRaw } = await issueRefresh(sql, u.id);
  setAuthCookies(c, c.env as Env, token, refreshRaw);
  return c.json({
    user: {
      id: u.id, email: u.email, name: u.name, initials: u.initials,
      role: u.role, team: u.team, language: u.language,
      preferences: u.preferences ?? {},
    },
  });
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

  const at = await signToken(c.env, { id: u.id, email: u.email, role: u.role });
  setAuthCookies(c, c.env as Env, at, res.raw);
  return c.json({ ok: true });
});

auth.post('/logout', async (c) => {
  const raw = getCookie(c, 'rt');
  if (raw) {
    const sql = getDb(c.env);
    const hash = createHash('sha256').update(raw).digest('hex');
    const row = (await sql<{ family_id: string }[]>`
      SELECT family_id FROM refresh_tokens WHERE token_hash = ${hash} LIMIT 1
    `)[0];
    if (row) await revokeFamily(sql, row.family_id);
  }
  clearAuthCookies(c, c.env as Env);
  return c.json({ ok: true });
});

export default auth;
