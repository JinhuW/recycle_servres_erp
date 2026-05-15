import { Hono } from 'hono';
import { getDb } from '../db';
import { signToken, verifyPassword } from '../auth';
import type { Env } from '../types';

const auth = new Hono<{ Bindings: Env }>();

auth.post('/login', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { email?: string; password?: string }
    | null;
  if (!body?.email || !body.password) {
    return c.json({ error: 'email and password required' }, 400);
  }

  const sql = getDb(c.env);
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
    WHERE email = ${body.email.toLowerCase().trim()}
    LIMIT 1
  `;
  const u = rows[0];
  if (!u) return c.json({ error: 'Invalid credentials' }, 401);

  const ok = await verifyPassword(body.password, u.password_hash);
  if (!ok) return c.json({ error: 'Invalid credentials' }, 401);

  await sql`UPDATE users SET last_seen_at = NOW() WHERE id = ${u.id}`;

  const token = await signToken(c.env, { id: u.id, email: u.email, role: u.role });
  return c.json({
    token,
    user: {
      id: u.id, email: u.email, name: u.name, initials: u.initials,
      role: u.role, team: u.team, language: u.language,
      preferences: u.preferences ?? {},
    },
  });
});

// Demo-only: list purchaser accounts so the role-picker screen can render
// avatars without a separate admin endpoint. Safe because passwords are not
// returned and the prototype already shows these names.
auth.get('/demo-accounts', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, email, name, initials, role, team
    FROM users
    WHERE role IN ('purchaser','manager')
    ORDER BY role DESC, name
  `;
  return c.json({ users: rows });
});

export default auth;
