import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const inventory = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// List inventory with the same filters as the desktop screen.
inventory.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const isManager = u.role === 'manager';
  const category = c.req.query('category');
  const status = c.req.query('status');
  const search = c.req.query('q')?.toLowerCase().trim();
  const warehouse = c.req.query('warehouse');

  const scopeFrag    = isManager ? sql`TRUE` : sql`o.user_id = ${u.id}`;
  const categoryFrag = category ? sql`l.category = ${category}` : sql`TRUE`;
  const statusFrag   = status ? sql`l.status = ${status}` : sql`TRUE`;
  const whFrag       = warehouse ? sql`o.warehouse_id = ${warehouse}` : sql`TRUE`;
  const searchFrag   = search
    ? sql`(LOWER(COALESCE(l.brand,'')) LIKE '%' || ${search} || '%' OR LOWER(COALESCE(l.part_number,'')) LIKE '%' || ${search} || '%' OR LOWER(COALESCE(l.description,'')) LIKE '%' || ${search} || '%')`
    : sql`TRUE`;

  const rows = await sql`
    SELECT l.id, l.category, l.brand, l.capacity, l.type, l.classification, l.rank, l.speed,
           l.interface, l.form_factor, l.description, l.part_number, l.condition,
           l.qty, l.unit_cost::float AS unit_cost, l.sell_price::float AS sell_price,
           l.status, l.created_at, l.position,
           o.id AS order_id, o.user_id, o.warehouse_id,
           u.name AS user_name, u.initials AS user_initials,
           w.short AS warehouse_short, w.region AS warehouse_region
    FROM order_lines l
    JOIN orders o ON o.id = l.order_id
    JOIN users  u ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    WHERE ${scopeFrag} AND ${categoryFrag} AND ${statusFrag} AND ${whFrag} AND ${searchFrag}
    ORDER BY l.created_at DESC
    LIMIT 200
  `;
  return c.json({ items: rows });
});

// Workspace-wide audit log. Drives the "Activity log" drawer on the desktop
// Inventory page. Joins to order_lines + orders + users so the timeline can
// show item identity (part number, label) without a second round trip.
inventory.get('/events/all', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const isManager = u.role === 'manager';
  const kind = c.req.query('kind'); // created | status | priced | edited
  const search = c.req.query('q')?.toLowerCase().trim();

  const scopeFrag  = isManager ? sql`TRUE` : sql`o.user_id = ${u.id}`;
  const kindFrag   = kind ? sql`e.kind = ${kind}` : sql`TRUE`;
  const searchFrag = search
    ? sql`(
        LOWER(COALESCE(l.part_number, '')) LIKE '%' || ${search} || '%' OR
        LOWER(COALESCE(l.brand, ''))       LIKE '%' || ${search} || '%' OR
        LOWER(COALESCE(l.description, '')) LIKE '%' || ${search} || '%' OR
        LOWER(COALESCE(act.name, ''))      LIKE '%' || ${search} || '%'
      )`
    : sql`TRUE`;

  const rows = await sql`
    SELECT
      e.id, e.kind, e.detail, e.created_at,
      l.id AS line_id, l.category, l.brand, l.capacity, l.type,
      l.interface, l.description, l.part_number,
      act.name AS actor_name, act.initials AS actor_initials
    FROM inventory_events e
    JOIN order_lines l ON l.id = e.order_line_id
    JOIN orders o      ON o.id = l.order_id
    LEFT JOIN users act ON act.id = e.actor_id
    WHERE ${scopeFrag} AND ${kindFrag} AND ${searchFrag}
    ORDER BY e.created_at DESC
    LIMIT 200
  `;
  return c.json({ events: rows });
});

// Single inventory line + its audit log.
inventory.get('/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const row = (await sql`
    SELECT l.*, l.unit_cost::float AS unit_cost, l.sell_price::float AS sell_price,
           o.id AS order_id, o.user_id, o.warehouse_id,
           u.name AS user_name, u.initials AS user_initials,
           w.short AS warehouse_short, w.region AS warehouse_region
    FROM order_lines l
    JOIN orders o ON o.id = l.order_id
    JOIN users  u ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    WHERE l.id = ${id} LIMIT 1
  `)[0];
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (u.role !== 'manager' && row.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);

  const events = await sql`
    SELECT e.id, e.kind, e.detail, e.created_at, u.name AS actor_name, u.initials AS actor_initials
    FROM inventory_events e
    LEFT JOIN users u ON u.id = e.actor_id
    WHERE e.order_line_id = ${id}
    ORDER BY e.created_at DESC
  `;

  return c.json({ item: row, events });
});

// Edit a line + write an audit event for every change.
inventory.patch('/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as
    | { status?: string; sellPrice?: number; unitCost?: number; qty?: number; condition?: string; partNumber?: string }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const before = (await sql`SELECT * FROM order_lines WHERE id = ${id} LIMIT 1`)[0];
  if (!before) return c.json({ error: 'Not found' }, 404);

  // Purchasers can only edit their own lines, and not status/pricing.
  const orderRow = (await sql`SELECT user_id FROM orders WHERE id = ${before.order_id} LIMIT 1`)[0];
  if (u.role !== 'manager' && orderRow.user_id !== u.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (u.role !== 'manager' && (body.status !== undefined || body.sellPrice !== undefined)) {
    return c.json({ error: 'Only managers can change status or sell price' }, 403);
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE order_lines SET
        status      = COALESCE(${body.status ?? null}, status),
        sell_price  = COALESCE(${body.sellPrice ?? null}, sell_price),
        unit_cost   = COALESCE(${body.unitCost ?? null}, unit_cost),
        qty         = COALESCE(${body.qty ?? null}, qty),
        condition   = COALESCE(${body.condition ?? null}, condition),
        part_number = COALESCE(${body.partNumber ?? null}, part_number)
      WHERE id = ${id}
    `;
    // One event per changed field — keeps the timeline easy to skim.
    const fields = ['status', 'sellPrice', 'unitCost', 'qty', 'condition', 'partNumber'] as const;
    for (const f of fields) {
      const newVal = (body as Record<string, unknown>)[f];
      if (newVal === undefined) continue;
      const beforeKey: Record<string, string> = {
        status: 'status', sellPrice: 'sell_price', unitCost: 'unit_cost',
        qty: 'qty', condition: 'condition', partNumber: 'part_number',
      };
      const oldVal = before[beforeKey[f]];
      if (String(oldVal) === String(newVal)) continue;
      const kind = f === 'status' ? 'status' : f === 'sellPrice' ? 'priced' : 'edited';
      await tx`
        INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
        VALUES (${id}, ${u.id}, ${kind}, ${tx.json({ field: f, from: oldVal, to: newVal })})
      `;
    }
  });

  return c.json({ ok: true });
});

export default inventory;
