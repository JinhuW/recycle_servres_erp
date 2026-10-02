import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const notifications = new Hono<{ Bindings: Env; Variables: { user: User } }>();

notifications.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  // The unread count is its own subquery: the list is capped, so counting the
  // page would stop the badge at 50 however many are actually unread. It rides
  // the same statement because every client polls this endpoint; an empty
  // inbox returns no row, and has nothing unread.
  const rows = await sql`
    SELECT id, kind, tone, icon, title, body, unread, created_at,
           (SELECT COUNT(*)::int FROM notifications WHERE user_id = ${u.id} AND unread) AS unread_total
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
    unreadCount: (rows[0]?.unread_total as number | undefined) ?? 0,
  });
});

notifications.post('/mark-read', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  await sql`UPDATE notifications SET unread = FALSE WHERE user_id = ${u.id} AND unread = TRUE`;
  return c.json({ ok: true });
});

export default notifications;
