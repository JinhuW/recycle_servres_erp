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

  const lines = await sql<{
    id: string; category: string; label: string; sub_label: string | null; part_number: string | null;
    qty: number; unit_price: number; condition: string | null; position: number; warehouse_short: string | null;
  }[]>`
    SELECT sol.id, sol.category, sol.label, sol.sub_label, sol.part_number,
           sol.qty, sol.unit_price::float AS unit_price, sol.condition, sol.position,
           w.short AS warehouse_short
    FROM sell_order_lines sol
    LEFT JOIN warehouses w ON w.id = sol.warehouse_id
    WHERE sol.sell_order_id = ${id}
    ORDER BY sol.position
  `;
  const subtotal = lines.reduce<number>((a, l) => a + l.qty * l.unit_price, 0);

  // Per-status evidence (note + attachments) recorded at each transition.
  // Keyed by status so the UI can show e.g. the shipping note next to the
  // "Shipped" pill and the payment proof next to "Awaiting payment".
  const metaRows = await sql<{ status: string; note: string | null; attachment_ids: string[]; recorded_at: string }[]>`
    SELECT status, note, attachment_ids, recorded_at
    FROM sell_order_status_meta WHERE sell_order_id = ${id}
  `;
  const statusMeta: Record<string, { note: string | null; attachmentIds: string[]; recordedAt: string }> = {};
  for (const m of metaRows) statusMeta[m.status] = { note: m.note, attachmentIds: m.attachment_ids, recordedAt: m.recorded_at };

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
      discount: +(subtotal * Number(head.discount_pct)).toFixed(2),
      total:    +(subtotal * (1 - Number(head.discount_pct))).toFixed(2),
      statusMeta,
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

  // Validate each line that references an inventory row: the source must
  // still be in 'Reviewing' (sellable) and the requested qty must not exceed
  // what's on the shelf. Lines without inventoryId (manual entries) skip
  // this check.
  for (const l of body.lines) {
    if (!l.inventoryId) continue;
    const inv = (await sql<{ qty: number; status: string }[]>`
      SELECT qty, status FROM order_lines WHERE id = ${l.inventoryId} LIMIT 1
    `)[0];
    if (!inv) return c.json({ error: `inventory line ${l.inventoryId} not found` }, 400);
    if (inv.status !== 'Reviewing') return c.json({ error: `inventory line not sellable (status=${inv.status})` }, 400);
    if (l.qty > inv.qty) return c.json({ error: `qty ${l.qty} exceeds inventory available ${inv.qty}` }, 400);
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

  return c.json({ ok: true, id: nextId }, 201);
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

// Sell-order lifecycle. Each forward transition into Shipped/Awaiting/Done
// must carry evidence (a note OR one or more attachment ids) — PRD §7.4.
// Transitioning to Done also flips every underlying inventory line to Done
// and writes an audit row per line, so the inventory page stays in sync.
const NEEDS_EVIDENCE = new Set(['Shipped', 'Awaiting payment', 'Done']);
const SELL_ORDER_FLOW = ['Draft', 'Shipped', 'Awaiting payment', 'Done'];

sellOrders.post('/:id/status', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { to: string; note?: string; attachmentIds?: string[] }
    | null;
  if (!body?.to) return c.json({ error: 'to is required' }, 400);
  if (!SELL_ORDER_FLOW.includes(body.to)) return c.json({ error: `unknown status: ${body.to}` }, 400);

  if (NEEDS_EVIDENCE.has(body.to)) {
    const hasNote = typeof body.note === 'string' && body.note.trim().length > 0;
    const hasFiles = Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0;
    if (!hasNote && !hasFiles) {
      return c.json({ error: 'note or attachments required for this status' }, 400);
    }
  }

  const sql = getDb(c.env);
  const cur = (await sql<{ status: string }[]>`SELECT status FROM sell_orders WHERE id = ${id} LIMIT 1`)[0];
  if (!cur) return c.json({ error: 'Not found' }, 404);
  if (cur.status === 'Done' && body.to !== 'Done') return c.json({ error: 'order is locked' }, 409);

  await sql.begin(async (tx) => {
    await tx`UPDATE sell_orders SET status = ${body.to}, updated_at = NOW() WHERE id = ${id}`;
    if (NEEDS_EVIDENCE.has(body.to)) {
      await tx`
        INSERT INTO sell_order_status_meta (sell_order_id, status, note, attachment_ids, recorded_by)
        VALUES (${id}, ${body.to}, ${body.note ?? null}, ${body.attachmentIds ?? []}, ${u.id})
        ON CONFLICT (sell_order_id, status) DO UPDATE SET
          note = EXCLUDED.note,
          attachment_ids = EXCLUDED.attachment_ids,
          recorded_at = NOW(),
          recorded_by = EXCLUDED.recorded_by
      `;
    }
    if (body.to === 'Done') {
      await tx`
        UPDATE order_lines SET status = 'Done'
        WHERE id IN (SELECT inventory_id FROM sell_order_lines WHERE sell_order_id = ${id} AND inventory_id IS NOT NULL)
      `;
      await tx`
        INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
        SELECT inventory_id, ${u.id}::uuid, 'status'::text,
               jsonb_build_object('field','status','to','Done','sellOrder',${id}::text)
        FROM sell_order_lines WHERE sell_order_id = ${id} AND inventory_id IS NOT NULL
      `;
    }
  });
  return c.json({ ok: true, status: body.to });
});

export default sellOrders;
