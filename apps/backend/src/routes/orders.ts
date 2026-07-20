import { Hono, type Context } from 'hono';
import { getDb } from '../db';
import { uploadAttachment, deleteAttachment } from '../r2';
import { notifyManagers } from '../lib/notify';
import { clampLimit, decodeCursor, encodeCursor, parseSort } from '../lib/pagination';
import { nextHumanId } from '../lib/id-seq';
import {
  diff, writeOrderEvent, META_FIELDS, LINE_FIELDS,
} from '../services/orderAudit';
import { autoTrackParts } from '../lib/marketAutoTrack';
import { effectiveRole } from '../lib/role';
import { getWorkspaceSetting, getUploadLimits } from '../lib/settings';
import { buildPoInvoicePdf, pdfResponse, loadInvoiceLogo } from '../lib/pdf';
import { buildXlsxWorkbook, xlsxResponse, type XlsxColumn } from '../lib/xlsx';
import { synthesizePartNumber } from '@recycle-erp/shared';
import type { Env, LineCategory, User } from '../types';
import { maybeRenameReceipt } from '../ai/receipt';
import { shrinkImageToFit } from '../lib/image-shrink';

const orders = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// A typed/OCR part number always wins; otherwise fall back to a synthetic one
// (e.g. Mixed-brand SSDs the user left blank) so grouping/pricing has a stable
// key. Applied only at line creation — edits never rewrite an existing part
// number. Returns null when neither applies.
function resolvePartNumber(
  category: string | undefined,
  l: { partNumber?: string | null; brand?: string | null; capacity?: string | null;
       interface?: string | null; formFactor?: string | null; generation?: string | null;
       speed?: string | null; rpm?: string | number | null },
): string | null {
  const typed = l.partNumber?.trim();
  if (typed) return typed;
  return synthesizePartNumber(category ?? '', l);
}

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
  serialNumber?: string | null;
  chipNumber?: string | null;
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
  // A manager in rolePreview=as_purchaser mode is scoped to their own POs,
  // matching what the FE shows so the two layers can't disagree.
  const isManager = effectiveRole(u) === 'manager';

  // The mobile shell is a personal submission surface — it asks for `mine` so a
  // manager sees only their own POs there, not the whole org's.
  const mineOnly = c.req.query('mine') === 'true';
  const category = c.req.query('category');                 // RAM/SSD/Other
  const status = c.req.query('status');                     // order stage label (Draft/In Transit/…)
  const includeArchived = c.req.query('includeArchived') === 'true';
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
  //
  // Managers see every PO across the org; purchasers are scoped to their own.
  // `mine` overrides that and pins the list to the caller regardless of role.
  const scopeFrag    = isManager && !mineOnly
    ? sql`TRUE`
    : sql`o.user_id = ${u.id}`;
  const categoryFrag = category ? sql`o.category = ${category}` : sql`TRUE`;
  // The mobile filter chip sends the order's stage label — map to lifecycle.
  // Filtering on per-line status (an earlier design) silently hid empty drafts
  // and drafts whose lines had already advanced past 'Draft'.
  const STATUS_TO_LIFECYCLE: Record<string, string> = {
    'Draft': 'draft',
    'In Transit': 'in_transit',
    'Reviewing': 'reviewing',
    'Done': 'done',
  };
  const statusFrag = status
    ? (STATUS_TO_LIFECYCLE[status]
        ? sql`o.lifecycle = ${STATUS_TO_LIFECYCLE[status]}`
        : sql`FALSE`)
    : sql`TRUE`;
  // Archived orders drop out of the default view; clients opt in to see them.
  const archivedFrag = includeArchived ? sql`TRUE` : sql`o.archived_at IS NULL`;

  // Keyset pagination. The cursor compares on the ACTIVE sort column (with id
  // as the tiebreaker), not a fixed created_at — otherwise the WHERE boundary
  // and the ORDER BY disagree under a total_cost/lifecycle sort and pages
  // silently skip or duplicate rows. total_cost is COALESCEd so NULL overrides
  // order consistently in both the predicate and ORDER BY.
  const SORT_EXPR: Record<string, ReturnType<typeof sql>> = {
    created_at: sql`o.created_at`,
    total_cost: sql`COALESCE(o.total_cost, 0)`,
    lifecycle: sql`o.lifecycle`,
  };
  const SORT_CAST: Record<string, string> = {
    created_at: 'timestamptz',
    total_cost: 'numeric',
    lifecycle: 'text',
  };
  const sortExpr = SORT_EXPR[sort.col] ?? SORT_EXPR.created_at;
  // sortCast/sortDir come from fixed allowlists (SORT_CAST + parseSort), never
  // from user input, so sql.unsafe here cannot inject — hoisted onto their own
  // lines so the safety review lives next to the call.
  const castSql = sql.unsafe(SORT_CAST[sort.col] ?? SORT_CAST.created_at); // nosec
  const dirSql = sql.unsafe(sort.dir.toUpperCase()); // nosec
  const cursorFrag = cursor
    ? (sort.dir === 'desc'
        ? sql`AND (${sortExpr}, o.id) < (${cursor.ts}::${castSql}, ${cursor.id})`
        : sql`AND (${sortExpr}, o.id) > (${cursor.ts}::${castSql}, ${cursor.id})`)
    : sql`AND TRUE`;

  const rows = await sql`
    SELECT
      o.id, o.user_id, o.category, o.payment, o.notes, o.lifecycle, o.created_at,
      o.archived_at,
      o.total_cost::float AS total_cost,
      u.name AS user_name, u.initials AS user_initials,
      o.commission_rate::float AS commission_rate,
      w.id AS warehouse_id, w.short AS warehouse_short, w.region AS warehouse_region,
      COALESCE(SUM(l.qty), 0)::int                                                  AS qty,
      COALESCE(SUM(COALESCE(l.sell_price, l.unit_cost) * l.qty), 0)::float         AS revenue,
      COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit,
      COUNT(l.id)::int                                                              AS line_count
    FROM orders o
    JOIN users u      ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    LEFT JOIN order_lines l ON l.order_id = o.id
    WHERE ${scopeFrag} AND ${categoryFrag} AND ${statusFrag} AND ${archivedFrag} ${cursorFrag}
    GROUP BY o.id, u.name, u.initials, w.id, w.short, w.region
    ORDER BY ${sortExpr} ${dirSql}, o.id ${dirSql}
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  let nextCursor: string | null = null;
  if (hasMore) {
    const last = slice[slice.length - 1] as { created_at: string | Date; total_cost: number | null; lifecycle: string; id: string };
    const sortVal: string | number =
      sort.col === 'total_cost' ? (last.total_cost ?? 0)
      : sort.col === 'lifecycle' ? last.lifecycle
      : (last.created_at instanceof Date ? last.created_at.toISOString() : String(last.created_at));
    nextCursor = encodeCursor({ ts: sortVal, id: last.id });
  }

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
      archivedAt: r.archived_at,
      createdAt: r.created_at,
      totalCost: r.total_cost,
      warehouse: r.warehouse_id ? { id: r.warehouse_id, short: r.warehouse_short, region: r.warehouse_region } : null,
      qty: r.qty,
      revenue: r.revenue,
      profit: r.profit,
      lineCount: r.line_count,
      // PO status is authoritative — derive from o.lifecycle, not from line
      // aggregation. Per-line `Sold` (set when inventory ships out via a sell
      // order) is intentional divergence and must not surface as "Mixed".
      status: LINE_STATUS_FOR_LIFECYCLE[r.lifecycle as string] ?? r.lifecycle,
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
           o.archived_at,
           o.total_cost::float AS total_cost,
           o.commission_rate::float AS commission_rate,
           u.name AS user_name, u.initials AS user_initials,
           w.id AS warehouse_id, w.short AS warehouse_short, w.region AS warehouse_region
    FROM orders o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    WHERE o.id = ${id}
    LIMIT 1
  `)[0];

  if (!order) return c.json({ error: 'Not found' }, 404);
  if (effectiveRole(u) !== 'manager' && order.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);

  const lines = await sql`
    SELECT ol.id, ol.category, ol.brand, ol.capacity, ol.generation, ol.type, ol.classification,
           ol.rank, ol.speed, ol.interface, ol.form_factor, ol.description,
           ol.part_number, ol.serial_number, ol.chip_number, ol.condition, ol.qty,
           ol.unit_cost::float AS unit_cost, ol.sell_price::float AS sell_price,
           ol.status, ol.scan_image_id, ol.scan_confidence, ol.position,
           ol.health::float AS health, ol.rpm,
           ls.delivery_url AS scan_image_url
    FROM order_lines ol
    LEFT JOIN label_scans ls ON ls.cf_image_id = ol.scan_image_id
    WHERE ol.order_id = ${id}
    ORDER BY ol.position ASC
  `;

  const status = LINE_STATUS_FOR_LIFECYCLE[order.lifecycle as string] ?? order.lifecycle as string;

  // Per-status evidence (note + attachments) — currently captured only for
  // Done. Same response shape as sell orders' statusMeta.
  const metaRows = await sql`
    SELECT status, note, set_at FROM order_status_meta WHERE order_id = ${id}
  `;
  const attRows = await sql`
    SELECT id, status, filename, size_bytes, mime_type, delivery_url, uploaded_at
    FROM order_status_attachments WHERE order_id = ${id} ORDER BY uploaded_at
  `;
  const statusMeta: Record<string, {
    note: string | null; when: string;
    attachments: { id: string; filename: string; size: number; mime: string; url: string; uploadedAt: string }[];
  }> = {};
  for (const m of metaRows) {
    statusMeta[m.status as string] = { note: m.note, when: m.set_at, attachments: [] };
  }
  for (const a of attRows) {
    const s = a.status as string;
    statusMeta[s] ??= { note: null, when: a.uploaded_at, attachments: [] };
    statusMeta[s].attachments.push({
      id: a.id, filename: a.filename, size: a.size_bytes,
      mime: a.mime_type, url: a.delivery_url, uploadedAt: a.uploaded_at,
    });
  }

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
      archivedAt: order.archived_at,
      status,
      statusMeta,
      createdAt: order.created_at,
      totalCost: order.total_cost,
      commissionRate: order.commission_rate,
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
        serialNumber: l.serial_number,
        chipNumber: l.chip_number,
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

// ── Audit timeline for a single order. Same access rules as GET /:id:
// owner + manager. Used by the PO edit page's Activity panel.
orders.get('/:id/events', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const owner = (await sql`SELECT user_id FROM orders WHERE id = ${id} LIMIT 1`)[0] as
    | { user_id: string } | undefined;
  if (!owner) return c.json({ error: 'Not found' }, 404);
  if (effectiveRole(u) !== 'manager' && owner.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);

  const rows = await sql`
    SELECT e.id, e.kind, e.detail, e.created_at,
           act.id AS actor_id, act.name AS actor_name, act.initials AS actor_initials
    FROM order_events e
    LEFT JOIN users act ON act.id = e.actor_id
    WHERE e.order_id = ${id}
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

  return c.json({
    events: rows.map(r => ({
      id: r.id,
      kind: r.kind,
      detail: r.detail,
      createdAt: r.created_at,
      actor: r.actor_id
        ? { id: r.actor_id, name: r.actor_name ?? '', initials: r.actor_initials ?? '' }
        : null,
    })),
  });
});

// ── PO document (PDF). Same access rules as GET /:id: owner + manager. Builds
// a printable purchase-order document — header, warehouse address, line items
// with costs, and a payment summary. Registered before any broader route.
const LIFECYCLE_LABEL: Record<string, string> = {
  draft: 'Draft', in_transit: 'In Transit', reviewing: 'Reviewing', done: 'Done',
};

function poLineLabel(l: Record<string, unknown>): string {
  const s = (v: unknown) => (v == null ? '' : String(v));
  switch (l.category) {
    case 'RAM': return [s(l.brand), s(l.capacity), s(l.generation), l.speed ? `${l.speed}MHz` : '', s(l.rank)].filter(Boolean).join(' ');
    case 'SSD': return [s(l.brand), s(l.capacity), s(l.interface), s(l.form_factor)].filter(Boolean).join(' ');
    case 'HDD': return [s(l.brand), s(l.capacity), l.rpm ? `${l.rpm}rpm` : '', s(l.interface)].filter(Boolean).join(' ');
    default: return s(l.description);
  }
}

const fmtTs = (v: unknown): string =>
  v ? new Date(v as string).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';

orders.get('/:id/invoice', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const order = (await sql`
    SELECT o.id, o.user_id, o.category, o.payment, o.notes, o.lifecycle, o.created_at,
           o.total_cost::float AS total_cost, o.commission_rate::float AS commission_rate,
           u.name AS user_name,
           w.name AS warehouse_name, w.region AS warehouse_region, w.address AS warehouse_address
    FROM orders o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    WHERE o.id = ${id}
    LIMIT 1
  `)[0] as Record<string, unknown> | undefined;
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (effectiveRole(u) !== 'manager' && order.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);

  const [lines, company, companyDomain] = await Promise.all([
    sql`
      SELECT category, brand, capacity, generation, type, classification, rank, speed,
             interface, form_factor, description, part_number, condition, qty,
             unit_cost::float AS unit_cost
      FROM order_lines WHERE order_id = ${id} ORDER BY position ASC
    ` as unknown as Promise<Record<string, unknown>[]>,
    getWorkspaceSetting<string>(sql, 'workspace_name', 'Recycle Servers'),
    getWorkspaceSetting<string>(sql, 'domain', ''),
  ]);

  // Payment summary. Subtotal is the sum of line costs; the order may carry a
  // manual total_cost override (e.g. a negotiated lot price) — surface both when
  // they differ. Commission is a manager-set rate on the PO; the dollar amount
  // depends on realized profit (sell side), which this document doesn't carry,
  // so we show the rate only.
  const subtotal = lines.reduce((s, l) => s + Number(l.qty ?? 0) * Number(l.unit_cost ?? 0), 0);
  const totalQty = lines.reduce((s, l) => s + Number(l.qty ?? 0), 0);
  const totalCost = order.total_cost != null ? Number(order.total_cost) : subtotal;
  const commissionRate = order.commission_rate != null ? Number(order.commission_rate) : null;

  const buf = await buildPoInvoicePdf({
    company,
    companyDomain,
    poId: String(order.id),
    date: fmtTs(order.created_at).slice(0, 10),
    status: LIFECYCLE_LABEL[String(order.lifecycle)] ?? String(order.lifecycle),
    buyer: String(order.user_name ?? ''),
    category: String(order.category ?? ''),
    notes: String(order.notes ?? ''),
    warehouseName: String(order.warehouse_name ?? ''),
    warehouseAddress: String(order.warehouse_address ?? ''),
    warehouseRegion: String(order.warehouse_region ?? ''),
    lines: lines.map((l) => ({
      label: poLineLabel(l),
      partNumber: String(l.part_number ?? ''),
      condition: String(l.condition ?? ''),
      qty: Number(l.qty ?? 0),
      unitCost: Number(l.unit_cost ?? 0),
    })),
    payment: {
      method: order.payment === 'self' ? 'Self pay' : 'Company pay',
      totalQty,
      subtotal,
      totalCost,
      commissionRate,
      commissionAmount: null,
    },
    logoPng: loadInvoiceLogo(),
    generatedAt: fmtTs(new Date().toISOString()),
  });

  return pdfResponse(buf, `${order.id}.pdf`);
});

// ── PO spreadsheet (XLSX). Same access rules and payment summary as the PDF
// invoice, but as a workbook: a Payment tab with the header/payment fields and a
// Line items tab with the costed lines. Reuses the shared exceljs builder.
const PO_LINE_COLS: XlsxColumn[] = [
  { header: 'Item',       key: 'item',      width: 34 },
  { header: 'Part #',     key: 'part',      width: 18 },
  { header: 'Chip #',     key: 'chip',      width: 18 },
  { header: 'Category',   key: 'category',  width: 10 },
  { header: 'Condition',  key: 'condition', width: 12 },
  { header: 'Qty',        key: 'qty',       width: 8,  numFmt: '#,##0' },
  { header: 'Unit cost',  key: 'unitCost',  width: 12, numFmt: '#,##0.00' },
  { header: 'Line total', key: 'lineTotal', width: 13, numFmt: '#,##0.00' },
  { header: 'Sell price', key: 'sellPrice', width: 12, numFmt: '#,##0.00' },
  { header: 'Sell total', key: 'sellTotal', width: 13, numFmt: '#,##0.00' },
  { header: 'Profit',     key: 'profit',    width: 12, numFmt: '#,##0.00' },
];

const PO_PAYMENT_COLS: XlsxColumn[] = [
  { header: 'Field', key: 'field', width: 24 },
  { header: 'Value', key: 'value', width: 44 },
];

orders.get('/:id/spreadsheet', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const order = (await sql`
    SELECT o.id, o.user_id, o.category, o.payment, o.notes, o.lifecycle, o.created_at,
           o.total_cost::float AS total_cost, o.commission_rate::float AS commission_rate,
           u.name AS user_name,
           w.short AS warehouse_short, w.region AS warehouse_region
    FROM orders o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    WHERE o.id = ${id}
    LIMIT 1
  `)[0] as Record<string, unknown> | undefined;
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (effectiveRole(u) !== 'manager' && order.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);

  const lines = await sql`
    SELECT category, brand, capacity, generation, type, classification, rank, speed,
           interface, form_factor, description, part_number, chip_number, condition, qty,
           unit_cost::float AS unit_cost, sell_price::float AS sell_price
    FROM order_lines WHERE order_id = ${id} ORDER BY position ASC
  ` as unknown as Record<string, unknown>[];

  // Projected economics. The PO carries a manager-set `sell_price` per line (a
  // target, not a realized sale — the spreadsheet is purchaser-facing and a PO
  // has no sell-side data of its own). Profit/commission here are the projected
  // figures the purchaser sees on their dashboard; lines without a sell price
  // set simply don't contribute (left blank, no profit).
  const lineRows = lines.map((l) => {
    const qty = Number(l.qty ?? 0);
    const unitCost = Number(l.unit_cost ?? 0);
    const sellPrice = l.sell_price != null ? Number(l.sell_price) : null;
    return {
      item: poLineLabel(l),
      part: String(l.part_number ?? ''),
      chip: String(l.chip_number ?? ''),
      category: String(l.category ?? ''),
      condition: String(l.condition ?? ''),
      qty,
      unitCost,
      lineTotal: +(qty * unitCost).toFixed(2),
      sellPrice,
      sellTotal: sellPrice != null ? +(qty * sellPrice).toFixed(2) : null,
      profit: sellPrice != null ? +(qty * (sellPrice - unitCost)).toFixed(2) : null,
    };
  });

  // Mirror the invoice's payment summary: subtotal is the sum of line costs;
  // total_cost may be a manual override (negotiated lot price).
  const subtotal = +lines.reduce((s, l) => s + Number(l.qty ?? 0) * Number(l.unit_cost ?? 0), 0).toFixed(2);
  const totalQty = lines.reduce((s, l) => s + Number(l.qty ?? 0), 0);
  const totalCost = order.total_cost != null ? +Number(order.total_cost).toFixed(2) : subtotal;
  const commissionRate = order.commission_rate != null ? Number(order.commission_rate) : null;
  const warehouse = [order.warehouse_short, order.warehouse_region].filter(Boolean).join(' — ');

  // Projected totals over priced lines, consistent with the purchaser dashboard
  // KPIs. Commission is the projected profit times the manager-set rate.
  const projectedRevenue = +lineRows.reduce((s, r) => s + (r.sellTotal ?? 0), 0).toFixed(2);
  const projectedProfit = +lineRows.reduce((s, r) => s + (r.profit ?? 0), 0).toFixed(2);
  const commissionAmount = commissionRate != null ? +(projectedProfit * commissionRate).toFixed(2) : null;

  const paymentRows = [
    { field: 'PO ID',                 value: String(order.id) },
    { field: 'Date',                  value: fmtTs(order.created_at).slice(0, 10) },
    { field: 'Status',                value: LIFECYCLE_LABEL[String(order.lifecycle)] ?? String(order.lifecycle) },
    { field: 'Buyer',                 value: String(order.user_name ?? '') },
    { field: 'Category',              value: String(order.category ?? '') },
    { field: 'Warehouse',             value: warehouse },
    { field: 'Payment method',        value: order.payment === 'self' ? 'Self pay' : 'Company pay' },
    { field: 'Total quantity',        value: totalQty },
    { field: 'Subtotal (line costs)', value: subtotal },
    { field: 'Total cost',            value: totalCost },
    { field: 'Projected sell value',  value: projectedRevenue },
    { field: 'Projected profit',      value: projectedProfit },
    { field: 'Commission rate',       value: commissionRate != null ? `${(commissionRate * 100).toFixed(2)}%` : '—' },
    { field: 'Commission amount',     value: commissionAmount != null ? commissionAmount : '—' },
    { field: 'Notes',                 value: String(order.notes ?? '') },
  ];

  const buf = await buildXlsxWorkbook([
    { name: 'Payment', columns: PO_PAYMENT_COLS, rows: paymentRows },
    { name: 'Line items', columns: PO_LINE_COLS, rows: lineRows },
  ]);
  return xlsxResponse(buf, `${order.id}.xlsx`);
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

  // Human-friendly id like PO-1289, allocated atomically (see id-seq.ts).
  // Allocated inside the transaction so a rollback also rolls back the counter.
  let newId!: string;
  await sql.begin(async (tx) => {
    newId = await nextHumanId(tx, 'PO', 'PO');
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
          interface, form_factor, description, part_number, serial_number, chip_number, condition, qty,
          unit_cost, sell_price, status, scan_image_id, scan_confidence, position,
          health, rpm
        ) VALUES (
          ${newId}, ${l.category ?? body.category}, ${l.brand ?? null}, ${l.capacity ?? null}, ${l.generation ?? null}, ${l.type ?? null},
          ${l.classification ?? null}, ${l.rank ?? null}, ${l.speed ?? null},
          ${l.interface ?? null}, ${l.formFactor ?? null}, ${l.description ?? null},
          ${resolvePartNumber(l.category ?? body.category, l)}, ${l.serialNumber ?? null}, ${l.chipNumber ?? null}, ${l.condition ?? 'Pulled — Tested'}, ${l.qty},
          ${l.unitCost}, ${l.sellPrice ?? null}, 'Draft',
          ${l.scanImageId ?? null}, ${l.scanConfidence ?? null}, ${i},
          ${l.health ?? null}, ${l.rpm ?? null}
        )
      `;
    }
    await autoTrackParts(tx, body.lines.map(l => ({
      category: l.category ?? body.category,
      partNumber: resolvePartNumber(l.category ?? body.category, l),
      brand: l.brand,
      capacity: l.capacity,
      type: l.type,
      classification: l.classification,
      rank: l.rank,
      speed: l.speed,
      interface: l.interface,
      formFactor: l.formFactor,
      description: l.description,
      health: l.health,
      rpm: l.rpm,
    })));
  });

  return c.json({ id: newId }, 201);
});

// ── Edit — update order meta + line item details. The order owner
// (purchaser) or a manager may PATCH. Draft is purchaser-editable; later
// stages are manager-only — enforced here, not just in the client, so a
// purchaser can't rewrite costs/lines on an order under review.
//
// Line shape on the wire:
//   lines:          updates for existing lines (each carries `id`)
//   addLines:       new line rows to INSERT (no `id`)
//   removeLineIds:  ids to DELETE (will 409 if referenced by sell_order_lines)
type LineFields = {
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
  serialNumber?: string | null;
  chipNumber?: string | null;
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

  const existing = (await sql`SELECT user_id, category, lifecycle FROM orders WHERE id = ${id} LIMIT 1`)[0];
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (u.role !== 'manager' && existing.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);
  if (u.role !== 'manager' && existing.lifecycle !== 'draft') {
    return c.json({ error: 'Only managers can edit an order after submission' }, 403);
  }
  if (body.commissionRate !== undefined && u.role !== 'manager') {
    return c.json({ error: 'Only managers can set the commission rate' }, 403);
  }
  if (
    body.commissionRate !== undefined &&
    body.commissionRate !== null &&
    !Number.isFinite(Number(body.commissionRate))
  ) {
    return c.json({ error: 'commissionRate must be a number or null' }, 400);
  }
  const clampedRate =
    body.commissionRate === undefined ? undefined
    : body.commissionRate === null ? null
    : Math.min(1, Math.max(0, Number(body.commissionRate)));

  // Field range gates — qty>0, unit_cost>=0, sell_price>=0. Without these,
  // a malformed value hits the order_lines CHECK constraint inside the tx
  // and surfaces as a 500. Both the line-patch list (`lines`) and the
  // insert list (`addLines`) need the same check.
  const badLine = (l: { qty?: number | null; unitCost?: number | null; sellPrice?: number | null }) => {
    if (l.qty !== undefined && l.qty !== null && (!Number.isInteger(l.qty) || l.qty <= 0)) {
      return 'qty must be a positive integer';
    }
    if (l.unitCost !== undefined && l.unitCost !== null && (!Number.isFinite(l.unitCost) || l.unitCost < 0)) {
      return 'unitCost must be ≥ 0';
    }
    if (l.sellPrice !== undefined && l.sellPrice !== null && (!Number.isFinite(l.sellPrice) || l.sellPrice < 0)) {
      return 'sellPrice must be ≥ 0';
    }
    return null;
  };
  for (const l of body.lines ?? []) {
    const e = badLine(l);
    if (e) return c.json({ error: e }, 400);
  }
  for (const l of body.addLines ?? []) {
    const e = badLine(l);
    if (e) return c.json({ error: e }, 400);
  }

  // R2 keys of label scans whose lines get removed — deleted after the tx
  // commits (R2 isn't transactional; never delete on a rolled-back change).
  const removedScanKeys: string[] = [];

  // Surfaced so the mobile autosave path can capture the new DB id of each
  // appended line; aligns 1:1 with the request's `addLines` ordering. Populated
  // inside the tx and only read after the tx commits.
  const addedLineIds: string[] = [];

  try {
    await sql.begin(async (tx) => {
      // Lock the order + read fields we need for audit-diffing. The lock keeps
      // a concurrent advance from changing lifecycle between our pre/post
      // snapshots, so the "skip audit while draft" gate is race-free.
      const orderBefore = (await tx`
        SELECT id, lifecycle, notes, warehouse_id, payment,
               total_cost::float AS total_cost,
               commission_rate::float AS commission_rate
        FROM orders WHERE id = ${id} LIMIT 1 FOR UPDATE
      `)[0] as
        | { id: string; lifecycle: string; notes: string | null; warehouse_id: string | null;
            payment: string; total_cost: number | null; commission_rate: number | null }
        | undefined;
      if (!orderBefore) throw new Error('order disappeared mid-edit');
      // A Done PO is the closed-book record of what was bought / sold. Any
      // edit to lines, costs, or commission corrupts that record (and may
      // also confuse downstream sell-order / commission math). Re-open via
      // the advance-back flow first if the data really needs to change.
      // Notes are the only field a manager may freely append on a Done PO.
      if (orderBefore.lifecycle === 'done') {
        const touchesFrozen =
          (Array.isArray(body.lines) && body.lines.length > 0) ||
          (Array.isArray(body.addLines) && body.addLines.length > 0) ||
          (Array.isArray(body.removeLineIds) && body.removeLineIds.length > 0) ||
          body.totalCost !== undefined ||
          body.commissionRate !== undefined;
        if (touchesFrozen) {
          // Outcome thrown out of the tx callback — the surrounding try/catch
          // re-throws unrecognised errors, so we encode the response intent
          // on the error message instead.
          throw new Error('__DONE_LOCKED__');
        }
      }
      const auditable = orderBefore.lifecycle !== 'draft';

      // Snapshot the lines we'll edit / remove so we can diff after the writes.
      // NUMERIC columns come back as strings from postgres.js by default; cast
      // to float so the diff compares numbers, not "120.00" string forms.
      const editIds = Array.isArray(body.lines) ? body.lines.map(l => l.id) : [];
      const linesBefore = editIds.length
        ? await tx`
            SELECT id, status, qty, brand, capacity, type, generation, classification,
                   rank, speed, interface, form_factor, description, part_number,
                   chip_number, condition, rpm,
                   unit_cost::float AS unit_cost,
                   sell_price::float AS sell_price,
                   health::float AS health
            FROM order_lines WHERE order_id = ${id} AND id = ANY(${editIds}::uuid[])`
        : [];
      const beforeMap = new Map<string, Record<string, unknown>>(
        linesBefore.map(l => [l.id as string, l as Record<string, unknown>]));

      let removedSnapshots: Array<{ id: string; part_number: string | null; qty: number; unit_cost: number }> = [];

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
          SELECT id, scan_image_id, part_number, qty, unit_cost::float AS unit_cost FROM order_lines
          WHERE order_id = ${id} AND id = ANY(${body.removeLineIds}::uuid[])
        ` as { id: string; scan_image_id: string | null; part_number: string | null; qty: number; unit_cost: number }[];
        removedSnapshots = doomed.map(r => ({ id: r.id, part_number: r.part_number, qty: r.qty, unit_cost: r.unit_cost }));
        for (const r of doomed) if (r.scan_image_id) removedScanKeys.push(r.scan_image_id);
        await tx`DELETE FROM order_lines WHERE order_id = ${id} AND id = ANY(${body.removeLineIds}::uuid[])`;
      }
      if (Array.isArray(body.lines)) {
        for (const l of body.lines) {
          const setSellPrice = l.sellPrice !== undefined ? 1 : 0;
          // `status` is deliberately NOT settable here. Line status is driven
          // by the lifecycle (advance handler) and 'Sold' is a protected
          // terminal state; accepting a client-supplied status would let any
          // editor forge 'Sold'/'Done' and defeat the sell-order/inventory
          // guards that key off it. order_lines.status has no CHECK, so this
          // route layer is the gate.
          await tx`
            UPDATE order_lines SET
              sell_price     = CASE WHEN ${setSellPrice}::int = 1 THEN ${l.sellPrice ?? null} ELSE sell_price END,
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
              serial_number  = COALESCE(${l.serialNumber ?? null}, serial_number),
              -- '' means "cleared by the user" (the edit forms always send the
              -- field); NULLIF turns it into NULL instead of storing ''.
              chip_number    = NULLIF(COALESCE(${l.chipNumber ?? null}, chip_number), ''),
              condition      = COALESCE(${l.condition ?? null}, condition),
              health         = COALESCE(${l.health ?? null}, health),
              rpm            = COALESCE(${l.rpm ?? null}, rpm)
            WHERE id = ${l.id} AND order_id = ${id}
          `;
        }
      }
      let addedRows: Array<{ id: string; part_number: string | null; qty: number; unit_cost: number }> = [];
      if (Array.isArray(body.addLines) && body.addLines.length) {
        // New lines default to the order's category. Position appends after
        // current max so they sort to the end.
        const posRow = (await tx`SELECT COALESCE(MAX(position), -1) AS p FROM order_lines WHERE order_id = ${id}`)[0] as { p: number };
        let pos = posRow.p + 1;
        for (const l of body.addLines) {
          const inserted = await tx`
            INSERT INTO order_lines (
              order_id, category, brand, capacity, generation, type, classification, rank, speed,
              interface, form_factor, description, part_number, serial_number, chip_number, condition, qty,
              unit_cost, sell_price, status, scan_image_id, scan_confidence, position,
              health, rpm
            ) VALUES (
              ${id}, ${l.category ?? (existing.category as string)},
              ${l.brand ?? null}, ${l.capacity ?? null}, ${l.generation ?? null}, ${l.type ?? null},
              ${l.classification ?? null}, ${l.rank ?? null}, ${l.speed ?? null},
              ${l.interface ?? null}, ${l.formFactor ?? null}, ${l.description ?? null},
              ${resolvePartNumber(l.category ?? (existing.category as string), l)}, ${l.serialNumber ?? null}, ${l.chipNumber ?? null}, ${l.condition ?? 'Pulled — Tested'}, ${l.qty ?? 1},
              ${l.unitCost ?? 0}, ${l.sellPrice ?? null},
              ${LINE_STATUS_FOR_LIFECYCLE[existing.lifecycle as string] ?? 'In Transit'},
              ${l.scanImageId ?? null}, ${l.scanConfidence ?? null}, ${pos++},
              ${l.health ?? null}, ${l.rpm ?? null}
            )
            RETURNING id, part_number, qty, unit_cost::float AS unit_cost
          ` as { id: string; part_number: string | null; qty: number; unit_cost: number }[];
          addedRows.push(inserted[0]);
          addedLineIds.push(inserted[0].id);
        }
        await autoTrackParts(tx, body.addLines.map(l => ({
          category: l.category ?? (existing.category as string),
          partNumber: resolvePartNumber(l.category ?? (existing.category as string), l),
          brand: l.brand,
          capacity: l.capacity,
          type: l.type,
          classification: l.classification,
          rank: l.rank,
          speed: l.speed,
          interface: l.interface,
          formFactor: l.formFactor,
          description: l.description,
          health: l.health,
          rpm: l.rpm,
        })));
      }

      // ── Audit: only for orders that have left Draft. Each kind is written
      // as its own event row so the timeline reads in the order it happened.
      if (auditable) {
        if (touchesOrder) {
          const orderAfter = (await tx`
            SELECT notes, warehouse_id, payment, total_cost::float AS total_cost,
                   commission_rate::float AS commission_rate
            FROM orders WHERE id = ${id} LIMIT 1
          `)[0] as Record<string, unknown>;
          const metaChanges = diff(
            orderBefore as unknown as Record<string, unknown>,
            orderAfter,
            META_FIELDS,
          );
          if (metaChanges.length) {
            await writeOrderEvent(tx, id, u.id, 'meta_changed', { changes: metaChanges });
          }
        }
        // Fetch the post-write snapshot for every edited line in ONE query,
        // then walk the in-memory map. The previous per-line SELECT was an
        // N+1 inside the tx: a 50-line PATCH cost 50 sequential round trips
        // just to render the audit diff.
        const patches = body.lines ?? [];
        if (patches.length > 0) {
          const patchIds = patches.map(p => p.id);
          const afters = (await tx`
            SELECT id, status, qty, brand, capacity, type, generation, classification,
                   rank, speed, interface, form_factor, description, part_number,
                   chip_number, condition, rpm,
                   unit_cost::float AS unit_cost,
                   sell_price::float AS sell_price,
                   health::float AS health
            FROM order_lines WHERE id = ANY(${patchIds}::uuid[])
          `) as Record<string, unknown>[];
          const afterMap = new Map<string, Record<string, unknown>>(
            afters.map(a => [a.id as string, a]),
          );
          for (const patch of patches) {
            const before = beforeMap.get(patch.id);
            const after = afterMap.get(patch.id);
            if (!before || !after) continue;
            const changes = diff(before, after, LINE_FIELDS);
            if (changes.length) {
              await writeOrderEvent(tx, id, u.id, 'line_edited', {
                lineId: patch.id,
                partNumber: after.part_number ?? null,
                changes,
              });
            }
          }
        }
        for (const r of addedRows) {
          await writeOrderEvent(tx, id, u.id, 'line_added', {
            lineId: r.id,
            partNumber: r.part_number,
            qty: r.qty,
            unitCost: r.unit_cost,
          });
        }
        for (const r of removedSnapshots) {
          await writeOrderEvent(tx, id, u.id, 'line_removed', {
            lineId: r.id,
            partNumber: r.part_number,
            qty: r.qty,
            unitCost: r.unit_cost,
          });
        }
      }
    });
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? '';
    if (msg.includes('__DONE_LOCKED__')) {
      return c.json({ error: 'Order is Done and cannot be modified. Use the advance-back flow if needed.' }, 409);
    }
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

  return c.json({ ok: true, addedLineIds });
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

  // Allocated inside the transaction so a rollback also rolls back the counter.
  let newId!: string;
  await sql.begin(async (tx) => {
    newId = await nextHumanId(tx, 'PO', 'PO');
    await tx`
      INSERT INTO orders (id, user_id, category, warehouse_id, payment, notes, total_cost, lifecycle)
      VALUES (
        ${newId}, ${u.id}, ${body.category},
        ${body.warehouseId ?? null}, ${body.payment ?? 'company'}, ${body.notes ?? null},
        ${null}, 'draft'
      )
    `;
  });

  return c.json({ id: newId }, 201);
});

// ── Delete a Draft order. Guarded: only the owner/manager, only while still
// a Draft, and never if a line has already been sold.
orders.delete('/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  // Guards + DELETE run in one tx with the orders row locked FOR UPDATE so a
  // concurrent advance can't move the order out of Draft (or a sell-order
  // attach a line) between the check and the delete.
  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'forbidden' }
    | { kind: 'notDraft' }
    | { kind: 'sold' }
    | { kind: 'ok'; scanned: { scan_image_id: string }[] };

  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const existing = (await tx`
      SELECT user_id, lifecycle FROM orders WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0] as { user_id: string; lifecycle: string } | undefined;
    if (!existing) return { kind: 'notFound' };
    if (u.role !== 'manager' && existing.user_id !== u.id) return { kind: 'forbidden' };
    if (existing.lifecycle !== 'draft') return { kind: 'notDraft' };

    const sold = (await tx`
      SELECT 1 FROM sell_order_lines sol
      JOIN order_lines ol ON ol.id = sol.inventory_id
      WHERE ol.order_id = ${id} LIMIT 1
    `)[0];
    if (sold) return { kind: 'sold' };

    const scanned = await tx`
      SELECT scan_image_id FROM order_lines
      WHERE order_id = ${id} AND scan_image_id IS NOT NULL
    ` as { scan_image_id: string }[];

    await tx`DELETE FROM orders WHERE id = ${id}`; // order_lines cascade via FK
    return { kind: 'ok', scanned };
  });

  if (outcome.kind === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome.kind === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
  if (outcome.kind === 'notDraft') return c.json({ error: 'Only Draft orders can be deleted' }, 403);
  if (outcome.kind === 'sold') {
    return c.json({ error: 'A line in this order is referenced by a sell-order and cannot be deleted' }, 409);
  }

  // Best-effort: drop the label-scan images from R2 too (after the commit).
  for (const r of outcome.scanned) {
    await deleteAttachment(c.env, r.scan_image_id).catch(e => console.error('r2 delete (order deleted)', e));
  }

  return c.json({ ok: true });
});

// ── Archive / unarchive a Purchase Order.
//
// Archive is a reversible "hide from default list" flag (orders.archived_at),
// available to the owner or any manager once the order has left Draft. Hard
// delete stays Draft-only — once business records exist we want them around
// for audit, sell-order references, and commission history.
//
// Both endpoints lock the orders row FOR UPDATE inside a single tx so a
// concurrent archive + unarchive can't race, and so the audit event is only
// committed if the flag flip succeeds.
type OrderCtx = Context<{ Bindings: Env; Variables: { user: User } }>;

async function setArchived(c: OrderCtx, archive: boolean) {
  const u = c.var.user;
  // Route is mounted with `:id`, so Hono populates this — assert for the type.
  const id = c.req.param('id') as string;
  const sql = getDb(c.env);

  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'forbidden' }
    | { kind: 'isDraft' }
    | { kind: 'noChange' }
    | { kind: 'ok' };

  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const existing = (await tx`
      SELECT user_id, lifecycle, archived_at FROM orders WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0] as { user_id: string; lifecycle: string; archived_at: string | null } | undefined;
    if (!existing) return { kind: 'notFound' };
    if (u.role !== 'manager' && existing.user_id !== u.id) return { kind: 'forbidden' };
    // Draft orders use Delete, not Archive — Archive only applies once an
    // order is part of the business record.
    if (existing.lifecycle === 'draft') return { kind: 'isDraft' };
    const wasArchived = existing.archived_at !== null;
    if (wasArchived === archive) return { kind: 'noChange' };

    if (archive) {
      await tx`UPDATE orders SET archived_at = NOW() WHERE id = ${id}`;
    } else {
      await tx`UPDATE orders SET archived_at = NULL WHERE id = ${id}`;
    }
    await writeOrderEvent(
      tx, id, u.id,
      archive ? 'archived' : 'unarchived',
      {},
    );
    return { kind: 'ok' };
  });

  if (outcome.kind === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome.kind === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
  if (outcome.kind === 'isDraft') return c.json({ error: 'Draft orders cannot be archived — delete instead' }, 403);
  if (outcome.kind === 'noChange') {
    return c.json({ error: archive ? 'Order is already archived' : 'Order is not archived' }, 409);
  }
  return c.json({ ok: true });
}

orders.post('/:id/archive',   c => setArchived(c, true));
orders.post('/:id/unarchive', c => setArchived(c, false));

// ─── Per-status evidence (note + attachments) ──────────────────────────────
// Optional evidence a manager can leave when moving a PO to Done. Same
// live-save contract as the sell-order endpoints: the dialog persists
// directly here, so files survive a cancelled status change. Statuses are a
// hardcoded map (no needs_meta table like sell orders), so the valid set is
// a constant.
const PO_META_STATUSES = new Set(['Submission', 'Done']);

// Submission evidence (receipts attached at submit time) is owner-editable: the
// purchaser who owns the order may add/remove files while it is still a Draft.
// Every other meta status (Done) remains manager-only.
function canWriteMeta(u: User, status: string, order: { user_id: string; lifecycle: string }): boolean {
  if (effectiveRole(u) === 'manager') return true;
  return status === 'Submission' && order.user_id === u.id && order.lifecycle === 'draft';
}

// Upsert the text note for a single (order, status).
orders.put('/:id/status-meta/:status', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const status = c.req.param('status');
  if (!PO_META_STATUSES.has(status)) return c.json({ error: 'invalid status' }, 400);
  const body = (await c.req.json().catch(() => null)) as { note?: string | null } | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const sql = getDb(c.env);

  // Ensure the order exists; otherwise the FK upsert silently inserts.
  const existing = (await sql`SELECT user_id, lifecycle FROM orders WHERE id = ${id} LIMIT 1`)[0] as
    | { user_id: string; lifecycle: string } | undefined;
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (!canWriteMeta(u, status, existing)) return c.json({ error: 'Forbidden' }, 403);
  // Drafts must never accumulate order_events rows — the append-only trigger
  // would block the draft-only DELETE cascade (see 0037). Same gate as PATCH.
  const auditable = existing.lifecycle !== 'draft';

  const note = (body.note ?? '').trim() || null;
  await sql.begin(async (tx) => {
    const before = (await tx<{ note: string | null }[]>`
      SELECT note FROM order_status_meta
      WHERE order_id = ${id} AND status = ${status} LIMIT 1
    `)[0];
    await tx`
      INSERT INTO order_status_meta (order_id, status, note, set_by)
      VALUES (${id}, ${status}, ${note}, ${u.id})
      ON CONFLICT (order_id, status)
      DO UPDATE SET note = EXCLUDED.note, set_at = NOW(), set_by = EXCLUDED.set_by
    `;
    const fromNote = before?.note ?? null;
    if (auditable && fromNote !== note) {
      await writeOrderEvent(tx, id, u.id, 'status_meta_changed', {
        status, field: 'note', from: fromNote, to: note,
      });
    }
  });
  return c.json({ ok: true });
});

// Upload one attachment for (order, status). Multipart with field `file`.
orders.post('/:id/status-meta/:status/attachments', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const status = c.req.param('status');
  if (!PO_META_STATUSES.has(status)) return c.json({ error: 'invalid status' }, 400);

  const sql = getDb(c.env);
  const existing = (await sql`SELECT user_id, lifecycle FROM orders WHERE id = ${id} LIMIT 1`)[0] as
    | { user_id: string; lifecycle: string } | undefined;
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (!canWriteMeta(u, status, existing)) return c.json({ error: 'Forbidden' }, 403);
  // See the note PUT above: no audit rows on drafts.
  const auditable = existing.lifecycle !== 'draft';

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'multipart/form-data required' }, 400);
  const file = form.get('file') as File | null;
  if (!(file instanceof File)) return c.json({ error: 'file is required' }, 400);
  const { maxBytes, allowedMime } = await getUploadLimits(sql);
  // These files land in the PUBLIC R2 bucket and are served with their
  // declared Content-Type — an unchecked HTML/SVG is a stored-XSS vector.
  // A missing type is rejected (not allowed through as octet-stream).
  if (!file.type || !allowedMime.has(file.type)) {
    return c.json({ error: `unsupported file type: ${file.type || 'unknown'}` }, 415);
  }
  // Oversized images are downscaled to fit the cap rather than rejected —
  // receipts arrive as multi-MB phone screenshots. Non-images (PDF) can't be
  // recompressed and fall through to the 413.
  const fitted = await shrinkImageToFit(file, maxBytes);
  if (fitted.size > maxBytes) {
    return c.json({ error: `file too large (max ${maxBytes} bytes)` }, 413);
  }

  // Both PO meta statuses (Submission, Done) hold payment receipts, so the
  // AI rename applies unconditionally — no per-status gate like sell orders.
  const stored = await maybeRenameReceipt(c.env, fitted);

  // R2 upload happens outside the transaction — it's the slow part. If the
  // INSERT below fails the object is orphaned in R2; r2.ts treats orphans as
  // a separate concern.
  const uploaded = await uploadAttachment(c.env, stored, `orders/${id}/${status}`)
    .catch(e => { console.error('attachment upload', e); return null; });
  if (!uploaded) return c.json({ error: 'upload failed' }, 502);

  const row = await sql.begin(async (tx) => {
    const r = (await tx`
      INSERT INTO order_status_attachments
        (order_id, status, filename, size_bytes, mime_type, storage_key, delivery_url, uploaded_by)
      VALUES
        (${id}, ${status}, ${stored.name}, ${stored.size},
         ${stored.type || 'application/octet-stream'},
         ${uploaded.storageKey}, ${uploaded.deliveryUrl}, ${u.id})
      RETURNING id, filename, size_bytes, mime_type, delivery_url, uploaded_at
    `)[0];
    if (auditable) {
      await writeOrderEvent(tx, id, u.id, 'status_meta_changed', {
        status, field: 'attachment_added',
        attachmentId: r.id, filename: r.filename, size: r.size_bytes, mime: r.mime_type,
      });
    }
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
orders.delete('/:id/status-meta/:status/attachments/:attachmentId', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const status = c.req.param('status');
  const attachmentId = c.req.param('attachmentId');
  if (!PO_META_STATUSES.has(status)) return c.json({ error: 'invalid status' }, 400);

  const sql = getDb(c.env);
  const existing = (await sql`SELECT user_id, lifecycle FROM orders WHERE id = ${id} LIMIT 1`)[0] as
    | { user_id: string; lifecycle: string } | undefined;
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (!canWriteMeta(u, status, existing)) return c.json({ error: 'Forbidden' }, 403);
  // See the note PUT above: no audit rows on drafts.
  const auditable = existing.lifecycle !== 'draft';

  const removed = await sql.begin(async (tx) => {
    const row = (await tx`
      SELECT storage_key, filename FROM order_status_attachments
      WHERE id = ${attachmentId} AND order_id = ${id} AND status = ${status}
      LIMIT 1
    `)[0] as { storage_key: string; filename: string } | undefined;
    if (!row) return null;
    await tx`DELETE FROM order_status_attachments WHERE id = ${attachmentId}`;
    if (auditable) {
      await writeOrderEvent(tx, id, u.id, 'status_meta_changed', {
        status, field: 'attachment_removed',
        attachmentId, filename: row.filename,
      });
    }
    return row;
  });

  if (!removed) return c.json({ error: 'Not found' }, 404);
  // R2 delete outside the tx — slow side effect, kept out of the lock window.
  // Best-effort.
  await deleteAttachment(c.env, removed.storage_key).catch(e => console.error('r2 delete', e));
  return c.json({ ok: true });
});

// Canonical lifecycle ordering. The workflow_stages table was removed; this
// map's key order (draft → in_transit → reviewing → done) is the source of
// truth, matching the frontend's WORKFLOW_STAGES.
// Purchasers may only move Draft → In Transit (and not back); that one
// transition is open to every signed-in user, owner or not.
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

  const stages = Object.keys(LINE_STATUS_FOR_LIFECYCLE)
    .map((id, position) => ({ id, position }));

  // The lifecycle read, all stage guards and the writes run inside one tx
  // with the orders row locked FOR UPDATE. Reading lifecycle outside the tx
  // let a concurrent delete (which also guarded on a stale lifecycle read)
  // delete an order that was being advanced, and vice-versa.
  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'forbidden'; msg: string }
    | { kind: 'badStage'; msg: string }
    | { kind: 'finalStage' }
    | { kind: 'committedLines'; offendingLineIds: string[] }
    | { kind: 'ok'; nextStageId: string };

  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const cur = (await tx`SELECT user_id, lifecycle FROM orders WHERE id = ${id} LIMIT 1 FOR UPDATE`)[0] as
      | { user_id: string; lifecycle: string } | undefined;
    if (!cur) return { kind: 'notFound' };

    const curIdx = stages.findIndex(s => s.id === cur.lifecycle);
    let nextStageId: string;
    if (body?.toStage) {
      if (u.role !== 'manager') return { kind: 'forbidden', msg: 'Only managers can jump stages' };
      if (!stages.find(s => s.id === body.toStage)) return { kind: 'badStage', msg: 'Unknown stage' };
      nextStageId = body.toStage;
    } else {
      if (curIdx < 0 || curIdx >= stages.length - 1) return { kind: 'finalStage' };
      nextStageId = stages[curIdx + 1].id;
    }
    // Purchaser can only advance Draft → in_transit — but ANY purchaser may,
    // not just the PO's creator: whoever handles the goods submits the order.
    // Every other transition stays manager-only.
    if (u.role !== 'manager' && !(cur.lifecycle === 'draft' && nextStageId === 'in_transit')) {
      return { kind: 'forbidden', msg: 'Purchasers can only advance Draft to In Transit' };
    }

    // Guard: if the transition would move non-Sold lines away from Done status,
    // check whether any of those lines are committed to an open sell order.
    // Un-doing a Done line that a sell order depends on leaves it in a status
    // that validateSellLines rejects, making the sell order unpromotable/broken.
    const newLineStatus = LINE_STATUS_FOR_LIFECYCLE[nextStageId];
    if (newLineStatus && newLineStatus !== 'Done') {
      // The transition sets lines to something other than Done — any lines
      // currently Done that are referenced by open sell orders will break.
      const committed = await tx<{ id: string }[]>`
        SELECT DISTINCT ol.id
        FROM order_lines ol
        JOIN sell_order_lines sol ON sol.inventory_id = ol.id
        JOIN sell_orders so ON so.id = sol.sell_order_id
        WHERE ol.order_id = ${id}
          AND ol.status = 'Done'
          AND so.status IN ('Draft', 'Shipped', 'Awaiting payment')
      `;
      if (committed.length > 0) {
        return { kind: 'committedLines', offendingLineIds: committed.map(r => r.id) };
      }
    }
    await tx`UPDATE orders SET lifecycle = ${nextStageId} WHERE id = ${id}`;

    // PO-level audit: the Draft → In Transit transition is the "submitted"
    // baseline (snapshot of lineCount + totalCost); every subsequent advance
    // is an `advanced` event with from/to.
    if (cur.lifecycle === 'draft' && nextStageId === 'in_transit') {
      const snap = (await tx`
        SELECT COUNT(*)::int AS line_count,
               COALESCE(SUM(qty), 0)::int AS qty,
               COALESCE(SUM(qty * unit_cost), 0)::float AS total_cost
        FROM order_lines WHERE order_id = ${id}
      `)[0] as { line_count: number; qty: number; total_cost: number };
      await writeOrderEvent(tx, id, u.id, 'submitted', {
        lineCount: snap.line_count,
        qty: snap.qty,
        totalCost: snap.total_cost,
      });
    } else {
      await writeOrderEvent(tx, id, u.id, 'advanced', {
        from: cur.lifecycle,
        to: nextStageId,
      });
    }
    if (newLineStatus) {
      // 'Sold' is a terminal post-sale state, not a lifecycle stage — a PO
      // re-advance/stage-jump must never resurrect a sold-out line.
      // All CTEs see the snapshot from before the statement, so `targets`
      // captures the pre-update status while `upd` applies the new one.
      // (A separate post-UPDATE SELECT would always read the already-
      // updated status, so `status IS DISTINCT FROM $new` would be
      // universally false and zero audit rows would ever be written.)
      await tx`
        WITH targets AS (
          SELECT id, status AS old_status
          FROM order_lines
          WHERE order_id = ${id} AND status <> 'Sold'
            AND status IS DISTINCT FROM ${newLineStatus}
          FOR UPDATE
        ),
        upd AS (
          UPDATE order_lines ol SET status = ${newLineStatus}
          FROM targets t WHERE ol.id = t.id
        )
        INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
        SELECT t.id, ${u.id}::uuid, 'status',
               jsonb_build_object('field','status','from',t.old_status,'to',${newLineStatus}::text)
        FROM targets t
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
    return { kind: 'ok', nextStageId };
  });

  if (outcome.kind === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome.kind === 'forbidden') return c.json({ error: outcome.msg }, 403);
  if (outcome.kind === 'badStage') return c.json({ error: outcome.msg }, 400);
  if (outcome.kind === 'finalStage') return c.json({ error: 'Already at the final stage' }, 409);
  if (outcome.kind === 'committedLines') {
    return c.json({
      error: 'Lines committed to open sell orders — cancel those sell orders first.',
      offendingLineIds: outcome.offendingLineIds,
    }, 409);
  }
  return c.json({ ok: true, lifecycle: outcome.nextStageId });
});

export default orders;

