import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const sellOrders = new Hono<{ Bindings: Env; Variables: { user: User } }>();

sellOrders.get('/', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const status = c.req.query('status');                 // Draft|Shipped|Awaiting payment|Done
  const statusFrag = status ? sql`so.status = ${status}` : sql`TRUE`;

  const rows = await sql`
    SELECT
      so.id, so.status, so.discount_pct::float AS discount_pct, so.notes, so.created_at,
      c.id AS customer_id, c.name AS customer_name, c.short_name AS customer_short, c.terms AS customer_terms,
      COUNT(sol.id)::int                                AS line_count,
      COALESCE(SUM(sol.qty), 0)::int                    AS qty,
      COALESCE(SUM(sol.qty * sol.unit_price), 0)::float AS subtotal
    FROM sell_orders so
    JOIN customers c ON c.id = so.customer_id
    LEFT JOIN sell_order_lines sol ON sol.sell_order_id = so.id
    WHERE ${statusFrag}
    GROUP BY so.id, c.id
    ORDER BY so.created_at DESC
  `;
  return c.json({
    items: rows.map(r => ({
      id: r.id, status: r.status,
      discountPct: r.discount_pct, notes: r.notes, createdAt: r.created_at,
      customer: { id: r.customer_id, name: r.customer_name, short: r.customer_short, terms: r.customer_terms },
      lineCount: r.line_count, qty: r.qty,
      subtotal: r.subtotal,
      discount: +(r.subtotal * r.discount_pct).toFixed(2),
      total: +(r.subtotal * (1 - r.discount_pct)).toFixed(2),
    })),
  });
});

sellOrders.get('/:id', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const head = (await sql`
    SELECT so.id, so.status, so.discount_pct::float AS discount_pct, so.notes, so.created_at,
           c.id AS customer_id, c.name AS customer_name, c.short_name AS customer_short, c.terms AS customer_terms, c.region AS customer_region
    FROM sell_orders so JOIN customers c ON c.id = so.customer_id
    WHERE so.id = ${id} LIMIT 1
  `)[0];
  if (!head) return c.json({ error: 'Not found' }, 404);

  const lines = await sql`
    SELECT sol.id, sol.category, sol.label, sol.sub_label, sol.part_number,
           sol.qty, sol.unit_price::float AS unit_price, sol.condition, sol.position,
           w.short AS warehouse_short
    FROM sell_order_lines sol
    LEFT JOIN warehouses w ON w.id = sol.warehouse_id
    WHERE sol.sell_order_id = ${id}
    ORDER BY sol.position
  `;
  const subtotal = lines.reduce((a: number, l: { qty: number; unit_price: number }) => a + l.qty * l.unit_price, 0);
  return c.json({
    order: {
      id: head.id, status: head.status, notes: head.notes, createdAt: head.created_at,
      discountPct: head.discount_pct,
      customer: { id: head.customer_id, name: head.customer_name, short: head.customer_short, terms: head.customer_terms, region: head.customer_region },
      lines: lines.map(l => ({
        id: l.id, category: l.category, label: l.label, sub: l.sub_label, partNumber: l.part_number,
        qty: l.qty, unitPrice: l.unit_price, condition: l.condition, position: l.position,
        warehouse: l.warehouse_short,
        lineTotal: +(l.qty * l.unit_price).toFixed(2),
      })),
      subtotal: +subtotal.toFixed(2),
      discount: +(subtotal * head.discount_pct).toFixed(2),
      total:    +(subtotal * (1 - head.discount_pct)).toFixed(2),
    },
  });
});

// Create a new sell order from a set of inventory lines. The manager picks
// items off the Inventory page (or the Sell Orders page's "New from inventory"
// CTA) and the draft modal POSTs the result here. We snapshot each line's
// label / part_number / category so the sell order keeps its historical shape
// even if the upstream inventory row changes later.
sellOrders.post('/', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);

  type LineIn = {
    inventoryId?: string;
    category: string;
    label: string;
    subLabel?: string | null;
    partNumber?: string | null;
    qty: number;
    unitPrice: number;
    warehouseId?: string | null;
    condition?: string | null;
  };
  const body = (await c.req.json().catch(() => null)) as
    | { customerId: string; lines: LineIn[]; notes?: string; discountPct?: number }
    | null;
  if (!body || !body.customerId || !Array.isArray(body.lines) || body.lines.length === 0) {
    return c.json({ error: 'customerId and at least one line required' }, 400);
  }

  // Generate a new SL-NNNN id by reading the current max numeric suffix. This
  // is safe under low concurrency (single manager creating orders); a Postgres
  // sequence would be the rigorous fix.
  const maxRow = (await sql`
    SELECT COALESCE(MAX(NULLIF(regexp_replace(id, '\\D', '', 'g'), '')::int), 4000) AS max_id
    FROM sell_orders
  `)[0] as { max_id: number };
  const nextId = 'SL-' + (Number(maxRow.max_id) + 1);

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO sell_orders (id, customer_id, status, discount_pct, notes, created_by)
      VALUES (${nextId}, ${body.customerId}, 'Draft', ${body.discountPct ?? 0}, ${body.notes ?? null}, ${u.id})
    `;
    for (let i = 0; i < body.lines.length; i++) {
      const l = body.lines[i];
      await tx`
        INSERT INTO sell_order_lines
          (sell_order_id, inventory_id, category, label, sub_label, part_number,
           qty, unit_price, warehouse_id, condition, position)
        VALUES
          (${nextId}, ${l.inventoryId ?? null}, ${l.category}, ${l.label},
           ${l.subLabel ?? null}, ${l.partNumber ?? null},
           ${l.qty}, ${l.unitPrice},
           ${l.warehouseId ?? null}, ${l.condition ?? null}, ${i})
      `;
    }
  });

  return c.json({ ok: true, id: nextId });
});

sellOrders.patch('/:id', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { status?: string; discountPct?: number; notes?: string }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const sql = getDb(c.env);
  await sql`
    UPDATE sell_orders SET
      status       = COALESCE(${body.status ?? null}, status),
      discount_pct = COALESCE(${body.discountPct ?? null}, discount_pct),
      notes        = COALESCE(${body.notes ?? null}, notes),
      updated_at   = NOW()
    WHERE id = ${id}
  `;
  return c.json({ ok: true });
});

export default sellOrders;
