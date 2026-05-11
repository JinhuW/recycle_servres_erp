import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const customers = new Hono<{ Bindings: Env; Variables: { user: User } }>();

customers.get('/', async (c) => {
  const sql = getDb(c.env);
  const search = c.req.query('q')?.toLowerCase().trim();
  const status = c.req.query('status') ?? 'all';                  // active|inactive|all
  const rows = await sql`
    SELECT c.id, c.name, c.short_name, c.contact, c.region, c.terms,
           c.credit_limit::float AS credit_limit, c.tags, c.notes, c.active,
           c.created_at,
           COALESCE(SUM(sol.qty * sol.unit_price), 0)::float AS lifetime_revenue,
           COUNT(DISTINCT so.id)::int AS order_count,
           MAX(so.created_at)         AS last_order
    FROM customers c
    LEFT JOIN sell_orders so       ON so.customer_id = c.id
    LEFT JOIN sell_order_lines sol ON sol.sell_order_id = so.id
    WHERE (
      ${search ?? null}::text IS NULL
      OR LOWER(c.name) LIKE '%' || ${search ?? ''} || '%'
      OR LOWER(COALESCE(c.short_name,'')) LIKE '%' || ${search ?? ''} || '%'
    )
    AND ( ${status} = 'all' OR (${status} = 'active' AND c.active) OR (${status} = 'inactive' AND NOT c.active) )
    GROUP BY c.id
    ORDER BY c.name
  `;
  return c.json({ items: rows });
});

customers.post('/', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as
    | { name: string; shortName?: string; contact?: string; region?: string; terms?: string; creditLimit?: number; tags?: string[]; notes?: string }
    | null;
  if (!body?.name) return c.json({ error: 'name is required' }, 400);

  const sql = getDb(c.env);
  const r = await sql`
    INSERT INTO customers (name, short_name, contact, region, terms, credit_limit, tags, notes)
    VALUES (${body.name}, ${body.shortName ?? null}, ${body.contact ?? null}, ${body.region ?? null},
            ${body.terms ?? 'Net 30'}, ${body.creditLimit ?? null}, ${body.tags ?? []}, ${body.notes ?? null})
    RETURNING id
  `;
  return c.json({ id: r[0].id }, 201);
});

customers.patch('/:id', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const sql = getDb(c.env);
  await sql`
    UPDATE customers SET
      name         = COALESCE(${body.name as string ?? null}, name),
      short_name   = COALESCE(${body.shortName as string ?? null}, short_name),
      contact      = COALESCE(${body.contact as string ?? null}, contact),
      region       = COALESCE(${body.region as string ?? null}, region),
      terms        = COALESCE(${body.terms as string ?? null}, terms),
      credit_limit = COALESCE(${body.creditLimit as number ?? null}, credit_limit),
      tags         = COALESCE(${body.tags as string[] ?? null}, tags),
      notes        = COALESCE(${body.notes as string ?? null}, notes),
      active       = COALESCE(${body.active as boolean ?? null}, active)
    WHERE id = ${id}
  `;
  return c.json({ ok: true });
});

export default customers;
