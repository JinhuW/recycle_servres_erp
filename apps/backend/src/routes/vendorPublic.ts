import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env } from '../types';

const vendorPublic = new Hono<{ Bindings: Env }>();

type Link = { id: string; customer_id: string; label: string | null };

// Resolve a token to an active, non-expired link. Any miss returns null so
// callers can answer a uniform 404 (never reveal whether a token exists).
async function loadLink(sql: ReturnType<typeof getDb>, token: string): Promise<Link | null> {
  if (!token) return null;
  const rows = await sql<Link[]>`
    SELECT id, customer_id, label
    FROM vendor_links
    WHERE token = ${token} AND active = TRUE
      AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1
  `;
  return rows[0] ?? null;
}

vendorPublic.get('/:token/me', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);
  const cust = (await sql<{ name: string; short_name: string | null }[]>`
    SELECT name, short_name FROM customers WHERE id = ${link.customer_id} LIMIT 1
  `)[0];
  if (!cust) return c.json({ error: 'Not found' }, 404);
  return c.json({ customer: { name: cust.name, short: cust.short_name }, label: link.label });
});

vendorPublic.get('/:token/catalog', async (c) => {
  const sql = getDb(c.env);
  const link = await loadLink(sql, c.req.param('token'));
  if (!link) return c.json({ error: 'Not found' }, 404);

  // Best-effort touch; ignore failures.
  await sql`UPDATE vendor_links SET last_seen_at = NOW() WHERE id = ${link.id}`.catch(() => {});

  // Explicit non-cost column list. NEVER select unit_cost / sell_price /
  // profit / margin / notes / user / warehouse.
  const rows = await sql<Record<string, unknown>[]>`
    SELECT l.id, l.category, l.brand, l.capacity, l.generation, l.type,
           l.classification, l.rank, l.speed, l.interface, l.form_factor,
           l.description, l.part_number, l.condition, l.qty
    FROM order_lines l
    WHERE l.status = 'Done' AND l.qty > 0
    ORDER BY l.category, l.brand, l.created_at DESC
    LIMIT 2000
  `;
  const groups: { category: string; items: Record<string, unknown>[] }[] = [];
  for (const r of rows) {
    const cat = r.category as string;
    let g = groups.find(x => x.category === cat);
    if (!g) { g = { category: cat, items: [] }; groups.push(g); }
    g.items.push(r);
  }
  return c.json({ groups });
});

export default vendorPublic;
