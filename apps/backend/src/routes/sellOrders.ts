import { Hono } from 'hono';
import type { Context } from 'hono';
import { CLOSE_REASON_IDS } from '@recycle-erp/shared';
import { getDb } from '../db';
import { uploadAttachment, deleteAttachment } from '../r2';
import { notify } from '../lib/notify';
import { getUploadLimits, getWorkspaceSetting } from '../lib/settings';
import { clampLimit, decodeCursor, encodeCursor } from '../lib/pagination';
import {
  writeSellOrderEvent, diff, META_FIELDS_SO, type AuditChange,
} from '../services/sellOrderAudit';
import { diffSellOrderLines, type SOLineSnap } from '../services/sellOrderLineMatch';
import { validateSellLines, createSellOrderDraft } from '../services/sellOrderCreate';
import {
  buildXlsxBuffer, buildXlsxWorkbook, xlsxResponse, datedFilename,
  type XlsxColumn, type XlsxSheet,
} from '../lib/xlsx';
import { invLabel, invSpec } from './inventory';
import { buildSellOrderPackingListPdf, pdfResponse, loadInvoiceLogo } from '../lib/pdf';
import {
  convertToUsd, getLatestRateToUsd, isSupportedCurrency,
  type SupportedCurrency, type FxLookup,
} from '../lib/fx';
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
      so.id, so.status, so.notes, so.created_at, so.archived_at, so.currency_code,
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
    currency: r.currency_code,
    customer: { id: r.customer_id, name: r.customer_name, short: r.customer_short },
    lineCount: r.line_count, qty: r.qty,
    // subtotal/total are USD — sol.unit_price is always the USD value, so the
    // inbox sorts apples-to-apples regardless of each order's source currency.
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

// Excel export of the sell-order list. Manager-only (every route here is).
// Reuses the same status / includeArchived filters as the JSON list but drops
// the keyset page cap so the file is the full filtered set. Registered before
// '/:id' so the literal path wins over the param route.
const SO_EXPORT_COLS: XlsxColumn[] = [
  { header: 'Order ID', key: 'id',       width: 16 },
  { header: 'Customer', key: 'customer', width: 28 },
  { header: 'Region',   key: 'region',   width: 14 },
  { header: 'Created',  key: 'created',  width: 12 },
  { header: 'Lines',    key: 'lines',    width: 8,  numFmt: '#,##0' },
  { header: 'Units',    key: 'qty',      width: 8,  numFmt: '#,##0' },
  { header: 'Total',    key: 'total',    width: 14, numFmt: '#,##0.00' },
  { header: 'Status',   key: 'status',   width: 16 },
  { header: 'Notes',    key: 'notes',    width: 40 },
];

sellOrders.get('/export', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const status = c.req.query('status');
  const includeArchived = c.req.query('includeArchived') === 'true';
  const statusFrag = status ? sql`so.status = ${status}` : sql`TRUE`;
  const archivedFrag = includeArchived ? sql`TRUE` : sql`so.archived_at IS NULL`;
  const rows = await sql`
    SELECT
      so.id, so.status, so.notes, so.created_at,
      c.name AS customer_name, c.region AS customer_region,
      COUNT(sol.id)::int                                AS line_count,
      COALESCE(SUM(sol.qty), 0)::int                    AS qty,
      COALESCE(SUM(sol.qty * sol.unit_price), 0)::float AS total
    FROM sell_orders so
    JOIN customers c ON c.id = so.customer_id
    LEFT JOIN sell_order_lines sol ON sol.sell_order_id = so.id
    WHERE ${statusFrag} AND ${archivedFrag}
    GROUP BY so.id, c.id
    ORDER BY so.created_at DESC
  `;
  const data = (rows as Record<string, unknown>[]).map((r) => ({
    id: r.id ?? '',
    customer: r.customer_name ?? '',
    region: r.customer_region ?? '',
    created: r.created_at ? new Date(r.created_at as string).toISOString().slice(0, 10) : '',
    lines: Number(r.line_count ?? 0),
    qty: Number(r.qty ?? 0),
    total: Number(r.total ?? 0),
    status: r.status ?? '',
    notes: r.notes ?? '',
  }));
  const buf = await buildXlsxBuffer('Sell orders', SO_EXPORT_COLS, data);
  return xlsxResponse(buf, datedFilename('sell-orders'));
});

sellOrders.get('/:id', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const head = (await sql<{
    id: string; status: string; notes: string | null; created_at: string;
    archived_at: string | null; close_reason_id: string | null;
    currency_code: string; fx_rate_to_usd: number; fx_source: string;
    customer_id: string; customer_name: string; customer_short: string;
    customer_region: string;
  }[]>`
    SELECT so.id, so.status, so.notes, so.created_at, so.archived_at, so.close_reason_id,
           so.currency_code, so.fx_rate_to_usd::float AS fx_rate_to_usd, so.fx_source,
           c.id AS customer_id, c.name AS customer_name, c.short_name AS customer_short, c.region AS customer_region
    FROM sell_orders so JOIN customers c ON c.id = so.customer_id
    WHERE so.id = ${id} LIMIT 1
  `)[0];
  if (!head) return c.json({ error: 'Not found' }, 404);

  const lines = await sql<{
    id: string; category: string; label: string; sub_label: string | null;
    part_number: string | null; qty: number; unit_price: number;
    source_unit_price: number | null;
    condition: string | null; position: number; warehouse_short: string | null;
    inventory_id: string | null; warehouse_id: string | null;
    inventory_qty: number | null;
  }[]>`
    SELECT sol.id, sol.category, sol.label, sol.sub_label, sol.part_number,
           sol.qty, sol.unit_price::float AS unit_price,
           sol.source_unit_price::float AS source_unit_price,
           sol.condition, sol.position,
           sol.inventory_id, sol.warehouse_id,
           w.short AS warehouse_short,
           ol.qty AS inventory_qty
    FROM sell_order_lines sol
    LEFT JOIN warehouses w ON w.id = sol.warehouse_id
    LEFT JOIN order_lines ol ON ol.id = sol.inventory_id
    WHERE sol.sell_order_id = ${id}
    ORDER BY sol.position
  `;
  // unit_price is always USD; source_unit_price holds the native price for
  // foreign-currency orders (null on USD orders, where native == USD).
  const subtotal = lines.reduce((a, l) => a + l.qty * l.unit_price, 0);
  const nativeSubtotal = lines.reduce(
    (a, l) => a + l.qty * (l.source_unit_price ?? l.unit_price), 0,
  );

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
      archivedAt: head.archived_at,
      closeReasonId: head.close_reason_id ?? null,
      currency: head.currency_code,
      fxRateToUsd: head.fx_rate_to_usd,
      fxSource: head.fx_source,
      customer: { id: head.customer_id, name: head.customer_name, short: head.customer_short, region: head.customer_region },
      lines: lines.map(l => ({
        id: l.id, category: l.category, label: l.label, sub: l.sub_label, partNumber: l.part_number,
        qty: l.qty, unitPrice: l.unit_price,
        // Native (order-currency) unit price; equals unitPrice for USD orders.
        nativeUnitPrice: l.source_unit_price ?? l.unit_price,
        condition: l.condition, position: l.position,
        warehouse: l.warehouse_short,
        inventoryId: l.inventory_id, warehouseId: l.warehouse_id,
        maxQty: l.inventory_qty ?? l.qty,
        lineTotal: +(l.qty * l.unit_price).toFixed(2),
      })),
      subtotal: +subtotal.toFixed(2),
      total:    +subtotal.toFixed(2),
      nativeSubtotal: +nativeSubtotal.toFixed(2),
      nativeTotal:    +nativeSubtotal.toFixed(2),
      statusMeta,
    },
  });
});

// Packing list — a price-free, printable pick/pack sheet for warehouse staff.
// Lines are grouped by warehouse; lines with no warehouse fall into an
// "Unassigned" group that sorts last. Manager-only like every route here.
sellOrders.get('/:id/packing-list', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const head = (await sql<{
    id: string; created_at: string;
    customer_name: string; customer_short: string;
  }[]>`
    SELECT so.id, so.created_at, c.name AS customer_name, c.short_name AS customer_short
    FROM sell_orders so JOIN customers c ON c.id = so.customer_id
    WHERE so.id = ${id} LIMIT 1
  `)[0];
  if (!head) return c.json({ error: 'Not found' }, 404);

  const lines = await sql<{
    label: string; sub_label: string | null; part_number: string | null;
    qty: number; warehouse_short: string | null; position: number;
  }[]>`
    SELECT sol.label, sol.sub_label, sol.part_number, sol.qty,
           w.short AS warehouse_short, sol.position
    FROM sell_order_lines sol
    LEFT JOIN warehouses w ON w.id = sol.warehouse_id
    WHERE sol.sell_order_id = ${id}
    ORDER BY sol.position
  `;

  // Group by warehouse, preserving line order within each group. 'Unassigned'
  // sorts last; everything else alphabetically by warehouse code.
  const UNASSIGNED = 'Unassigned';
  const byWarehouse = new Map<string, (typeof lines)[number][]>();
  for (const l of lines) {
    const key = l.warehouse_short ?? UNASSIGNED;
    if (!byWarehouse.has(key)) byWarehouse.set(key, []);
    byWarehouse.get(key)!.push(l);
  }
  const groups = [...byWarehouse.keys()]
    .sort((a, b) => {
      if (a === UNASSIGNED) return 1;
      if (b === UNASSIGNED) return -1;
      return a.localeCompare(b);
    })
    .map((warehouse) => ({
      warehouse,
      lines: byWarehouse.get(warehouse)!.map((l) => ({
        qty: l.qty,
        label: l.label,
        sub: l.sub_label ?? '',
        partNumber: l.part_number ?? '',
      })),
    }));

  const company = await getWorkspaceSetting<string>(sql, 'workspace_name', 'Recycle Servers');

  const buf = await buildSellOrderPackingListPdf({
    company,
    soId: head.id,
    date: new Date(head.created_at).toISOString().slice(0, 10),
    customer: head.customer_name,
    customerShort: head.customer_short ?? '',
    groups,
    logoPng: loadInvoiceLogo(),
  });

  return pdfResponse(buf, `${head.id}-packing-list.pdf`);
});

// Per-order spreadsheet. Mirrors the Inventory export's columns (so a sold line
// reads identically to its source stock row) and appends the realized sale
// Price / Profit / Line total. Workbook carries a Summary tab plus one tab per
// warehouse — the warehouse staff open just their own. Manager-only like every
// route here; the cost/profit columns are never for purchaser eyes anyway.
const SO_DETAIL_COLS: XlsxColumn[] = [
  { header: 'ID',           key: 'id',        width: 12 },
  { header: 'Date',         key: 'date',      width: 12 },
  { header: 'Category',     key: 'category',  width: 10 },
  { header: 'Item',         key: 'item',      width: 30 },
  { header: 'Type',         key: 'type',      width: 10 },
  { header: 'Spec',         key: 'spec',      width: 26 },
  { header: 'Rank',         key: 'rank',      width: 10 },
  { header: 'Speed',        key: 'speed',     width: 10 },
  { header: 'Part #',       key: 'part',      width: 22 },
  { header: 'Warehouse',    key: 'warehouse', width: 12 },
  { header: 'Condition',    key: 'condition', width: 12 },
  { header: 'Qty',          key: 'qty',       width: 8,  numFmt: '#,##0' },
  { header: 'Unit cost',    key: 'unitCost',  width: 12, numFmt: '#,##0.00' },
  { header: 'Sell price',   key: 'sellPrice', width: 12, numFmt: '#,##0.00' },
  // The realized sale price on this order, distinct from the inventory line's
  // listed Sell price above.
  { header: 'Price',        key: 'price',     width: 12, numFmt: '#,##0.00' },
  // Currency of the Price / Line total columns — USD, or CNY (native RMB) for
  // foreign orders. Profit / Unit cost stay USD regardless.
  { header: 'Currency',     key: 'currency',  width: 9 },
  { header: 'Profit',       key: 'profit',    width: 12, numFmt: '#,##0.00' },
  { header: 'Margin %',     key: 'margin',    width: 10, numFmt: '#,##0.0' },
  { header: 'Line total',   key: 'lineTotal', width: 13, numFmt: '#,##0.00' },
  { header: 'Submitted by', key: 'submitter', width: 18 },
  { header: 'Status',       key: 'status',    width: 14 },
  { header: 'Image URL',    key: 'imageUrl',  width: 52 },
];

sellOrders.get('/:id/spreadsheet', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const head = (await sql<{ id: string; currency_code: string; customer_name: string | null }[]>`
    SELECT so.id, so.currency_code, c.name AS customer_name
    FROM sell_orders so
    JOIN customers c ON c.id = so.customer_id
    WHERE so.id = ${id} LIMIT 1
  `)[0];
  if (!head) return c.json({ error: 'Not found' }, 404);
  // CNY orders invoice in RMB: the realized Price / Line total columns show the
  // native price (sol.source_unit_price), while Unit cost / Profit stay USD —
  // cost comes from inventory, which is always USD. The Currency column flags it.
  const isCny = head.currency_code === 'CNY';

  // Root at the sold lines and reach back to each one's source inventory row
  // (sol.inventory_id) for the descriptive columns. The joins are LEFT because a
  // line can be added by hand or via MCP with no inventory link — those rows
  // fall back to the line's own snapshot and leave cost-derived columns blank.
  const rows = (await sql`
    SELECT
      sol.qty AS sell_qty, sol.unit_price::float AS sell_unit_price,
      sol.source_unit_price::float AS source_unit_price,
      sol.label AS sol_label, sol.sub_label AS sol_sub, sol.part_number AS sol_part,
      sol.category AS sol_category, sol.condition AS sol_condition, sol.position,
      w.short AS warehouse_short,
      l.id AS inv_id, l.category, l.brand, l.capacity, l.generation, l.type,
      l.classification, l.rank, l.speed, l.interface, l.form_factor, l.description,
      l.part_number, l.condition, l.unit_cost::float AS unit_cost,
      l.sell_price::float AS sell_price, l.status, l.health::float AS health,
      l.rpm, l.created_at,
      u.name AS user_name,
      img.delivery_url AS image_url
    FROM sell_order_lines sol
    LEFT JOIN warehouses w ON w.id = sol.warehouse_id
    LEFT JOIN order_lines l ON l.id = sol.inventory_id
    LEFT JOIN orders o ON o.id = l.order_id
    LEFT JOIN users  u ON u.id = o.user_id
    LEFT JOIN LATERAL (
      SELECT ls.delivery_url
      FROM label_scans ls
      WHERE ls.cf_image_id = l.scan_image_id
      ORDER BY ls.created_at ASC
      LIMIT 1
    ) img ON TRUE
    WHERE sol.sell_order_id = ${id}
    ORDER BY sol.position
  `) as Record<string, unknown>[];

  const data = rows.map((r) => {
    const hasInv = r.inv_id != null;
    const unitCost = r.unit_cost == null ? null : Number(r.unit_cost);
    // usdPrice drives profit/margin (cost is USD); displayPrice is what the
    // Price / Line total cells show — native RMB on CNY orders, USD otherwise.
    const usdPrice = Number(r.sell_unit_price ?? 0);
    const displayPrice = isCny ? Number(r.source_unit_price ?? r.sell_unit_price ?? 0) : usdPrice;
    const qty = Number(r.sell_qty ?? 0);
    const profit = unitCost == null ? null : (usdPrice - unitCost) * qty;
    const margin = unitCost != null && usdPrice > 0 ? ((usdPrice - unitCost) / usdPrice) * 100 : null;
    const category = (r.category ?? r.sol_category ?? '') as string;
    return {
      warehouse: (r.warehouse_short ?? '') as string,
      id: hasInv ? String(r.inv_id).slice(0, 8) : '',
      date: r.created_at ? new Date(r.created_at as string).toISOString().slice(0, 10) : '',
      category,
      item: hasInv ? invLabel(r) : (r.sol_label ?? ''),
      type: category === 'RAM' ? (r.type ?? '') : '',
      spec: hasInv ? invSpec(r) : (r.sol_sub ?? ''),
      rank: r.rank ?? '',
      speed: r.speed ?? '',
      part: r.part_number ?? r.sol_part ?? '',
      condition: r.condition ?? r.sol_condition ?? '',
      qty,
      unitCost,
      sellPrice: r.sell_price == null ? null : Number(r.sell_price),
      price: displayPrice,
      currency: head.currency_code,
      profit,
      margin,
      lineTotal: +(qty * displayPrice).toFixed(2),
      submitter: r.user_name ?? '',
      status: r.status ?? '',
      imageUrl: r.image_url ?? '',
    };
  });

  // Summary tab carries every line; then one tab per warehouse, alphabetical
  // with 'Unassigned' last — the same ordering the packing list uses.
  const UNASSIGNED = 'Unassigned';
  const byWarehouse = new Map<string, typeof data>();
  for (const row of data) {
    const key = row.warehouse || UNASSIGNED;
    if (!byWarehouse.has(key)) byWarehouse.set(key, []);
    byWarehouse.get(key)!.push(row);
  }
  const warehouseSheets: XlsxSheet[] = [...byWarehouse.keys()]
    .sort((a, b) => {
      if (a === UNASSIGNED) return 1;
      if (b === UNASSIGNED) return -1;
      return a.localeCompare(b);
    })
    .map((name) => ({ name, columns: SO_DETAIL_COLS, rows: byWarehouse.get(name)! }));

  const buf = await buildXlsxWorkbook([
    { name: 'Summary', columns: SO_DETAIL_COLS, rows: data },
    ...warehouseSheets,
  ]);
  // Prefix the file with the customer so a downloads folder full of exports is
  // scannable by who, not just by order id. Strip filesystem/header-hostile
  // characters and collapse whitespace to a single dash.
  const slug = (head.customer_name ?? '').replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '-');
  return xlsxResponse(buf, datedFilename(slug ? `${head.id}-${slug}` : head.id));
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
    | { customerId: string; lines: LineIn[]; notes?: string; currency?: string }
    | null;
  if (!body || !body.customerId || !Array.isArray(body.lines) || body.lines.length === 0) {
    return c.json({ error: 'customerId and at least one line required' }, 400);
  }
  // Currency is per-order; every line is quoted in it. Default USD keeps the
  // common path unchanged. unitPrice on each line is the NATIVE price.
  const currency: SupportedCurrency = body.currency === undefined ? 'USD' : body.currency as SupportedCurrency;
  if (!isSupportedCurrency(currency)) {
    return c.json({ error: 'unsupported currency' }, 400);
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

  const result = await createSellOrderDraft(sql, {
    customerId: body.customerId,
    currency,
    notes: body.notes ?? null,
    lines: body.lines,
    actorUserId: u.id,
    source: 'manager',
  });
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true, id: result.id }, 201);
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
        customerId?: string; lines?: LineIn[]; currency?: string }
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
  // Currency can only change as part of a full line rewrite — line USD values
  // are re-snapshotted at the new rate, so the new native prices must come with
  // it. (The edit UI always resends the line set when the currency toggles.)
  if (body.currency !== undefined) {
    if (!isSupportedCurrency(body.currency)) {
      return c.json({ error: 'unsupported currency' }, 400);
    }
    if (body.lines === undefined) {
      return c.json({ error: 'lines required when changing currency' }, 400);
    }
  }
  const sql = getDb(c.env);

  const editsStructure = body.customerId !== undefined || body.lines !== undefined
    || body.currency !== undefined;

  const current = (await sql<{ status: string; currency_code: string }[]>`
    SELECT status, currency_code FROM sell_orders WHERE id = ${id} LIMIT 1
  `)[0];
  if (!current) return c.json({ error: 'Not found' }, 404);

  // Resolve FX outside the transaction (a cold-cache frankfurter fetch must not
  // run while the sell_orders row lock is held). Only a line rewrite needs a
  // fresh rate; currency is the caller's new one, else the order's stored one.
  const preFx: FxLookup | null = body.lines !== undefined
    ? await getLatestRateToUsd(sql, (body.currency ?? current.currency_code) as SupportedCurrency)
    : null;

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
    // Snapshot BEFORE state for diffing. Lock the header row so a concurrent
    // edit can't slip an event we'd then miss; lines are read consistently
    // inside the same tx so no extra lock is needed.
    const beforeHead = (await tx<{ notes: string | null; customer_id: string; currency_code: string }[]>`
      SELECT notes, customer_id, currency_code FROM sell_orders WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0];
    const beforeLines = body.lines !== undefined
      ? await tx<SOLineSnap[]>`
          SELECT inventory_id, qty, unit_price::float AS unit_price, condition,
                 category, label, sub_label, part_number, warehouse_id
          FROM sell_order_lines WHERE sell_order_id = ${id} ORDER BY position
        `
      : [];

    // A line rewrite re-snapshots every line's USD value at the current rate.
    // Currency is the explicit new one (validated above) or the order's
    // existing one when only qty/price changed. `null` until we know we need it.
    const effectiveCurrency = (body.currency ?? beforeHead.currency_code) as SupportedCurrency;
    const fx = body.lines !== undefined ? preFx : null;
    if (body.lines !== undefined) {
      // Same sellability check as POST, run inside the tx with FOR UPDATE.
      // This order is excluded so keeping its own already-committed lines
      // doesn't trip the one-open-sell-order-per-line rule.
      const err = await validateSellLines(tx, body.lines, id);
      if (err) { outcome = { code: 400, msg: err }; return; }
    }
    await tx`
      UPDATE sell_orders SET
        notes          = COALESCE(${body.notes ?? null}, notes),
        customer_id    = COALESCE(${body.customerId ?? null}, customer_id),
        currency_code  = COALESCE(${fx ? effectiveCurrency : null}, currency_code),
        fx_rate_to_usd = COALESCE(${fx ? fx.rate : null}, fx_rate_to_usd),
        fx_source      = COALESCE(${fx ? fx.source : null}, fx_source),
        updated_at     = NOW()
      WHERE id = ${id}
    `;
    if (body.lines !== undefined && fx) {
      const isNonUsd = effectiveCurrency !== 'USD';
      await tx`DELETE FROM sell_order_lines WHERE sell_order_id = ${id}`;
      for (let i = 0; i < body.lines.length; i++) {
        const l = body.lines[i];
        const unitPriceUsd = isNonUsd ? convertToUsd(l.unitPrice, fx.rate) : l.unitPrice;
        await tx`
          INSERT INTO sell_order_lines
            (sell_order_id, inventory_id, category, label, sub_label, part_number,
             qty, unit_price, warehouse_id, condition, position,
             source_currency, source_unit_price, source_fx_rate_to_usd)
          VALUES
            (${id}, ${l.inventoryId ?? null}, ${l.category}, ${l.label},
             ${l.subLabel ?? null}, ${l.partNumber ?? null},
             ${l.qty}, ${unitPriceUsd},
             ${l.warehouseId ?? null}, ${l.condition ?? null}, ${i},
             ${isNonUsd ? effectiveCurrency : null},
             ${isNonUsd ? l.unitPrice : null},
             ${isNonUsd ? fx.rate : null})
        `;
      }
    }

    // Diff events — emitted only when something actually changed.
    const afterHead = (await tx<{ notes: string | null; customer_id: string; currency_code: string }[]>`
      SELECT notes, customer_id, currency_code FROM sell_orders WHERE id = ${id} LIMIT 1
    `)[0];
    const metaChanges: AuditChange[] = diff(
      beforeHead as unknown as Record<string, unknown>,
      afterHead as unknown as Record<string, unknown>,
      META_FIELDS_SO,
    );
    if (metaChanges.length > 0) {
      await writeSellOrderEvent(tx, id, u.id, 'meta_changed', { changes: metaChanges });
    }

    if (body.lines !== undefined) {
      const afterLines = await tx<SOLineSnap[]>`
        SELECT inventory_id, qty, unit_price::float AS unit_price, condition,
               category, label, sub_label, part_number, warehouse_id
        FROM sell_order_lines WHERE sell_order_id = ${id} ORDER BY position
      `;
      const lineDiff = diffSellOrderLines(beforeLines as unknown as SOLineSnap[],
                                          afterLines as unknown as SOLineSnap[]);
      for (const snap of lineDiff.added) {
        await writeSellOrderEvent(tx, id, u.id, 'line_added', { snapshot: snap });
      }
      for (const snap of lineDiff.removed) {
        await writeSellOrderEvent(tx, id, u.id, 'line_removed', { snapshot: snap });
      }
      for (const e of lineDiff.edited) {
        await writeSellOrderEvent(tx, id, u.id, 'line_edited', {
          inventoryId: e.inventoryId, changes: e.changes, snapshot: e.snapshot,
        });
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
  await sql.begin(async (tx) => {
    const before = (await tx<{ note: string | null }[]>`
      SELECT note FROM sell_order_status_meta
      WHERE sell_order_id = ${id} AND status = ${status} LIMIT 1
    `)[0];
    await tx`
      INSERT INTO sell_order_status_meta (sell_order_id, status, note, set_by)
      VALUES (${id}, ${status}, ${note}, ${u.id})
      ON CONFLICT (sell_order_id, status)
      DO UPDATE SET note = EXCLUDED.note, set_at = NOW(), set_by = EXCLUDED.set_by
    `;
    const fromNote = before?.note ?? null;
    if (fromNote !== note) {
      await writeSellOrderEvent(tx, id, u.id, 'status_meta_changed', {
        status, field: 'note', from: fromNote, to: note,
      });
    }
  });
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

  // R2 upload happens outside the transaction — it's the slow part. A tx open
  // across it would hold a row lock for the whole upload. If the DB INSERT
  // below fails the uploaded object is orphaned in R2; r2.ts treats orphans
  // as a separate concern.
  const uploaded = await uploadAttachment(c.env, file, `sell-orders/${id}/${status}`)
    .catch(e => { console.error('attachment upload', e); return null; });
  if (!uploaded) return c.json({ error: 'upload failed' }, 502);

  const row = await sql.begin(async (tx) => {
    const r = (await tx`
      INSERT INTO sell_order_status_attachments
        (sell_order_id, status, filename, size_bytes, mime_type, storage_key, delivery_url, uploaded_by)
      VALUES
        (${id}, ${status}, ${file.name}, ${file.size},
         ${file.type || 'application/octet-stream'},
         ${uploaded.storageKey}, ${uploaded.deliveryUrl}, ${u.id})
      RETURNING id, filename, size_bytes, mime_type, delivery_url, uploaded_at
    `)[0];
    await writeSellOrderEvent(tx, id, u.id, 'status_meta_changed', {
      status, field: 'attachment_added',
      attachmentId: r.id, filename: r.filename, size: r.size_bytes, mime: r.mime_type,
    });
    return r;
  });

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

  const removed = await sql.begin(async (tx) => {
    const row = (await tx`
      SELECT storage_key, filename FROM sell_order_status_attachments
      WHERE id = ${attachmentId} AND sell_order_id = ${id} AND status = ${status}
      LIMIT 1
    `)[0] as { storage_key: string; filename: string } | undefined;
    if (!row) return null;
    await tx`DELETE FROM sell_order_status_attachments WHERE id = ${attachmentId}`;
    await writeSellOrderEvent(tx, id, u.id, 'status_meta_changed', {
      status, field: 'attachment_removed',
      attachmentId, filename: row.filename,
    });
    return row;
  });

  if (!removed) return c.json({ error: 'Not found' }, 404);
  // R2 delete happens outside the tx — same rationale as upload: slow side
  // effect, kept out of the lock window. Best-effort.
  await deleteAttachment(c.env, removed.storage_key).catch(e => console.error('r2 delete', e));
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
// Transition map is the single source of truth for what status changes
// are legal. Any open stage can jump straight to Done (the deal can be
// marked paid at any point) or to Closed. Done has no outgoing edges
// (terminal happy path). Closed has exactly one outgoing edge (reopen →
// Draft) and cannot go to Done. Adding a new status means editing this map
// + the CHECK constraint + the seed — no parallel guards elsewhere (see
// CLAUDE.md "Status guards").
const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  Draft:               new Set(['Shipped', 'Done', 'Closed']),
  Shipped:             new Set(['Awaiting payment', 'Done', 'Closed']),
  'Awaiting payment':  new Set(['Done', 'Closed']),
  Done:                new Set([]),
  Closed:              new Set(['Draft']),
};
const KNOWN_STATUSES = new Set<string>([
  'Draft', 'Shipped', 'Awaiting payment', 'Done', 'Closed',
]);
// Statuses whose entry-edge requires a note OR attachments. The DB row
// sell_order_statuses.needs_meta tracks the same idea for per-status meta
// uploads (those routes look it up dynamically); this set governs the
// transition-time evidence gate.
const NEEDS_EVIDENCE = new Set(['Shipped', 'Awaiting payment', 'Done', 'Closed']);

// Fixed close-reason taxonomy from @recycle-erp/shared (single source of
// truth, shared with the frontend picker). The SQL CHECK on
// sell_orders.close_reason_id (migration 0057) must list the same values;
// adding a reason means extending CLOSE_REASON_IDS and widening the CHECK.
const CLOSE_REASONS = new Set<string>(CLOSE_REASON_IDS);

sellOrders.post('/:id/status', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { to: string; note?: string; attachmentIds?: string[]; closeReasonId?: string }
    | null;
  if (!body?.to) return c.json({ error: 'to is required' }, 400);
  if (!KNOWN_STATUSES.has(body.to)) {
    return c.json({ error: `unknown status: ${body.to}` }, 400);
  }

  const hasNote = typeof body.note === 'string' && body.note.trim().length > 0;
  const hasFiles = Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0;

  // Static evidence gate (Shipped / Awaiting payment / Done / Closed).
  if (NEEDS_EVIDENCE.has(body.to) && !hasNote && !hasFiles) {
    return c.json({ error: 'note or attachments required for this status' }, 400);
  }
  // Close requires a structured reason in addition to evidence.
  if (body.to === 'Closed' && !body.closeReasonId) {
    return c.json({ error: 'closeReasonId is required to close' }, 400);
  }

  if (body.to === 'Closed' && !CLOSE_REASONS.has(body.closeReasonId!)) {
    return c.json({ error: 'invalid closeReasonId' }, 400);
  }

  const sql = getDb(c.env);

  // Current-status read, lock check, transition guard, and conditional
  // reopen-note gate MUST all run inside the transaction under FOR UPDATE.
  // Reading status outside the tx let two concurrent Done submits (double
  // click / network retry) both pass and both consume stock.
  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'illegal'; from: string; to: string }
    | { kind: 'idempotent'; status: string }
    | { kind: 'reopenNeedsNote' }
    | { kind: 'done' };

  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const cur = (await tx<{ status: string }[]>`
      SELECT status FROM sell_orders WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0];
    if (!cur) return { kind: 'notFound' };
    if (cur.status === body.to) return { kind: 'idempotent', status: cur.status };

    const allowed = ALLOWED_TRANSITIONS[cur.status] ?? new Set<string>();
    if (!allowed.has(body.to)) {
      return { kind: 'illegal', from: cur.status, to: body.to };
    }

    // Reopen (Closed → Draft) needs a note. We deliberately keep this
    // *out* of the global NEEDS_EVIDENCE set: a fresh Draft creation
    // doesn't need a note, so the rule is "transitions *into* Draft from
    // Closed need a note", not "Draft is a needs-evidence status".
    if (cur.status === 'Closed' && body.to === 'Draft' && !hasNote) {
      return { kind: 'reopenNeedsNote' };
    }

    // Apply the status update + (for close) the denormalized reason; (for
    // reopen) clear the reason.
    if (body.to === 'Closed') {
      await tx`
        UPDATE sell_orders
           SET status = 'Closed',
               close_reason_id = ${body.closeReasonId!},
               updated_at = NOW()
         WHERE id = ${id}
      `;
    } else if (cur.status === 'Closed' && body.to === 'Draft') {
      await tx`
        UPDATE sell_orders
           SET status = 'Draft',
               close_reason_id = NULL,
               updated_at = NOW()
         WHERE id = ${id}
      `;
    } else {
      await tx`UPDATE sell_orders SET status = ${body.to}, updated_at = NOW() WHERE id = ${id}`;
    }

    // Evidence persistence (status_meta upsert). Fires for any transition
    // INTO a meta-tracked status (Shipped / Awaiting payment / Done / Closed).
    // Draft is intentionally excluded: reopen-to-Draft notes live in
    // sell_order_events so successive reopen cycles don't overwrite each
    // other (status_meta PK is sell_order_id + status, single row per pair).
    if (NEEDS_EVIDENCE.has(body.to) && body.to !== 'Draft') {
      await tx`
        INSERT INTO sell_order_status_meta (sell_order_id, status, note, set_at, set_by)
        VALUES (${id}, ${body.to}, ${body.note ?? null}, NOW(), ${u.id})
        ON CONFLICT (sell_order_id, status) DO UPDATE SET
          note   = EXCLUDED.note,
          set_at = NOW(),
          set_by = EXCLUDED.set_by
      `;
    }

    // Audit-event writes for close + reopen. Done's audit story is the
    // inventory_events rows below; archive lives in its own handler.
    if (body.to === 'Closed') {
      await writeSellOrderEvent(tx, id, u.id, 'closed', {
        reasonId: body.closeReasonId!,
        note: body.note ?? null,
        fromStatus: cur.status,
      });
    } else if (cur.status === 'Closed' && body.to === 'Draft') {
      await writeSellOrderEvent(tx, id, u.id, 'reopened', {
        note: body.note ?? null,
        fromStatus: 'Closed',
      });
    } else {
      await writeSellOrderEvent(tx, id, u.id, 'status_changed', {
        from: cur.status,
        to: body.to,
      });
    }

    if (body.to === 'Done') {
      // Done consumes stock. order_lines.qty carries CHECK (qty > 0) so a
      // sold-out line can't drop to 0 — instead it flips to status 'Sold'.
      // In-stock aggregates key off status, so a Sold line falls out
      // regardless of its retained qty. Partially-sold lines lose qty and
      // stay sellable. Aggregated by inventory_id so multiple lines hitting
      // the same source net out.
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
  if (outcome.kind === 'illegal') {
    return c.json({ error: `illegal transition: ${outcome.from} → ${outcome.to}` }, 409);
  }
  if (outcome.kind === 'idempotent') return c.json({ ok: true, status: outcome.status });
  if (outcome.kind === 'reopenNeedsNote') {
    return c.json({ error: 'note required to reopen' }, 400);
  }
  return c.json({ ok: true, status: body.to });
});

// ── Archive / unarchive a Sell Order.
//
// Archive is a reversible "hide from default list" flag (sell_orders.archived_at).
// Manager-only (sell-orders is a manager-only surface throughout). The handler
// runs inside sql.begin with a row-level lock so concurrent archive +
// unarchive can't race, and so the audit event is only committed if the flag
// flip succeeds.
type SOCtx = Context<{ Bindings: Env; Variables: { user: User } }>;

async function setSellOrderArchived(c: SOCtx, archive: boolean) {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id') as string;
  const sql = getDb(c.env);

  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'isDraft' }
    | { kind: 'noChange' }
    | { kind: 'ok' };

  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const existing = (await tx`
      SELECT status, archived_at FROM sell_orders WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0] as { status: string; archived_at: string | null } | undefined;
    if (!existing) return { kind: 'notFound' };
    if (existing.status === 'Draft') return { kind: 'isDraft' };
    const wasArchived = existing.archived_at !== null;
    if (wasArchived === archive) return { kind: 'noChange' };

    if (archive) {
      await tx`UPDATE sell_orders SET archived_at = NOW() WHERE id = ${id}`;
    } else {
      await tx`UPDATE sell_orders SET archived_at = NULL WHERE id = ${id}`;
    }
    await writeSellOrderEvent(
      tx, id, u.id,
      archive ? 'archived' : 'unarchived',
      {},
    );
    return { kind: 'ok' };
  });

  if (outcome.kind === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome.kind === 'isDraft') {
    return c.json({ error: 'Draft sell orders cannot be archived — delete instead' }, 403);
  }
  if (outcome.kind === 'noChange') {
    return c.json({ error: archive ? 'Sell order is already archived' : 'Sell order is not archived' }, 409);
  }
  return c.json({ ok: true });
}

sellOrders.post('/:id/archive',   c => setSellOrderArchived(c, true));
sellOrders.post('/:id/unarchive', c => setSellOrderArchived(c, false));

// ── Audit timeline for a single sell order. Manager-only (sell-orders is
// manager-only throughout the route file).
sellOrders.get('/:id/events', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const exists = (await sql`SELECT 1 FROM sell_orders WHERE id = ${id} LIMIT 1`)[0];
  if (!exists) return c.json({ error: 'Not found' }, 404);

  const rows = await sql`
    SELECT e.id, e.kind, e.detail, e.created_at,
           act.id AS actor_id, act.name AS actor_name, act.initials AS actor_initials
    FROM sell_order_events e
    LEFT JOIN users act ON act.id = e.actor_id
    WHERE e.sell_order_id = ${id}
    ORDER BY e.created_at ASC, e.id ASC
  ` as Array<{
    id: string;
    kind: string;
    detail: Record<string, unknown>;
    created_at: string;
    actor_id: string | null;
    actor_name: string | null;
    actor_initials: string | null;
  }>;

  // The audit detail stores the raw `customer_id` UUID in meta_changed diffs.
  // Resolve those to customer names so the timeline reads "Acme Corp", not a
  // UUID. Batch the lookup across the whole timeline to keep it one query.
  const customerIds = new Set<string>();
  for (const r of rows) {
    if (r.kind !== 'meta_changed') continue;
    const changes = (r.detail?.changes as Array<{ field: string; from: unknown; to: unknown }>) ?? [];
    for (const ch of changes) {
      if (ch.field !== 'customer_id') continue;
      if (typeof ch.from === 'string') customerIds.add(ch.from);
      if (typeof ch.to === 'string') customerIds.add(ch.to);
    }
  }
  const customerNames = new Map<string, string>();
  if (customerIds.size > 0) {
    const names = await sql`
      SELECT id, name FROM customers WHERE id = ANY(${[...customerIds]}::uuid[])
    ` as Array<{ id: string; name: string }>;
    for (const n of names) customerNames.set(n.id, n.name);
  }
  const resolveCustomer = (v: unknown): unknown =>
    typeof v === 'string' && customerNames.has(v) ? customerNames.get(v) : v;

  return c.json({
    events: rows.map(r => {
      let detail = r.detail;
      if (r.kind === 'meta_changed' && customerNames.size > 0) {
        const changes = (detail?.changes as Array<{ field: string; from: unknown; to: unknown }>) ?? [];
        detail = {
          ...detail,
          changes: changes.map(ch =>
            ch.field === 'customer_id'
              ? { ...ch, from: resolveCustomer(ch.from), to: resolveCustomer(ch.to) }
              : ch),
        };
      }
      return {
        id: r.id,
        kind: r.kind,
        detail,
        createdAt: r.created_at,
        actor: r.actor_id
          ? { id: r.actor_id, name: r.actor_name ?? '', initials: r.actor_initials ?? '' }
          : null,
      };
    }),
  });
});

export default sellOrders;
