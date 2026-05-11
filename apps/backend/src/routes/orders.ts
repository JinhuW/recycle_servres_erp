import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, LineCategory, User } from '../types';

const orders = new Hono<{ Bindings: Env; Variables: { user: User } }>();

type LineInput = {
  category?: LineCategory;
  brand?: string | null;
  capacity?: string | null;
  type?: string | null;
  classification?: string | null;
  rank?: string | null;
  speed?: string | null;
  interface?: string | null;
  formFactor?: string | null;
  description?: string | null;
  partNumber?: string | null;
  condition?: string;
  qty: number;
  unitCost: number;
  sellPrice?: number | null;
  scanImageId?: string | null;
  scanConfidence?: number | null;
};

// ── List orders for the signed-in purchaser (or all, if manager).
orders.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const isManager = u.role === 'manager';

  const category = c.req.query('category');                 // RAM/SSD/Other
  const status = c.req.query('status');                     // mapped to line status
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200);

  // Build the query in pieces to keep dynamic filters tidy. Each fragment
  // either narrows the result set or evaluates to TRUE so the AND chain
  // composes cleanly regardless of which params are present.
  const scopeFrag    = isManager ? sql`TRUE` : sql`o.user_id = ${u.id}`;
  const categoryFrag = category ? sql`o.category = ${category}` : sql`TRUE`;
  // Per-line status filter via EXISTS so we don't inflate row counts.
  const statusFrag   = status
    ? sql`EXISTS (SELECT 1 FROM order_lines l2 WHERE l2.order_id = o.id AND l2.status = ${status})`
    : sql`TRUE`;

  const rows = await sql`
    SELECT
      o.id, o.user_id, o.category, o.payment, o.notes, o.lifecycle, o.created_at,
      o.total_cost::float AS total_cost,
      u.name AS user_name, u.initials AS user_initials,
      w.id AS warehouse_id, w.short AS warehouse_short, w.region AS warehouse_region,
      COALESCE(SUM(l.qty), 0)::int                                                  AS qty,
      COALESCE(SUM(COALESCE(l.sell_price, l.unit_cost) * l.qty), 0)::float         AS revenue,
      COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit,
      COUNT(l.id)::int                                                              AS line_count,
      array_agg(DISTINCT l.status)                                                  AS line_statuses
    FROM orders o
    JOIN users u      ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    LEFT JOIN order_lines l ON l.order_id = o.id
    WHERE ${scopeFrag} AND ${categoryFrag} AND ${statusFrag}
    GROUP BY o.id, u.name, u.initials, w.id, w.short, w.region
    ORDER BY o.created_at DESC
    LIMIT ${limit}
  `;

  return c.json({
    orders: rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      userInitials: r.user_initials,
      category: r.category,
      payment: r.payment,
      notes: r.notes,
      lifecycle: r.lifecycle,
      createdAt: r.created_at,
      totalCost: r.total_cost,
      warehouse: r.warehouse_id ? { id: r.warehouse_id, short: r.warehouse_short, region: r.warehouse_region } : null,
      qty: r.qty,
      revenue: r.revenue,
      profit: r.profit,
      lineCount: r.line_count,
      status: (r.line_statuses?.length === 1 ? r.line_statuses[0] : 'Mixed') as string,
    })),
  });
});

// ── Get a single order with all its lines.
orders.get('/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const order = (await sql`
    SELECT o.id, o.user_id, o.category, o.payment, o.notes, o.lifecycle, o.created_at,
           o.total_cost::float AS total_cost,
           u.name AS user_name, u.initials AS user_initials,
           w.id AS warehouse_id, w.short AS warehouse_short, w.region AS warehouse_region
    FROM orders o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    WHERE o.id = ${id}
    LIMIT 1
  `)[0];

  if (!order) return c.json({ error: 'Not found' }, 404);
  if (u.role !== 'manager' && order.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);

  const lines = await sql`
    SELECT id, category, brand, capacity, type, classification, rank, speed,
           interface, form_factor, description, part_number, condition, qty,
           unit_cost::float AS unit_cost, sell_price::float AS sell_price,
           status, scan_image_id, scan_confidence, position
    FROM order_lines
    WHERE order_id = ${id}
    ORDER BY position ASC
  `;

  return c.json({
    order: {
      id: order.id,
      userId: order.user_id,
      userName: order.user_name,
      userInitials: order.user_initials,
      category: order.category,
      payment: order.payment,
      notes: order.notes,
      lifecycle: order.lifecycle,
      createdAt: order.created_at,
      totalCost: order.total_cost,
      warehouse: order.warehouse_id
        ? { id: order.warehouse_id, short: order.warehouse_short, region: order.warehouse_region }
        : null,
      lines: lines.map(l => ({
        id: l.id,
        category: l.category,
        brand: l.brand,
        capacity: l.capacity,
        type: l.type,
        classification: l.classification,
        rank: l.rank,
        speed: l.speed,
        interface: l.interface,
        formFactor: l.form_factor,
        description: l.description,
        partNumber: l.part_number,
        condition: l.condition,
        qty: l.qty,
        unitCost: l.unit_cost,
        sellPrice: l.sell_price,
        status: l.status,
        scanImageId: l.scan_image_id,
        scanConfidence: l.scan_confidence,
        position: l.position,
      })),
    },
  });
});

// ── Create a new order with its lines (purchaser submits from phone).
orders.post('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as
    | {
        category: LineCategory;
        warehouseId?: string;
        payment?: 'company' | 'self';
        notes?: string;
        totalCost?: number;
        lines: LineInput[];
      }
    | null;
  if (!body || !body.category || !Array.isArray(body.lines) || body.lines.length === 0) {
    return c.json({ error: 'category and at least one line are required' }, 400);
  }
  if (!body.lines.every(l => !l.category || l.category === body.category)) {
    return c.json({ error: 'all lines must match order category' }, 400);
  }

  // Generate a human-friendly id like SO-1289 — collision-resistant via the
  // sequence of existing IDs. Good enough for this scale.
  const maxRow = (await sql`
    SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 4) AS INTEGER)), 1288) AS max
    FROM orders WHERE id LIKE 'SO-%' AND id ~ '^SO-[0-9]+$'
  `)[0] as { max: number };
  const newId = 'SO-' + (maxRow.max + 1);

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO orders (id, user_id, category, warehouse_id, payment, notes, total_cost, lifecycle)
      VALUES (
        ${newId}, ${u.id}, ${body.category},
        ${body.warehouseId ?? null}, ${body.payment ?? 'company'}, ${body.notes ?? null},
        ${body.totalCost ?? null}, 'draft'
      )
    `;
    for (let i = 0; i < body.lines.length; i++) {
      const l = body.lines[i];
      await tx`
        INSERT INTO order_lines (
          order_id, category, brand, capacity, type, classification, rank, speed,
          interface, form_factor, description, part_number, condition, qty,
          unit_cost, sell_price, status, scan_image_id, scan_confidence, position
        ) VALUES (
          ${newId}, ${l.category ?? body.category}, ${l.brand ?? null}, ${l.capacity ?? null}, ${l.type ?? null},
          ${l.classification ?? null}, ${l.rank ?? null}, ${l.speed ?? null},
          ${l.interface ?? null}, ${l.formFactor ?? null}, ${l.description ?? null},
          ${l.partNumber ?? null}, ${l.condition ?? 'Pulled — Tested'}, ${l.qty},
          ${l.unitCost}, ${l.sellPrice ?? null}, 'Draft',
          ${l.scanImageId ?? null}, ${l.scanConfidence ?? null}, ${i}
        )
      `;
    }
  });

  return c.json({ id: newId }, 201);
});

// ── Edit (manager) — update line statuses + sell prices + total cost.
orders.patch('/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const body = (await c.req.json().catch(() => null)) as
    | { lines?: { id: string; status?: string; sellPrice?: number; qty?: number; unitCost?: number }[]; totalCost?: number; notes?: string }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const existing = (await sql`SELECT user_id FROM orders WHERE id = ${id} LIMIT 1`)[0];
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (u.role !== 'manager' && existing.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);

  await sql.begin(async (tx) => {
    if (body.totalCost !== undefined || body.notes !== undefined) {
      await tx`
        UPDATE orders SET
          total_cost = COALESCE(${body.totalCost ?? null}, total_cost),
          notes      = COALESCE(${body.notes ?? null}, notes)
        WHERE id = ${id}
      `;
    }
    if (Array.isArray(body.lines)) {
      for (const l of body.lines) {
        await tx`
          UPDATE order_lines SET
            status     = COALESCE(${l.status ?? null}, status),
            sell_price = COALESCE(${l.sellPrice ?? null}, sell_price),
            qty        = COALESCE(${l.qty ?? null}, qty),
            unit_cost  = COALESCE(${l.unitCost ?? null}, unit_cost)
          WHERE id = ${l.id} AND order_id = ${id}
        `;
      }
    }
  });

  return c.json({ ok: true });
});

// Lifecycle ordering — must match workflow_stages.position.
// Purchasers may only move Draft → In Transit (and not back).
const LINE_STATUS_FOR_LIFECYCLE: Record<string, string> = {
  draft: 'Draft',
  in_transit: 'In Transit',
  reviewing: 'Reviewing',
  done: 'Done',
};

orders.post('/:id/advance', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as { toStage?: string } | null;

  const cur = (await sql`SELECT user_id, lifecycle FROM orders WHERE id = ${id} LIMIT 1`)[0] as
    | { user_id: string; lifecycle: string } | undefined;
  if (!cur) return c.json({ error: 'Not found' }, 404);
  if (u.role !== 'manager' && cur.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);

  const stages = await sql<{ id: string; position: number }[]>`
    SELECT id, position FROM workflow_stages ORDER BY position`;
  const curIdx = stages.findIndex(s => s.id === cur.lifecycle);
  let nextStageId: string;
  if (body?.toStage) {
    if (u.role !== 'manager') return c.json({ error: 'Only managers can jump stages' }, 403);
    if (!stages.find(s => s.id === body.toStage)) return c.json({ error: 'Unknown stage' }, 400);
    nextStageId = body.toStage;
  } else {
    if (curIdx < 0 || curIdx >= stages.length - 1) {
      return c.json({ error: 'Already at the final stage' }, 409);
    }
    nextStageId = stages[curIdx + 1].id;
  }
  // Purchaser can only advance Draft → in_transit.
  if (u.role !== 'manager' && !(cur.lifecycle === 'draft' && nextStageId === 'in_transit')) {
    return c.json({ error: 'Purchasers can only advance Draft to In Transit' }, 403);
  }

  const newLineStatus = LINE_STATUS_FOR_LIFECYCLE[nextStageId];
  await sql.begin(async (tx) => {
    await tx`UPDATE orders SET lifecycle = ${nextStageId} WHERE id = ${id}`;
    if (newLineStatus) {
      await tx`UPDATE order_lines SET status = ${newLineStatus} WHERE order_id = ${id}`;
      await tx`
        INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
        SELECT id, ${u.id}::uuid, 'status',
               jsonb_build_object('field','status','from',status,'to',${newLineStatus}::text)
        FROM order_lines WHERE order_id = ${id} AND status IS DISTINCT FROM ${newLineStatus}
      `;
    }
  });

  return c.json({ ok: true, lifecycle: nextStageId });
});

export default orders;
