// Manager-only members admin: list, invite, edit profile + reset password,
// toggle active. Lifted from the chat6 requirement.

import { Hono } from 'hono';
import { getDb } from '../db';
import { hashPassword } from '../auth';
import type { Env, User } from '../types';

const members = new Hono<{ Bindings: Env; Variables: { user: User } }>();

members.use('*', async (c, next) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  await next();
});

members.get('/', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT u.id, u.email, u.name, u.initials, u.role, u.team, u.phone, u.title,
           u.active, u.commission_rate::float AS commission_rate, u.created_at,
           COUNT(DISTINCT o.id)::int AS order_count,
           COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS lifetime_profit
    FROM users u
    LEFT JOIN orders o ON o.user_id = u.id
    LEFT JOIN order_lines l ON l.order_id = o.id
    GROUP BY u.id
    ORDER BY u.role DESC, u.name
  `;
  return c.json({ items: rows });
});

members.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { email: string; name: string; role: 'manager' | 'purchaser'; team?: string; phone?: string; title?: string; password?: string }
    | null;
  if (!body?.email || !body?.name || !body?.role) {
    return c.json({ error: 'email, name, role required' }, 400);
  }
  const initials = body.name.split(/\s+/).map(s => s[0]?.toUpperCase() ?? '').join('').slice(0, 2) || 'NA';
  const password = body.password || 'demo';
  const hash = await hashPassword(password);
  const sql = getDb(c.env);
  const r = await sql`
    INSERT INTO users (email, name, initials, role, team, phone, title, password_hash)
    VALUES (${body.email.toLowerCase()}, ${body.name}, ${initials}, ${body.role},
            ${body.team ?? null}, ${body.phone ?? null}, ${body.title ?? null}, ${hash})
    RETURNING id
  `;
  return c.json({ id: r[0].id, password }, 201);
});

members.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { name?: string; team?: string; phone?: string; title?: string; role?: string; commissionRate?: number; active?: boolean; password?: string }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const sql = getDb(c.env);

  await sql`
    UPDATE users SET
      name            = COALESCE(${body.name ?? null}, name),
      team            = COALESCE(${body.team ?? null}, team),
      phone           = COALESCE(${body.phone ?? null}, phone),
      title           = COALESCE(${body.title ?? null}, title),
      role            = COALESCE(${body.role ?? null}, role),
      commission_rate = COALESCE(${body.commissionRate ?? null}, commission_rate),
      active          = COALESCE(${body.active ?? null}, active)
    WHERE id = ${id}
  `;
  if (body.password) {
    const hash = await hashPassword(body.password);
    await sql`UPDATE users SET password_hash = ${hash} WHERE id = ${id}`;
  }
  return c.json({ ok: true });
});

export default members;
