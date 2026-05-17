import { Hono } from 'hono';
import { getDb } from '../db';
import { deleteAttachment } from '../r2';
import { notifyManagers } from '../lib/notify';
import { clampLimit, decodeCursor, encodeCursor, parseSort } from '../lib/pagination';
import { nextHumanId } from '../lib/id-seq';
import type { Env, LineCategory, User } from '../types';

const orders = new Hono<{ Bindings: Env; Variables: { user: User } }>();

type LineInput = {
  category?: LineCategory;
  brand?: string | null;
  capacity?: string | null;
  type?: string | null;
  generation?: string | null;
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
  const limit = clampLimit(c.req.query('limit'), 50, 200);
  const sortRaw = c.req.query('sort');
  if (sortRaw && !parseSort('orders', sortRaw)) {
    return c.json({ error: 'sort column not allowed' }, 400);
  }
  const sort = parseSort('orders', sortRaw) ?? { col: 'created_at', dir: 'desc' as const };
  const cursor = decodeCursor(c.req.query('cursor'));

  // Build the query in pieces to keep dynamic filters tidy. Each fragment
  // either narrows the result set or evaluates to TRUE so the AND chain
  // composes cleanly regardless of which params are present.
  const scopeFrag    = isManager ? sql`TRUE` : sql`o.user_id = ${u.id}`;
  const categoryFrag = category ? sql`o.category = ${category}` : sql`TRUE`;
  // Per-line status filter via EXISTS so we don't inflate row counts.
  const statusFrag   = status
    ? sql`EXISTS (SELECT 1 FROM order_lines l2 WHERE l2.order_id = o.id AND l2.status = ${status})`
    : sql`TRUE`;

  // keyset pagination: (created_at, id) lexicographic
  const cursorFrag = cursor
    ? (sort.dir === 'desc'
        ? sql`AND (o.created_at, o.id) < (${cursor.ts}, ${cursor.id})`
        : sql`AND (o.created_at, o.id) > (${cursor.ts}, ${cursor.id})`)
    : sql`AND TRUE`;

  const rows = await sql`
    SELECT
      o.id, o.user_id, o.category, o.payment, o.notes, o.lifecycle, o.created_at,
      o.total_cost::float AS total_cost,
      u.name AS user_name, u.initials AS user_initials,
      o.commission_rate::float AS commission_rate,
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
    WHERE ${scopeFrag} AND ${categoryFrag} AND ${statusFrag} ${cursorFrag}
    GROUP BY o.id, u.name, u.initials, w.id, w.short, w.region
    ORDER BY o.${sql(sort.col)} ${sql.unsafe(sort.dir.toUpperCase())}, o.id ${sql.unsafe(sort.dir.toUpperCase())}
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore
    ? encodeCursor({ ts: (slice[slice.length - 1] as { created_at: string }).created_at, id: (slice[slice.length - 1] as { id: string }).id })
    : null;

  return c.json({
    orders: slice.map(r => ({
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      userInitials: r.user_initials,
      commissionRate: r.commission_rate,
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
    nextCursor,
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
    SELECT ol.id, ol.category, ol.brand, ol.capacity, ol.generation, ol.type, ol.classification,
           ol.rank, ol.speed, ol.interface, ol.form_factor, ol.description,
           ol.part_number, ol.condition, ol.qty,
           ol.unit_cost::float AS unit_cost, ol.sell_price::float AS sell_price,
           ol.status, ol.scan_image_id, ol.scan_confidence, ol.position,
           ol.health::float AS health, ol.rpm,
           ls.delivery_url AS scan_image_url
    FROM order_lines ol
    LEFT JOIN label_scans ls ON ls.cf_image_id = ol.scan_image_id
    WHERE ol.order_id = ${id}
    ORDER BY ol.position ASC
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
        generation: l.generation,
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
        scanImageUrl: l.scan_image_url ?? null,
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

  // Enforce the category exists and is enabled (prd-gaps categories table).
  const catRow = (await sql<{ enabled: boolean }[]>`
    SELECT enabled FROM categories WHERE id = ${body.category} LIMIT 1
  `)[0];
  if (!catRow) return c.json({ error: `unknown category: ${body.category}` }, 400);
  if (!catRow.enabled) return c.json({ error: `category ${body.category} is disabled` }, 400);

  // Human-friendly id like SO-1289, allocated atomically (see id-seq.ts).
  const newId = await nextHumanId(sql, 'SO', 'SO');

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
          order_id, category, brand, capacity, generation, type, classification, rank, speed,
          interface, form_factor, description, part_number, condition, qty,
          unit_cost, sell_price, status, scan_image_id, scan_confidence, position,
          health, rpm
        ) VALUES (
          ${newId}, ${l.category ?? body.category}, ${l.brand ?? null}, ${l.capacity ?? null}, ${l.generation ?? null}, ${l.type ?? null},
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
  generation?: string | null;
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
  scanImageId?: string | null;
  scanConfidence?: number | null;
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
        commissionRate?: number | null;
      }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const existing = (await sql`SELECT user_id, category FROM orders WHERE id = ${id} LIMIT 1`)[0];
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (u.role !== 'manager' && existing.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);
  if (body.commissionRate !== undefined && u.role !== 'manager') {
    return c.json({ error: 'Only managers can set the commission rate' }, 403);
  }
  const clampedRate =
    body.commissionRate === undefined ? undefined
    : body.commissionRate === null ? null
    : Math.min(1, Math.max(0, Number(body.commissionRate)));

  // R2 keys of label scans whose lines get removed — deleted after the tx
  // commits (R2 isn't transactional; never delete on a rolled-back change).
  const removedScanKeys: string[] = [];

  try {
    await sql.begin(async (tx) => {
      const touchesOrder =
        body.totalCost !== undefined ||
        body.notes !== undefined ||
        body.warehouseId !== undefined ||
        body.payment !== undefined ||
        body.commissionRate !== undefined;
      if (touchesOrder) {
        // Nullable fields use a CASE WHEN sentinel so the client can clear
        // them by sending `null`; bare COALESCE would treat null as "no
        // change" and silently keep the old value. `payment` is a non-null
        // enum, so COALESCE is correct for it.
        const setTotalCost = body.totalCost   !== undefined ? 1 : 0;
        const setNotes     = body.notes       !== undefined ? 1 : 0;
        const setWarehouse = body.warehouseId !== undefined ? 1 : 0;
        const setCommission = body.commissionRate !== undefined ? 1 : 0;
        await tx`
          UPDATE orders SET
            total_cost   = CASE WHEN ${setTotalCost}::int = 1 THEN ${body.totalCost ?? null}   ELSE total_cost   END,
            notes        = CASE WHEN ${setNotes}::int     = 1 THEN ${body.notes ?? null}       ELSE notes        END,
            warehouse_id = CASE WHEN ${setWarehouse}::int = 1 THEN ${body.warehouseId ?? null} ELSE warehouse_id END,
            commission_rate = CASE WHEN ${setCommission}::int = 1 THEN ${clampedRate ?? null} ELSE commission_rate END,
            payment      = COALESCE(${body.payment ?? null}, payment)
          WHERE id = ${id}
        `;
      }
      if (Array.isArray(body.removeLineIds) && body.removeLineIds.length) {
        const doomed = await tx`
          SELECT scan_image_id FROM order_lines
          WHERE order_id = ${id} AND id = ANY(${body.removeLineIds}::uuid[])
            AND scan_image_id IS NOT NULL
        ` as { scan_image_id: string }[];
        for (const r of doomed) removedScanKeys.push(r.scan_image_id);
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
              generation     = COALESCE(${l.generation ?? null}, generation),
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
              order_id, category, brand, capacity, generation, type, classification, rank, speed,
              interface, form_factor, description, part_number, condition, qty,
              unit_cost, sell_price, status, scan_image_id, scan_confidence, position,
              health, rpm
            ) VALUES (
              ${id}, ${l.category ?? (existing.category as string)},
              ${l.brand ?? null}, ${l.capacity ?? null}, ${l.generation ?? null}, ${l.type ?? null},
              ${l.classification ?? null}, ${l.rank ?? null}, ${l.speed ?? null},
              ${l.interface ?? null}, ${l.formFactor ?? null}, ${l.description ?? null},
              ${l.partNumber ?? null}, ${l.condition ?? 'Pulled — Tested'}, ${l.qty ?? 1},
              ${l.unitCost ?? 0}, ${l.sellPrice ?? null}, ${l.status ?? 'In Transit'},
              ${l.scanImageId ?? null}, ${l.scanConfidence ?? null}, ${pos++},
              ${l.health ?? null}, ${l.rpm ?? null}
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

  // Best-effort R2 cleanup after a successful commit (stub/CF-era keys are
  // no-ops in deleteAttachment; a missing object delete is idempotent).
  for (const key of removedScanKeys) {
    await deleteAttachment(c.env, key).catch(e => console.error('r2 delete (line removed)', e));
  }

  return c.json({ ok: true });
});

// ── Create an empty Draft order so the submit screen can autosave lines as
// the purchaser builds them (nothing is lost if they leave mid-entry).
orders.post('/draft', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as
    | { category: LineCategory; warehouseId?: string; payment?: 'company' | 'self'; notes?: string }
    | null;
  if (!body || !body.category) {
    return c.json({ error: 'category is required' }, 400);
  }

  const newId = await nextHumanId(sql, 'SO', 'SO');

  await sql`
    INSERT INTO orders (id, user_id, category, warehouse_id, payment, notes, total_cost, lifecycle)
    VALUES (
      ${newId}, ${u.id}, ${body.category},
      ${body.warehouseId ?? null}, ${body.payment ?? 'company'}, ${body.notes ?? null},
      ${null}, 'draft'
    )
  `;

  return c.json({ id: newId }, 201);
});

// ── Delete a Draft order. Guarded: only the owner/manager, only while still
// a Draft, and never if a line has already been sold.
orders.delete('/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const existing = (await sql`
    SELECT user_id, lifecycle FROM orders WHERE id = ${id} LIMIT 1
  `)[0] as { user_id: string; lifecycle: string } | undefined;
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (u.role !== 'manager' && existing.user_id !== u.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (existing.lifecycle !== 'draft') {
    return c.json({ error: 'Only Draft orders can be deleted' }, 403);
  }

  const sold = (await sql`
    SELECT 1 FROM sell_order_lines sol
    JOIN order_lines ol ON ol.id = sol.inventory_id
    WHERE ol.order_id = ${id} LIMIT 1
  `)[0];
  if (sold) {
    return c.json({ error: 'A line in this order is referenced by a sell-order and cannot be deleted' }, 409);
  }

  const scanned = await sql`
    SELECT scan_image_id FROM order_lines
    WHERE order_id = ${id} AND scan_image_id IS NOT NULL
  ` as { scan_image_id: string }[];

  await sql`DELETE FROM orders WHERE id = ${id}`; // order_lines cascade via FK

  // Best-effort: drop the label-scan images from R2 too.
  for (const r of scanned) {
    await deleteAttachment(c.env, r.scan_image_id).catch(e => console.error('r2 delete (order deleted)', e));
  }

  return c.json({ ok: true });
});

// Canonical lifecycle ordering. The workflow_stages table was removed; this
// map's key order (draft → in_transit → reviewing → done) is the source of
// truth, matching the frontend's WORKFLOW_STAGES.
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

  const stages = Object.keys(LINE_STATUS_FOR_LIFECYCLE)
    .map((id, position) => ({ id, position }));
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
    // PRD §10: managers want to see when a purchaser finalises an order.
    // We fire this only on the first forward transition (Draft → In Transit)
    // so they aren't spammed during later manager-driven moves.
    if (nextStageId === 'in_transit') {
      await notifyManagers(tx, {
        kind: 'order_submitted',
        tone: 'info',
        icon: 'inventory',
        title: `Order ${id} submitted`,
        body: `${u.name} advanced ${id} to In Transit`,
      });
    }
  });

  return c.json({ ok: true, lifecycle: nextStageId });
});

export default orders;

