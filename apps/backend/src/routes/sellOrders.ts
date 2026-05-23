import { Hono } from 'hono';
import type postgres from 'postgres';
import { getDb } from '../db';
import { uploadAttachment, deleteAttachment } from '../r2';
import { notify } from '../lib/notify';
import { getUploadLimits } from '../lib/settings';
import { nextHumanId } from '../lib/id-seq';
import { clampLimit, decodeCursor, encodeCursor } from '../lib/pagination';
import type { Env, User } from '../types';

const sellOrders = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// Statuses that capture per-status evidence (text note + attachments). The set
// lives in sell_order_statuses.needs_meta — fetched on demand so adding a new
// status with evidence requirements is a DB-only change.
type SqlClient = ReturnType<typeof getDb>;
async function loadMetaStatuses(sql: SqlClient): Promise<Set<string>> {
  const rows = await sql`SELECT id FROM sell_order_statuses WHERE needs_meta = TRUE`;
  return new Set(rows.map(r => r.id as string));
}

type SellLine = { inventoryId?: string; qty: number };

// Validate every inventory-backed line of a sell order. MUST run inside the
// caller's transaction: each source row is locked FOR UPDATE so a concurrent
// sell order cannot pass the same qty/sellability check and oversell (TOCTOU).
// Also enforces the one-active-sell-order-per-line invariant — a line already
// committed to an open (non-Done) sell order cannot be put on another.
// `excludeOrderId` is the sell order being edited (so a PATCH may keep its
// own already-committed lines); null for a brand-new order.
// Returns a human error string, or null when every line is sellable.
async function validateSellLines(
  tx: postgres.TransactionSql,
  lines: SellLine[],
  excludeOrderId: string | null,
): Promise<string | null> {
  for (const l of lines) {
    if (!l.inventoryId) continue; // manual line — nothing to reserve
    const inv = (await tx<{ qty: number; status: string }[]>`
      SELECT qty, status FROM order_lines WHERE id = ${l.inventoryId} LIMIT 1 FOR UPDATE
    `)[0];
    if (!inv) return `inventory line ${l.inventoryId} not found`;
    if (inv.status !== 'Reviewing' && inv.status !== 'Done')
      return `inventory line not sellable (status=${inv.status})`;
    if (l.qty > inv.qty) return `qty ${l.qty} exceeds inventory available ${inv.qty}`;
    const taken = (await tx<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM sell_order_lines sol
      JOIN sell_orders so ON so.id = sol.sell_order_id
      WHERE sol.inventory_id = ${l.inventoryId}
        AND so.status <> 'Done'
        AND (${excludeOrderId}::text IS NULL OR so.id <> ${excludeOrderId}::text)
    `)[0];
    if (taken.n > 0) return `inventory line ${l.inventoryId} is already on an open sell order`;
  }
  return null;
}

sellOrders.get('/', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const status = c.req.query('status');                 // Draft|Shipped|Awaiting payment|Done
  const statusFrag = status ? sql`so.status = ${status}` : sql`TRUE`;

  // Archived rows are soft-hidden by default — the inbox is for live work.
  // ?includeArchived=true unhides them so the manager can find a stale order
  // (and unarchive it if needed) without DB access.
  const includeArchived = c.req.query('includeArchived') === 'true';
  const archivedFrag = includeArchived ? sql`TRUE` : sql`so.archived_at IS NULL`;

  // Keyset pagination on (created_at DESC, id DESC) — same shape as
  // /api/orders. Without a LIMIT the workspace inbox returned every sell
  // order forever; eventually that's an OOM risk and a slow first paint.
  const limit = clampLimit(c.req.query('limit'), 50, 200);
  const cursor = decodeCursor(c.req.query('cursor'));
  const cursorFrag = cursor
    ? sql`AND (so.created_at, so.id) < (${cursor.ts}, ${cursor.id})`
    : sql`AND TRUE`;

  const rows = await sql`
    SELECT
      so.id, so.status, so.notes, so.created_at, so.archived_at,
      c.id AS customer_id, c.name AS customer_name, c.short_name AS customer_short,
      COUNT(sol.id)::int                                AS line_count,
      COALESCE(SUM(sol.qty), 0)::int                    AS qty,
      COALESCE(SUM(sol.qty * sol.unit_price), 0)::float AS subtotal
    FROM sell_orders so
    JOIN customers c ON c.id = so.customer_id
    LEFT JOIN sell_order_lines sol ON sol.sell_order_id = so.id
    WHERE ${statusFrag} AND ${archivedFrag} ${cursorFrag}
    GROUP BY so.id, c.id
    ORDER BY so.created_at DESC, so.id DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore
    ? encodeCursor({
        ts: (slice[slice.length - 1] as { created_at: string }).created_at,
        id: (slice[slice.length - 1] as { id: string }).id,
      })
    : null;
  const shaped = slice.map(r => ({
    id: r.id, status: r.status,
    notes: r.notes, createdAt: r.created_at,
    archivedAt: r.archived_at,
    customer: { id: r.customer_id, name: r.customer_name, short: r.customer_short },
    lineCount: r.line_count, qty: r.qty,
    subtotal: r.subtotal,
    total: r.subtotal,
  }));
  return c.json({
    rows: shaped,
    nextCursor,
    // Back-compat alias for older callers — keep `items` populated so the
    // current sell-orders inbox UI doesn't go blank while it migrates.
    items: shaped,
  });
});

sellOrders.get('/:id', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const head = (await sql<{
    id: string; status: string; notes: string | null; created_at: string;
    customer_id: string; customer_name: string; customer_short: string;
    customer_region: string;
  }[]>`
    SELECT so.id, so.status, so.notes, so.created_at,
           c.id AS customer_id, c.name AS customer_name, c.short_name AS customer_short, c.region AS customer_region
    FROM sell_orders so JOIN customers c ON c.id = so.customer_id
    WHERE so.id = ${id} LIMIT 1
  `)[0];
  if (!head) return c.json({ error: 'Not found' }, 404);

  const lines = await sql<{
    id: string; category: string; label: string; sub_label: string | null;
    part_number: string | null; qty: number; unit_price: number;
    condition: string | null; position: number; warehouse_short: string | null;
    inventory_id: string | null; warehouse_id: string | null;
    inventory_qty: number | null;
  }[]>`
    SELECT sol.id, sol.category, sol.label, sol.sub_label, sol.part_number,
           sol.qty, sol.unit_price::float AS unit_price, sol.condition, sol.position,
           sol.inventory_id, sol.warehouse_id,
           w.short AS warehouse_short,
           ol.qty AS inventory_qty
    FROM sell_order_lines sol
    LEFT JOIN warehouses w ON w.id = sol.warehouse_id
    LEFT JOIN order_lines ol ON ol.id = sol.inventory_id
    WHERE sol.sell_order_id = ${id}
    ORDER BY sol.position
  `;
  const subtotal = lines.reduce((a, l) => a + l.qty * l.unit_price, 0);

  // Pull per-status evidence (notes + attachments). The frontend expects a
  // map keyed by status with both fields flattened together.
  const metaRows = await sql`
    SELECT status, note, set_at FROM sell_order_status_meta
    WHERE sell_order_id = ${id}
  `;
  const attRows = await sql`
    SELECT id, status, filename, size_bytes, mime_type, delivery_url, uploaded_at
    FROM sell_order_status_attachments
    WHERE sell_order_id = ${id}
    ORDER BY uploaded_at
  `;
  const statusMeta: Record<string, { note: string | null; when: string | null; attachments: unknown[] }> = {};
  const metaStatusSet = await loadMetaStatuses(sql);
  for (const s of metaStatusSet) statusMeta[s] = { note: null, when: null, attachments: [] };
  for (const r of metaRows) {
    statusMeta[r.status] = { ...statusMeta[r.status], note: r.note, when: r.set_at };
  }
  for (const a of attRows) {
    statusMeta[a.status].attachments.push({
      id: a.id, filename: a.filename, size: a.size_bytes, mime: a.mime_type,
      url: a.delivery_url, uploadedAt: a.uploaded_at,
    });
  }

  return c.json({
    order: {
      id: head.id, status: head.status, notes: head.notes, createdAt: head.created_at,
      customer: { id: head.customer_id, name: head.customer_name, short: head.customer_short, region: head.customer_region },
      lines: lines.map(l => ({
        id: l.id, category: l.category, label: l.label, sub: l.sub_label, partNumber: l.part_number,
        qty: l.qty, unitPrice: l.unit_price, condition: l.condition, position: l.position,
        warehouse: l.warehouse_short,
        inventoryId: l.inventory_id, warehouseId: l.warehouse_id,
        maxQty: l.inventory_qty ?? l.qty,
        lineTotal: +(l.qty * l.unit_price).toFixed(2),
      })),
      subtotal: +subtotal.toFixed(2),
      total:    +subtotal.toFixed(2),
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
    | { customerId: string; lines: LineIn[]; notes?: string }
    | null;
  if (!body || !body.customerId || !Array.isArray(body.lines) || body.lines.length === 0) {
    return c.json({ error: 'customerId and at least one line required' }, 400);
  }
  // Field range gates — fail fast with a clean 400 rather than letting the
  // sell_order_lines CHECK (qty>0, unit_price>=0) surface as a 500.
  for (const l of body.lines) {
    if (!Number.isInteger(l.qty) || l.qty <= 0) {
      return c.json({ error: 'qty must be a positive integer' }, 400);
    }
    if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) {
      return c.json({ error: 'unitPrice must be ≥ 0' }, 400);
    }
  }

  // Human-friendly id like SL-4001, allocated atomically (see id-seq.ts).
  // Allocated inside the transaction so a rollback also rolls back the counter.
  let nextId!: string;
  // Sellability is validated *inside* the tx (source rows locked FOR UPDATE)
  // so two concurrent orders can't both pass the same check and oversell.
  type Outcome = { code: 400; msg: string } | { code: 201 };
  let outcome: Outcome = { code: 201 };
  await sql.begin(async (tx) => {
    nextId = await nextHumanId(tx, 'SL', 'SL');
    const err = await validateSellLines(tx, body.lines, null);
    if (err) { outcome = { code: 400, msg: err }; return; } // roll back — nothing written
    await tx`
      INSERT INTO sell_orders (id, customer_id, status, notes, created_by)
      VALUES (${nextId}, ${body.customerId}, 'Draft', ${body.notes ?? null}, ${u.id})
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
  if (outcome.code !== 201) {
    const e = outcome as { code: 400; msg: string };
    return c.json({ error: e.msg }, 400);
  }

  return c.json({ ok: true, id: nextId }, 201);
});

// Edit an existing sell order. Status / discount / notes are simple COALESCE
// updates. Optionally the manager can also re-pick the customer and rewrite the
// whole line set (same builder UI as a new order) — those edits replace
// sell_order_lines wholesale and are blocked once the order is Done.
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

sellOrders.patch('/:id', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { status?: string; notes?: string;
        customerId?: string; lines?: LineIn[] }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  // Status transitions are owned exclusively by POST /:id/status — that route
  // takes a FOR UPDATE row lock + an idempotency guard, so a Done order can't
  // be reverted (or be transitioned twice from a double-submit). The PATCH
  // handler used to COALESCE `status` straight onto the row, which bypassed
  // both protections. Reject explicitly so the caller has to go through the
  // dedicated endpoint.
  if (body.status !== undefined) {
    return c.json({ error: 'Use POST /:id/status to change status' }, 400);
  }
  const sql = getDb(c.env);

  const editsStructure = body.customerId !== undefined || body.lines !== undefined;

  const current = (await sql<{ status: string }[]>`
    SELECT status FROM sell_orders WHERE id = ${id} LIMIT 1
  `)[0];
  if (!current) return c.json({ error: 'Not found' }, 404);

  // Customer / line edits are locked once the deal closes — a Done order's
  // line set is the historical record of what was sold.
  if (editsStructure && current.status === 'Done') {
    return c.json({ error: 'cannot edit lines or customer of a Done order' }, 409);
  }

  if (body.lines !== undefined && (!Array.isArray(body.lines) || body.lines.length === 0)) {
    return c.json({ error: 'at least one line required' }, 400);
  }
  // Same field range gates as POST — catch zero/negative before they reach
  // the CHECK constraint and surface as a 500.
  if (Array.isArray(body.lines)) {
    for (const l of body.lines) {
      if (!Number.isInteger(l.qty) || l.qty <= 0) {
        return c.json({ error: 'qty must be a positive integer' }, 400);
      }
      if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) {
        return c.json({ error: 'unitPrice must be ≥ 0' }, 400);
      }
    }
  }

  type Outcome = { code: 400; msg: string } | { code: 200 };
  let outcome: Outcome = { code: 200 };
  await sql.begin(async (tx) => {
    if (body.lines !== undefined) {
      // Same sellability check as POST, run inside the tx with FOR UPDATE.
      // This order is excluded so keeping its own already-committed lines
      // doesn't trip the one-open-sell-order-per-line rule.
      const err = await validateSellLines(tx, body.lines, id);
      if (err) { outcome = { code: 400, msg: err }; return; }
    }
    await tx`
      UPDATE sell_orders SET
        notes       = COALESCE(${body.notes ?? null}, notes),
        customer_id = COALESCE(${body.customerId ?? null}, customer_id),
        updated_at  = NOW()
      WHERE id = ${id}
    `;
    if (body.lines !== undefined) {
      await tx`DELETE FROM sell_order_lines WHERE sell_order_id = ${id}`;
      for (let i = 0; i < body.lines.length; i++) {
        const l = body.lines[i];
        await tx`
          INSERT INTO sell_order_lines
            (sell_order_id, inventory_id, category, label, sub_label, part_number,
             qty, unit_price, warehouse_id, condition, position)
          VALUES
            (${id}, ${l.inventoryId ?? null}, ${l.category}, ${l.label},
             ${l.subLabel ?? null}, ${l.partNumber ?? null},
             ${l.qty}, ${l.unitPrice},
             ${l.warehouseId ?? null}, ${l.condition ?? null}, ${i})
        `;
      }
    }
  });
  if (outcome.code !== 200) {
    const e = outcome as { code: 400; msg: string };
    return c.json({ error: e.msg }, 400);
  }
  return c.json({ ok: true });
});

// ─── Per-status evidence (note + attachments) ──────────────────────────────
// Three endpoints; all keyed by (sell_order_id, status) where status is one of
// Shipped / Awaiting payment / Done. The frontend's StatusChangeDialog hits
// these live (not on Save), so files persist even if the user cancels the
// surrounding status change.

// Upsert the text note for a single (order, status).
sellOrders.put('/:id/status-meta/:status', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const status = c.req.param('status');
  const body = (await c.req.json().catch(() => null)) as { note?: string | null } | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const sql = getDb(c.env);
  const metaStatusSet = await loadMetaStatuses(sql);
  if (!metaStatusSet.has(status)) return c.json({ error: 'invalid status' }, 400);

  // Ensure the order exists; otherwise the FK upsert silently inserts.
  const exists = (await sql`SELECT 1 FROM sell_orders WHERE id = ${id} LIMIT 1`)[0];
  if (!exists) return c.json({ error: 'Not found' }, 404);

  const note = (body.note ?? '').trim() || null;
  await sql`
    INSERT INTO sell_order_status_meta (sell_order_id, status, note, set_by)
    VALUES (${id}, ${status}, ${note}, ${u.id})
    ON CONFLICT (sell_order_id, status)
    DO UPDATE SET note = EXCLUDED.note, set_at = NOW(), set_by = EXCLUDED.set_by
  `;
  return c.json({ ok: true });
});

// Upload one attachment for (order, status). Multipart with field `file`.
sellOrders.post('/:id/status-meta/:status/attachments', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const status = c.req.param('status');

  const sql = getDb(c.env);
  const metaStatusSet = await loadMetaStatuses(sql);
  if (!metaStatusSet.has(status)) return c.json({ error: 'invalid status' }, 400);
  const exists = (await sql`SELECT 1 FROM sell_orders WHERE id = ${id} LIMIT 1`)[0];
  if (!exists) return c.json({ error: 'Not found' }, 404);

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'multipart/form-data required' }, 400);
  const file = form.get('file') as File | null;
  if (!(file instanceof File)) return c.json({ error: 'file is required' }, 400);
  // Size cap is workspace-configurable (workspace_settings.upload_max_bytes).
  const { maxBytes, allowedMime } = await getUploadLimits(sql);
  // These files land in the PUBLIC R2 bucket and are served with their
  // declared Content-Type — an unchecked HTML/SVG is a stored-XSS vector.
  // A missing type is rejected (not allowed through as octet-stream).
  if (!file.type || !allowedMime.has(file.type)) {
    return c.json({ error: `unsupported file type: ${file.type || 'unknown'}` }, 415);
  }
  if (file.size > maxBytes) {
    return c.json({ error: `file too large (max ${maxBytes} bytes)` }, 413);
  }

  const uploaded = await uploadAttachment(c.env, file, `sell-orders/${id}/${status}`)
    .catch(e => { console.error('attachment upload', e); return null; });
  if (!uploaded) return c.json({ error: 'upload failed' }, 502);

  const row = (await sql`
    INSERT INTO sell_order_status_attachments
      (sell_order_id, status, filename, size_bytes, mime_type, storage_key, delivery_url, uploaded_by)
    VALUES
      (${id}, ${status}, ${file.name}, ${file.size},
       ${file.type || 'application/octet-stream'},
       ${uploaded.storageKey}, ${uploaded.deliveryUrl}, ${u.id})
    RETURNING id, filename, size_bytes, mime_type, delivery_url, uploaded_at
  `)[0];

  return c.json({
    attachment: {
      id: row.id,
      filename: row.filename,
      size: row.size_bytes,
      mime: row.mime_type,
      url: row.delivery_url,
      uploadedAt: row.uploaded_at,
    },
  });
});

// Remove a single attachment.
sellOrders.delete('/:id/status-meta/:status/attachments/:attachmentId', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const status = c.req.param('status');
  const attachmentId = c.req.param('attachmentId');

  const sql = getDb(c.env);
  const metaStatusSet = await loadMetaStatuses(sql);
  if (!metaStatusSet.has(status)) return c.json({ error: 'invalid status' }, 400);
  const row = (await sql`
    SELECT storage_key FROM sell_order_status_attachments
    WHERE id = ${attachmentId} AND sell_order_id = ${id} AND status = ${status}
    LIMIT 1
  `)[0] as { storage_key: string } | undefined;
  if (!row) return c.json({ error: 'Not found' }, 404);

  await deleteAttachment(c.env, row.storage_key).catch(e => console.error('r2 delete', e));
  await sql`DELETE FROM sell_order_status_attachments WHERE id = ${attachmentId}`;
  return c.json({ ok: true });
});

// Sell-order lifecycle. Each forward transition into Shipped/Awaiting/Done
// must carry evidence (a note OR one or more attachment ids) — PRD §7.4.
// Transitioning to Done also flips every underlying inventory line to Done
// and writes an audit row per line, so the inventory page stays in sync.
//
// Evidence is persisted on main's split schema (migration 0003): the text
// note lives on sell_order_status_meta (PK = sell_order_id+status, columns
// note/set_at/set_by); file evidence lives in its own table and is uploaded
// via the status-meta attachments endpoints above. `attachmentIds` here
// (generic /api/attachments rows) only needs to satisfy the evidence gate.
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
  // The current-status read, the lock check and the idempotency guard MUST
  // run inside the transaction under `FOR UPDATE`. Reading status outside the
  // tx let two concurrent Done submits (double-click / network retry) both
  // pass the guard and both consume stock. With the row locked, the second
  // request blocks until the first commits, then sees status='Done' and the
  // idempotency guard turns it into a true no-op.
  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'locked' }
    | { kind: 'idempotent'; status: string }
    | { kind: 'done' };
  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const cur = (await tx<{ status: string }[]>`
      SELECT status FROM sell_orders WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0];
    if (!cur) return { kind: 'notFound' };
    if (cur.status === 'Done' && body.to !== 'Done') return { kind: 'locked' };
    if (cur.status === body.to) return { kind: 'idempotent', status: cur.status };
    await tx`UPDATE sell_orders SET status = ${body.to}, updated_at = NOW() WHERE id = ${id}`;
    if (NEEDS_EVIDENCE.has(body.to)) {
      // Upsert the text note onto the split-schema meta row. PK is
      // (sell_order_id, status); attachments are a separate table.
      await tx`
        INSERT INTO sell_order_status_meta (sell_order_id, status, note, set_at, set_by)
        VALUES (${id}, ${body.to}, ${body.note ?? null}, NOW(), ${u.id})
        ON CONFLICT (sell_order_id, status) DO UPDATE SET
          note   = EXCLUDED.note,
          set_at = NOW(),
          set_by = EXCLUDED.set_by
      `;
    }
    if (body.to === 'Done') {
      // Closing the deal consumes stock. order_lines.qty carries a
      // CHECK (qty > 0) constraint, so a sold-out line can't drop to 0 —
      // instead it flips to status 'Sold' (the in-stock aggregates key off
      // status, so a Sold line falls out regardless of its retained qty).
      // Partially-sold lines just lose the sold qty and stay sellable.
      // Aggregated by inventory_id so multiple lines hitting the same source
      // net out; <= 0 covers exact and (defensively) over-consumption.
      const sold = await tx<{ line_id: string; remaining: number; sold: number }[]>`
        UPDATE order_lines ol
           SET qty    = CASE WHEN ol.qty - s.q <= 0 THEN ol.qty ELSE ol.qty - s.q END,
               status = CASE WHEN ol.qty - s.q <= 0 THEN 'Sold' ELSE ol.status END
          FROM (
            SELECT inventory_id, SUM(qty)::int AS q
            FROM sell_order_lines
            WHERE sell_order_id = ${id} AND inventory_id IS NOT NULL
            GROUP BY inventory_id
          ) s
         WHERE s.inventory_id = ol.id
        RETURNING ol.id AS line_id,
                  CASE WHEN ol.status = 'Sold' THEN 0 ELSE ol.qty END AS remaining,
                  s.q AS sold
      `;
      for (const r of sold) {
        await tx`
          INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
          VALUES (${r.line_id}, ${u.id}, 'sold',
                  ${tx.json({ soldQty: r.sold, remainingQty: r.remaining, sellOrder: id })})
        `;
      }
      // Tell each purchaser whose lines just closed that a commission is ready.
      // DISTINCT because one purchaser may have supplied multiple lines on the
      // same sell order — we only want one notification per submitter.
      const submitters = await tx<{ user_id: string }[]>`
        SELECT DISTINCT o.user_id
        FROM sell_order_lines sol
        JOIN order_lines l ON l.id = sol.inventory_id
        JOIN orders o ON o.id = l.order_id
        WHERE sol.sell_order_id = ${id} AND sol.inventory_id IS NOT NULL
      `;
      for (const s of submitters) {
        await notify(tx, {
          userId: s.user_id,
          kind: 'payment_received',
          tone: 'pos',
          icon: 'cash',
          title: `Sell order ${id} closed`,
          body: 'Commission ready for review.',
        });
      }
    }
    return { kind: 'done' };
  });

  if (outcome.kind === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome.kind === 'locked') return c.json({ error: 'order is locked' }, 409);
  if (outcome.kind === 'idempotent') return c.json({ ok: true, status: outcome.status });
  return c.json({ ok: true, status: body.to });
});

export default sellOrders;
