import { Hono } from 'hono';
import { getDb } from '../db';
import { notify } from '../lib/notify';
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
  // Effective warehouse = override on the line if present, else the parent
  // order's warehouse. Lets a manager transfer a line to a different warehouse
  // without rewriting the order.
  const whFrag       = warehouse ? sql`COALESCE(l.warehouse_id, o.warehouse_id) = ${warehouse}` : sql`TRUE`;
  const searchFrag   = search
    ? sql`(LOWER(COALESCE(l.brand,'')) LIKE '%' || ${search} || '%' OR LOWER(COALESCE(l.part_number,'')) LIKE '%' || ${search} || '%' OR LOWER(COALESCE(l.description,'')) LIKE '%' || ${search} || '%')`
    : sql`TRUE`;

  const rows = await sql`
    SELECT l.id, l.category, l.brand, l.capacity, l.type, l.classification, l.rank, l.speed,
           l.interface, l.form_factor, l.description, l.part_number, l.condition,
           l.qty, l.unit_cost::float AS unit_cost, l.sell_price::float AS sell_price,
           l.status, l.created_at, l.position,
           l.health::float AS health, l.rpm,
           o.id AS order_id, o.user_id,
           COALESCE(l.warehouse_id, o.warehouse_id) AS warehouse_id,
           u.name AS user_name, u.initials AS user_initials,
           w.short AS warehouse_short, w.region AS warehouse_region
    FROM order_lines l
    JOIN orders o ON o.id = l.order_id
    JOIN users  u ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = COALESCE(l.warehouse_id, o.warehouse_id)
    WHERE ${scopeFrag} AND ${categoryFrag} AND ${statusFrag} AND ${whFrag} AND ${searchFrag}
    ORDER BY l.created_at DESC
    LIMIT 200
  `;
  // Purchasers MUST NOT see cost or profit fields (PRD §6.8). Strip them before
  // returning. Sell price stays visible — it is not sensitive.
  if (!isManager) {
    const filtered = (rows as Record<string, unknown>[]).map(r => {
      const { unit_cost: _uc, profit: _p, margin: _m, ...rest } = r;
      return rest;
    });
    return c.json({ items: filtered });
  }
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
      l.interface, l.description, l.part_number, l.rpm,
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

// Workspace-wide aggregate by part number (PRD §5.10) — powers QuickView.
// Not scoped to purchaser-own-lines: any authenticated user gets the
// workspace totals. Does NOT return cost fields.
inventory.get('/aggregate/by-part', async (c) => {
  const pn = c.req.query('partNumber');
  if (!pn) return c.json({ error: 'partNumber is required' }, 400);
  const sql = getDb(c.env);
  const rows = (await sql<{ status: string; qty: number }[]>`
    SELECT status, COALESCE(SUM(qty), 0)::int AS qty
    FROM order_lines WHERE part_number = ${pn} GROUP BY status
  `);
  let inTransit = 0, inStock = 0;
  for (const r of rows) {
    if (r.status === 'In Transit') inTransit += r.qty;
    else if (r.status === 'Done' || r.status === 'Reviewing') inStock += r.qty;
  }
  const lineCount = (await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM order_lines WHERE part_number = ${pn}`)[0].n;
  return c.json({ partNumber: pn, inTransit, inStock, lines: lineCount });
});

// Single inventory line + its audit log.
inventory.get('/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const row = (await sql`
    SELECT l.*, l.unit_cost::float AS unit_cost, l.sell_price::float AS sell_price,
           o.id AS order_id, o.user_id,
           COALESCE(l.warehouse_id, o.warehouse_id) AS warehouse_id,
           u.name AS user_name, u.initials AS user_initials,
           w.short AS warehouse_short, w.region AS warehouse_region
    FROM order_lines l
    JOIN orders o ON o.id = l.order_id
    JOIN users  u ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = COALESCE(l.warehouse_id, o.warehouse_id)
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

  // Purchasers MUST NOT see cost or profit fields (PRD §6.8).
  if (u.role !== 'manager') {
    const r = row as Record<string, unknown>;
    delete r.unit_cost;
    delete r.profit;
    delete r.margin;
    return c.json({ item: r, events });
  }
  return c.json({ item: row, events });
});

// Sell orders that reference this inventory line as a source.
// Used by the "Linked sell orders" card on the inventory-edit page.
inventory.get('/:id/sell-orders', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  // Scope check: purchasers can only see their own lines.
  const line = (await sql`
    SELECT o.user_id FROM order_lines l JOIN orders o ON o.id = l.order_id
    WHERE l.id = ${id} LIMIT 1
  `)[0];
  if (!line) return c.json({ error: 'Not found' }, 404);
  if (u.role !== 'manager' && line.user_id !== u.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const rows = await sql`
    SELECT so.id, so.status, so.created_at,
           c.name AS customer_name,
           sol.qty, sol.unit_price::float AS unit_price
    FROM sell_order_lines sol
    JOIN sell_orders so ON so.id = sol.sell_order_id
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE sol.inventory_id = ${id}
    ORDER BY so.created_at DESC
  `;
  return c.json({ items: rows });
});

// Edit a line + write an audit event for every change.
inventory.patch('/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as
    | {
        status?: string;
        sellPrice?: number;
        unitCost?: number;
        qty?: number;
        condition?: string;
        partNumber?: string;
        health?: number | null;
        rpm?: number | null;
      }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  if (body.health !== undefined && body.health !== null && (body.health < 0 || body.health > 100)) {
    return c.json({ error: 'health must be between 0 and 100' }, 400);
  }

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
        part_number = COALESCE(${body.partNumber ?? null}, part_number),
        health      = COALESCE(${body.health ?? null}, health),
        rpm         = COALESCE(${body.rpm ?? null}, rpm)
      WHERE id = ${id}
    `;
    // One event per changed field — keeps the timeline easy to skim.
    const fields = ['status', 'sellPrice', 'unitCost', 'qty', 'condition', 'partNumber', 'health', 'rpm'] as const;
    for (const f of fields) {
      const newVal = (body as Record<string, unknown>)[f];
      if (newVal === undefined) continue;
      const beforeKey: Record<string, string> = {
        status: 'status', sellPrice: 'sell_price', unitCost: 'unit_cost',
        qty: 'qty', condition: 'condition', partNumber: 'part_number',
        health: 'health', rpm: 'rpm',
      };
      const oldVal = before[beforeKey[f]];
      if (String(oldVal) === String(newVal)) continue;
      const kind = f === 'status' ? 'status' : f === 'sellPrice' ? 'priced' : 'edited';
      const fromStr = oldVal == null ? null : String(oldVal);
      const toStr   = newVal == null ? null : String(newVal);
      await tx`
        INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
        VALUES (${id}, ${u.id}, ${kind}, ${tx.json({ field: f, from: fromStr, to: toStr })})
      `;
    }
  });

  // Margin guard rails (PRD §10): warn the manager — and drop a notification —
  // when a sell price puts the line below cost or below the 15% margin floor.
  // Computed against either the newly submitted unitCost or the row-as-loaded
  // value, so a price-only edit still uses the correct cost basis.
  const warnings: string[] = [];
  if (body.sellPrice !== undefined) {
    const cost = Number(body.unitCost ?? before.unit_cost);
    const sp = body.sellPrice;
    if (sp < cost) warnings.push('sub_cost_sell');
    const margin = sp > 0 ? ((sp - cost) / sp) : 0;
    if (margin < 0.15) {
      warnings.push('low_margin');
      await sql.begin(async (tx) => {
        await notify(tx, {
          userId: u.id,
          kind: 'low_margin',
          tone: 'warn',
          icon: 'alert',
          title: `Low margin on ${before.part_number ?? 'line'}`,
          body: `Sell ${sp} vs cost ${cost} → ${(margin * 100).toFixed(1)}% margin`,
        });
      });
    }
  }
  return c.json({ ok: true, warnings });
});

// Bulk warehouse-to-warehouse transfer. Manager-only.
//
// Body: { toWarehouseId, note?, lines: [{ id, qty }, ...] }
//
// Per line, atomically:
//   - Full move  (qty === line.qty): flip the source line's warehouse override
//                  and set status to 'In Transit'. One audit event.
//   - Partial    (qty <  line.qty): decrement source qty; insert a clone under
//                  the same order with qty=N, warehouse override, 'In Transit'.
//                  Two audit events (one per line, cross-referenced).
//
// All lines succeed together — a single validation error rolls everything back.
inventory.post('/transfer', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);

  const body = (await c.req.json().catch(() => null)) as {
    toWarehouseId?: unknown;
    note?: unknown;
    lines?: unknown;
  } | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const toWarehouseId = typeof body.toWarehouseId === 'string' ? body.toWarehouseId.trim() : '';
  if (!toWarehouseId) return c.json({ error: 'toWarehouseId is required' }, 400);

  const noteRaw = typeof body.note === 'string' ? body.note.trim() : '';
  if (noteRaw.length > 200) return c.json({ error: 'note must be ≤200 characters' }, 400);
  const note = noteRaw || null;

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return c.json({ error: 'lines must be a non-empty array' }, 400);
  }
  type ReqLine = { id: string; qty: number };
  const reqLines: ReqLine[] = [];
  for (const raw of body.lines) {
    if (!raw || typeof raw !== 'object') {
      return c.json({ error: 'each line must be an object' }, 400);
    }
    const r = raw as { id?: unknown; qty?: unknown };
    if (typeof r.id !== 'string' || !r.id) {
      return c.json({ error: 'each line needs a string id' }, 400);
    }
    if (typeof r.qty !== 'number' || !Number.isInteger(r.qty) || r.qty < 1) {
      return c.json({ error: 'each line qty must be a positive integer' }, 400);
    }
    reqLines.push({ id: r.id, qty: r.qty });
  }

  const sql = getDb(c.env);

  const dest = (await sql`SELECT id FROM warehouses WHERE id = ${toWarehouseId} LIMIT 1`)[0];
  if (!dest) return c.json({ error: `warehouse "${toWarehouseId}" not found` }, 404);

  type SourceRow = {
    id: string;
    order_id: string;
    category: string;
    brand: string | null;
    capacity: string | null;
    type: string | null;
    classification: string | null;
    rank: string | null;
    speed: string | null;
    interface: string | null;
    form_factor: string | null;
    description: string | null;
    part_number: string | null;
    condition: string;
    qty: number;
    unit_cost: string | number;
    sell_price: string | number | null;
    status: string;
    position: number;
    health: number | null;
    rpm: number | null;
    scan_image_id: string | null;
    scan_confidence: number | null;
    effective_wh: string | null;
  };

  const ids = reqLines.map((r) => r.id);
  const sources = (await sql`
    SELECT l.id, l.order_id, l.category, l.brand, l.capacity, l.type, l.classification,
           l.rank, l.speed, l.interface, l.form_factor, l.description, l.part_number,
           l.condition, l.qty, l.unit_cost, l.sell_price, l.status, l.position,
           l.health, l.rpm, l.scan_image_id, l.scan_confidence,
           COALESCE(l.warehouse_id, o.warehouse_id) AS effective_wh
    FROM order_lines l
    JOIN orders o ON o.id = l.order_id
    WHERE l.id = ANY(${ids}::uuid[])
  `) as unknown as SourceRow[];

  if (sources.length !== reqLines.length) {
    return c.json({ error: 'one or more lines not found' }, 404);
  }
  const byId = new Map(sources.map((s) => [s.id, s]));

  // Validate every line before touching anything. One bad line aborts the
  // whole submission — partial transfers across the batch are confusing.
  for (const r of reqLines) {
    const s = byId.get(r.id);
    if (!s) return c.json({ error: `line ${r.id} not found` }, 404);
    if (s.status !== 'Reviewing' && s.status !== 'Done') {
      return c.json({ error: `line ${r.id} is ${s.status}; only Reviewing/Done can be transferred` }, 400);
    }
    if (r.qty > s.qty) {
      return c.json({ error: `line ${r.id} only has ${s.qty} units` }, 400);
    }
    if (s.effective_wh === toWarehouseId) {
      return c.json({ error: `line ${r.id} is already in ${toWarehouseId}` }, 400);
    }
  }

  type ResultLine = { sourceId: string; destId: string; qty: number };
  const result: ResultLine[] = [];

  await sql.begin(async (tx) => {
    for (const r of reqLines) {
      const s = byId.get(r.id)!;
      const fromWh = s.effective_wh ?? '';

      if (r.qty === s.qty) {
        // Full move — flip the override on the existing line.
        await tx`
          UPDATE order_lines
             SET warehouse_id = ${toWarehouseId}, status = 'In Transit'
           WHERE id = ${r.id}
        `;
        await tx`
          INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
          VALUES (${r.id}, ${u.id}, 'transferred',
                  ${tx.json({ from: fromWh, to: toWarehouseId, qty: r.qty, ...(note ? { note } : {}) })})
        `;
        result.push({ sourceId: r.id, destId: r.id, qty: r.qty });
      } else {
        // Partial — decrement source, clone the rest at destination.
        await tx`
          UPDATE order_lines SET qty = qty - ${r.qty} WHERE id = ${r.id}
        `;
        const inserted = (await tx`
          INSERT INTO order_lines (
            order_id, category, brand, capacity, type, classification, rank, speed,
            interface, form_factor, description, part_number, condition,
            qty, unit_cost, sell_price, status,
            scan_image_id, scan_confidence, position,
            health, rpm, warehouse_id
          )
          VALUES (
            ${s.order_id}, ${s.category}, ${s.brand}, ${s.capacity}, ${s.type},
            ${s.classification}, ${s.rank}, ${s.speed}, ${s.interface},
            ${s.form_factor}, ${s.description}, ${s.part_number}, ${s.condition},
            ${r.qty}, ${s.unit_cost}, ${s.sell_price}, 'In Transit',
            ${s.scan_image_id}, ${s.scan_confidence}, ${s.position},
            ${s.health}, ${s.rpm}, ${toWarehouseId}
          )
          RETURNING id
        `) as unknown as Array<{ id: string }>;
        const destId = inserted[0].id;
        const detail = { from: fromWh, to: toWarehouseId, qty: r.qty, ...(note ? { note } : {}) };
        await tx`
          INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
          VALUES (${r.id}, ${u.id}, 'transferred', ${tx.json({ ...detail, peer_line_id: destId })})
        `;
        await tx`
          INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
          VALUES (${destId}, ${u.id}, 'transferred', ${tx.json({ ...detail, peer_line_id: r.id })})
        `;
        result.push({ sourceId: r.id, destId, qty: r.qty });
      }
    }
  });

  return c.json({ ok: true, lines: result });
});

export default inventory;
