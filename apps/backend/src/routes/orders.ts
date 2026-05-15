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
  health?: number | null;
  rpm?: number | null;
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
           status, scan_image_id, scan_confidence, position,
           health::float AS health, rpm
    FROM order_lines
    WHERE order_id = ${id}
    ORDER BY position ASC
  `;

  const lineStatuses = Array.from(new Set(lines.map(l => l.status as string)));
  const status = lineStatuses.length === 1 ? lineStatuses[0] : 'Mixed';

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
      status,
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
        health: l.health,
        rpm: l.rpm,
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
  // An order is single-category: every line must match the order category
  // (a line may omit its category and inherit the order's). Completes the
  // intent of the lifecycle-default fix (parallel commit 64b885d).
  if (!body.lines.every(l => !l.category || l.category === body.category)) {
    return c.json({ error: 'all lines must match the order category' }, 400);
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
          unit_cost, sell_price, status, scan_image_id, scan_confidence, position,
          health, rpm
        ) VALUES (
          ${newId}, ${l.category ?? body.category}, ${l.brand ?? null}, ${l.capacity ?? null}, ${l.type ?? null},
          ${l.classification ?? null}, ${l.rank ?? null}, ${l.speed ?? null},
          ${l.interface ?? null}, ${l.formFactor ?? null}, ${l.description ?? null},
          ${l.partNumber ?? null}, ${l.condition ?? 'Pulled — Tested'}, ${l.qty},
          ${l.unitCost}, ${l.sellPrice ?? null}, 'Draft',
          ${l.scanImageId ?? null}, ${l.scanConfidence ?? null}, ${i},
          ${l.health ?? null}, ${l.rpm ?? null}
        )
      `;
    }
  });

  return c.json({ id: newId }, 201);
});

// ── Edit — update order meta + line item details. The order owner
// (purchaser) or a manager may PATCH; the desktop edit page gates by
// status on the client side (Draft is purchaser-editable; later stages are
// manager-only).
//
// Line shape on the wire:
//   lines:          updates for existing lines (each carries `id`)
//   addLines:       new line rows to INSERT (no `id`)
//   removeLineIds:  ids to DELETE (will 409 if referenced by sell_order_lines)
type LineFields = {
  status?: string;
  sellPrice?: number | null;
  qty?: number;
  unitCost?: number;
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
  health?: number | null;
  rpm?: number | null;
};
type LinePatch = LineFields & { id: string };

orders.patch('/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const body = (await c.req.json().catch(() => null)) as
    | {
        lines?: LinePatch[];
        addLines?: (LineFields & { category?: string })[];
        removeLineIds?: string[];
        totalCost?: number | null;
        notes?: string | null;
        warehouseId?: string | null;
        payment?: 'company' | 'self';
      }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const existing = (await sql`SELECT user_id, category FROM orders WHERE id = ${id} LIMIT 1`)[0];
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (u.role !== 'manager' && existing.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);

  try {
    await sql.begin(async (tx) => {
      const touchesOrder =
        body.totalCost !== undefined ||
        body.notes !== undefined ||
        body.warehouseId !== undefined ||
        body.payment !== undefined;
      if (touchesOrder) {
        // Nullable fields use a CASE WHEN sentinel so the client can clear
        // them by sending `null`; bare COALESCE would treat null as "no
        // change" and silently keep the old value. `payment` is a non-null
        // enum, so COALESCE is correct for it.
        const setTotalCost = body.totalCost   !== undefined ? 1 : 0;
        const setNotes     = body.notes       !== undefined ? 1 : 0;
        const setWarehouse = body.warehouseId !== undefined ? 1 : 0;
        await tx`
          UPDATE orders SET
            total_cost   = CASE WHEN ${setTotalCost}::int = 1 THEN ${body.totalCost ?? null}   ELSE total_cost   END,
            notes        = CASE WHEN ${setNotes}::int     = 1 THEN ${body.notes ?? null}       ELSE notes        END,
            warehouse_id = CASE WHEN ${setWarehouse}::int = 1 THEN ${body.warehouseId ?? null} ELSE warehouse_id END,
            payment      = COALESCE(${body.payment ?? null}, payment)
          WHERE id = ${id}
        `;
      }
      if (Array.isArray(body.removeLineIds) && body.removeLineIds.length) {
        await tx`DELETE FROM order_lines WHERE order_id = ${id} AND id = ANY(${body.removeLineIds}::uuid[])`;
      }
      if (Array.isArray(body.lines)) {
        for (const l of body.lines) {
          await tx`
            UPDATE order_lines SET
              status         = COALESCE(${l.status ?? null}, status),
              sell_price     = COALESCE(${l.sellPrice ?? null}, sell_price),
              qty            = COALESCE(${l.qty ?? null}, qty),
              unit_cost      = COALESCE(${l.unitCost ?? null}, unit_cost),
              brand          = COALESCE(${l.brand ?? null}, brand),
              capacity       = COALESCE(${l.capacity ?? null}, capacity),
              type           = COALESCE(${l.type ?? null}, type),
              classification = COALESCE(${l.classification ?? null}, classification),
              rank           = COALESCE(${l.rank ?? null}, rank),
              speed          = COALESCE(${l.speed ?? null}, speed),
              interface      = COALESCE(${l.interface ?? null}, interface),
              form_factor    = COALESCE(${l.formFactor ?? null}, form_factor),
              description    = COALESCE(${l.description ?? null}, description),
              part_number    = COALESCE(${l.partNumber ?? null}, part_number),
              condition      = COALESCE(${l.condition ?? null}, condition),
              health         = COALESCE(${l.health ?? null}, health),
              rpm            = COALESCE(${l.rpm ?? null}, rpm)
            WHERE id = ${l.id} AND order_id = ${id}
          `;
        }
      }
      if (Array.isArray(body.addLines) && body.addLines.length) {
        // New lines default to the order's category. Position appends after
        // current max so they sort to the end.
        const posRow = (await tx`SELECT COALESCE(MAX(position), -1) AS p FROM order_lines WHERE order_id = ${id}`)[0] as { p: number };
        let pos = posRow.p + 1;
        for (const l of body.addLines) {
          await tx`
            INSERT INTO order_lines (
              order_id, category, brand, capacity, type, classification, rank, speed,
              interface, form_factor, description, part_number, condition, qty,
              unit_cost, sell_price, status, position, health, rpm
            ) VALUES (
              ${id}, ${l.category ?? (existing.category as string)},
              ${l.brand ?? null}, ${l.capacity ?? null}, ${l.type ?? null},
              ${l.classification ?? null}, ${l.rank ?? null}, ${l.speed ?? null},
              ${l.interface ?? null}, ${l.formFactor ?? null}, ${l.description ?? null},
              ${l.partNumber ?? null}, ${l.condition ?? 'Pulled — Tested'}, ${l.qty ?? 1},
              ${l.unitCost ?? 0}, ${l.sellPrice ?? null}, ${l.status ?? 'In Transit'},
              ${pos++}, ${l.health ?? null}, ${l.rpm ?? null}
            )
          `;
        }
      }
    });
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? '';
    if (/foreign key|violates|referenced/i.test(msg)) {
      return c.json({ error: 'A line you tried to remove is referenced by a sell-order and cannot be deleted' }, 409);
    }
    throw e;
  }

  return c.json({ ok: true });
});

export default orders;
