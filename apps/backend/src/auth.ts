// JWT + bcrypt helpers. Tokens are signed HS256 with env.JWT_SECRET and live
// for 14 days. We pass the token in the Authorization header (Bearer …) so
// the SPA can stash it in localStorage; mobile can stash in capacitor secure
// storage if/when we go native.

import jwt from '@tsndr/cloudflare-worker-jwt';
import bcrypt from 'bcryptjs';
import type { MiddlewareHandler } from 'hono';
import { getDb } from './db';
import type { Env, User } from './types';

const TOKEN_TTL_SEC = 14 * 24 * 60 * 60;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
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

// Hono middleware: pulls Bearer token off the request, looks up the user, and
// attaches it as c.var.user. 401s if missing/invalid.
export const authMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: { user: User };
}> = async (c, next) => {
  const header = c.req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return c.json({ error: 'Missing auth token' }, 401);

  const payload = await verifyToken(c.env, token);
  if (!payload) return c.json({ error: 'Invalid auth token' }, 401);

  const sql = getDb(c.env);
  const rows = await sql<User[]>`
    SELECT id, email, name, initials, role, team, language
    FROM users
    WHERE id = ${payload.sub}
    LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: 'User not found' }, 401);

  c.set('user', rows[0]);
  await next();
};
