// JWT + bcrypt helpers. The access token is a short-lived (15 minute) JWT
// signed HS256 with env.JWT_SECRET and delivered only via the httpOnly `at`
// cookie (never in the response body). A separate opaque refresh token,
// delivered via the httpOnly `rt` cookie and rotated on each use, is used to
// mint fresh access tokens.

import { createHash, randomBytes } from 'node:crypto';
import jwt from '@tsndr/cloudflare-worker-jwt';
import bcrypt from 'bcryptjs';
import type { Context, MiddlewareHandler } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import type postgres from 'postgres';
import { getDb } from './db';
import type { Env, User } from './types';

const isProd = (env: Env) => env.NODE_ENV === 'production';

export function setAuthCookies(c: Context, env: Env, accessJwt: string, refreshRaw: string) {
  const secure = isProd(env);
  setCookie(c, 'at', accessJwt, { httpOnly: true, sameSite: 'Lax', secure, path: '/', maxAge: 15 * 60 });
  setCookie(c, 'rt', refreshRaw, { httpOnly: true, sameSite: 'Lax', secure, path: '/api/auth', maxAge: 14 * 24 * 60 * 60 });
}

export function clearAuthCookies(c: Context, env: Env) {
  const secure = isProd(env);
  deleteCookie(c, 'at', { path: '/', secure });
  deleteCookie(c, 'rt', { path: '/api/auth', secure });
}

const TOKEN_TTL_SEC = 15 * 60;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export function generateTempPassword(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function signToken(env: Env, user: { id: string; email: string; role: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      iss: env.JWT_ISSUER ?? 'recycle-erp',
      iat: now,
      exp: now + TOKEN_TTL_SEC,
    },
    env.JWT_SECRET,
  );
}

export async function verifyToken(env: Env, token: string): Promise<{ sub: string } | null> {
  try {
    const ok = await jwt.verify(token, env.JWT_SECRET);
    if (!ok) return null;
    const { payload } = jwt.decode(token);
    return payload as { sub: string };
  } catch {
    return null;
  }
}

// Hono middleware: reads the access JWT from the httpOnly `at` cookie, looks
// up the user, and attaches it as c.var.user. 401s if missing/invalid.
export const authMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: { user: User };
}> = async (c, next) => {
  const token = getCookie(c, 'at') || '';
  if (!token) return c.json({ error: 'Missing auth token' }, 401);

  const payload = await verifyToken(c.env, token);
  if (!payload) return c.json({ error: 'Invalid auth token' }, 401);

  const sql = getDb(c.env);
  const rows = await sql<User[]>`
    SELECT id, email, name, initials, role, team, language,
           COALESCE(preferences, '{}'::jsonb) AS preferences
    FROM users
    WHERE id = ${payload.sub} AND active = TRUE
    LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: 'User not found' }, 401);

  c.set('user', rows[0]);
  await next();
};

// ── Refresh tokens ────────────────────────────────────────────────────────
// Opaque random tokens stored hashed; rotated on each use. Reusing an already
// rotated token revokes the whole family (token-theft detection).

type AnySql = postgres.Sql | postgres.TransactionSql;

const REFRESH_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export async function issueRefresh(
  sql: AnySql,
  userId: string,
  familyId?: string,
): Promise<{ raw: string; familyId: string }> {
  const raw = randomBytes(32).toString('hex');
  const fam = familyId ?? crypto.randomUUID();
  const expires = new Date(Date.now() + REFRESH_TTL_MS);
  await sql`INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
            VALUES (${userId}, ${sha256(raw)}, ${fam}, ${expires})`;
  return { raw, familyId: fam };
}

export type RotateResult =
  | { ok: true; userId: string; raw: string; familyId: string }
  | { ok: false };

// Always called with the pooled client (route + tests); it opens its own
// transaction for the row-locked rotate, so the param is the pool Sql.
export async function rotateRefresh(sql: postgres.Sql, raw: string): Promise<RotateResult> {
  // The whole check-then-rotate must be atomic: take a row lock on the
  // refresh_tokens row (FOR UPDATE OF rt) inside a transaction so two
  // concurrent presentations of the same token serialize — the first
  // rotates, the second then sees revoked_at set and hits the reuse/theft
  // path instead of minting a second live successor. Passing an existing
  // TransactionSql just opens a savepoint, which is fine.
  return sql.begin<RotateResult>(async (tx) => {
    const row = (await tx<{
      id: string;
      user_id: string;
      family_id: string;
      revoked_at: Date | null;
      expired: boolean;
      active: boolean;
    }[]>`
      SELECT rt.id, rt.user_id, rt.family_id, rt.revoked_at,
             (rt.expires_at <= NOW()) AS expired, u.active AS active
      FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = ${sha256(raw)}
      FOR UPDATE OF rt
      LIMIT 1`)[0];
    if (!row) return { ok: false };
    if (row.revoked_at) { await revokeFamily(tx, row.family_id); return { ok: false }; }
    if (row.expired || !row.active) return { ok: false };
    await tx`UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ${row.id}`;
    const next = await issueRefresh(tx, row.user_id, row.family_id);
    return { ok: true, userId: row.user_id, raw: next.raw, familyId: row.family_id };
  });
}

export async function revokeFamily(sql: AnySql, familyId: string): Promise<void> {
  await sql`UPDATE refresh_tokens SET revoked_at = NOW()
            WHERE family_id = ${familyId} AND revoked_at IS NULL`;
}

export async function revokeUserRefreshTokens(sql: AnySql, userId: string): Promise<void> {
  await sql`UPDATE refresh_tokens SET revoked_at = NOW()
            WHERE user_id = ${userId} AND revoked_at IS NULL`;
}
