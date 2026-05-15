import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const notifications = new Hono<{ Bindings: Env; Variables: { user: User } }>();

notifications.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, kind, tone, icon, title, body, unread, created_at
    FROM notifications
    WHERE user_id = ${u.id}
    ORDER BY created_at DESC
    LIMIT 50
  `;
  return c.json({
    items: rows.map(r => ({
      id: r.id, kind: r.kind, tone: r.tone, icon: r.icon,
      title: r.title, body: r.body, unread: r.unread, time: r.created_at,
    })),
    unreadCount: rows.filter(r => r.unread).length,
  });
});

notifications.post('/mark-read', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  await sql`UPDATE notifications SET unread = FALSE WHERE user_id = ${u.id} AND unread = TRUE`;
  return c.json({ ok: true });
});

// Mark a single notification as read. Scoped to the caller (user_id check in
// the WHERE clause) so users can't mark each other's items as read by id.
notifications.post('/:id/mark-read', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const r = await sql`
    UPDATE notifications SET unread = FALSE
    WHERE id = ${c.req.param('id')} AND user_id = ${u.id}
    RETURNING id
  `;
  if (r.length === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

export default notifications;
