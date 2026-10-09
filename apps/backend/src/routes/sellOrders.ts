import { Hono } from 'hono';
import type { Context } from 'hono';
import { CLOSE_REASON_IDS, isRealPhotoUrl } from '@recycle-erp/shared';
import { getDb, type SqlLike } from '../db';
import { uploadAttachment, deleteAttachment } from '../r2';
import { notify } from '../lib/notify';
import { getUploadLimits } from '../lib/settings';
import { allLimited } from '../lib/concurrency';
import { log } from '../lib/log';
import { clampLimit, cursorTs, cursorTsParam, cursorTsSelect, decodeCursor, encodeCursor, UUID_RE } from '../lib/pagination';
import {
  writeSellOrderEvent, diff, META_FIELDS_SO, type AuditChange,
} from '../services/sellOrderAudit';
import { diffSellOrderLines, type SOLineSnap } from '../services/sellOrderLineMatch';
import { prorateLines, validateTarget } from '../services/sellOrderPriceAdjust';
import {
  validateSellLines, createSellOrderDraft, insertSellOrderLine, type DraftLineInput,
} from '../services/sellOrderCreate';
import {
  parsePriceWorkbook, groupOrderProducts, PriceColumnsNotFoundError,
  type SellOrderLineRow,
} from '../services/sellOrderPriceImport';
import {
  buildPriceTemplateWorkbook, buildPackingListWorkbook, buildPackingListByPoWorkbook,
} from '../lib/sellOrderPriceTemplate';
import {
  assignSellProductNos, foldSheetLines, healSellProductNos, numberSheetLines, sheetRows, type SheetLineRow,
} from '../services/sellOrderNumbers';
import { goodsTotalIsMirror, syncOrderGoodsTotal } from '../services/orderGoodsTotal';
import { settleSoldTx } from '../services/orderSold';
import { searchSellableInventory } from '../services/sellableInventory';
import {
  committedQtySql, committedSellStatuses, openSellStatuses, proposalSellStatuses,
} from '../lib/sellCommitment';
import { lockOrdersForLinesTx } from '../services/orderLocks';
import {
  buildXlsxBuffer, xlsxResponse, datedFilename, type XlsxColumn,
} from '../lib/xlsx';
import {
  convertToUsd, getLatestRateToUsd, isSupportedCurrency,
  type SupportedCurrency, type FxLookup,
} from '../lib/fx';
import { recordSaleDataPoints, recordBidDataPoints, type BidPart } from '../lib/sellOrderMarket';
import { maybeRenameReceipt } from '../ai/receipt';
import { shrinkImageToFit } from '../lib/image-shrink';
import { poLineNo, sellLineOrder } from '../lib/poLineNo';
import { isActiveManager } from '../services/members';
import {
  missingSigners, orderFingerprint, signoffState, type SignoffState,
} from '../services/sellOrderSignoff';
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

// Both reads at once; the caller still checks the status before the order,
// so an unknown status answers 400 even for a missing order.
async function metaStatusAndOrder(
  sql: SqlClient, id: string,
): Promise<[Set<string>, boolean]> {
  const [metaStatusSet, rows] = await allLimited([
    () => loadMetaStatuses(sql),
    () => sql`SELECT 1 FROM sell_orders WHERE id = ${id} LIMIT 1`,
  ] as const);
  return [metaStatusSet, rows.length > 0];
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
  const afterTs = cursorTs(cursor);
  const cursorFrag = afterTs && cursor
    ? sql`AND (so.created_at, so.id) < (${cursorTsParam(sql, afterTs)}, ${cursor.id})`
    : sql`AND TRUE`;

  const rows = await sql`
    SELECT
      so.id, so.status, so.notes, so.created_at, so.updated_at, so.archived_at, so.currency_code,
      ${cursorTsSelect(sql, sql`so.created_at`)} AS cursor_ts,
      (so.adjusted_at IS NOT NULL) AS adjusted,
      c.id AS customer_id, c.name AS customer_name, c.short_name AS customer_short,
      pu.name AS payment_received_by_name,
      -- Products, by #; a line not numbered yet counts on its own.
      COUNT(DISTINCT COALESCE(sol.product_no::text, sol.id::text))::int AS line_count,
      COALESCE(SUM(sol.qty), 0)::int                    AS qty,
      COALESCE(SUM(sol.qty * sol.unit_price), 0)::float AS subtotal
    FROM sell_orders so
    JOIN customers c ON c.id = so.customer_id
    LEFT JOIN users pu ON pu.id = so.payment_received_by
    LEFT JOIN sell_order_lines sol ON sol.sell_order_id = so.id
    WHERE ${statusFrag} AND ${archivedFrag} ${cursorFrag}
    GROUP BY so.id, c.id, pu.name
    ORDER BY so.created_at DESC, so.id DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore
    ? encodeCursor({
        ts: (slice[slice.length - 1] as { cursor_ts: string }).cursor_ts,
        id: (slice[slice.length - 1] as { id: string }).id,
      })
    : null;
  const shaped = slice.map(r => ({
    id: r.id, status: r.status,
    notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
    archivedAt: r.archived_at,
    currency: r.currency_code,
    customer: { id: r.customer_id, name: r.customer_name, short: r.customer_short },
    paymentReceiverName: r.payment_received_by_name ?? null,
    lineCount: r.line_count, qty: r.qty,
    // subtotal/total are USD — sol.unit_price is always the USD value, so the
    // inbox sorts apples-to-apples regardless of each order's source currency.
    subtotal: r.subtotal,
    total: r.subtotal,
    adjusted: r.adjusted as boolean,
  }));
  return c.json({
    rows: shaped,
    nextCursor,
    // Back-compat alias for older callers — keep `items` populated so the
    // current sell-orders inbox UI doesn't go blank while it migrates.
    items: shaped,
  });
});

// The inbox's status tiles. They were summed in the browser from the first
// page of the list, so past 50 orders every tile undercounted. Same archive
// rule as the list; USD, like the list's totals.
sellOrders.get('/stats', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const includeArchived = c.req.query('includeArchived') === 'true';
  const rows = await sql<{ status: string; count: number; revenue: number }[]>`
    SELECT so.status, COUNT(DISTINCT so.id)::int AS count,
           COALESCE(SUM(sol.qty * sol.unit_price), 0)::float AS revenue
    FROM sell_orders so
    LEFT JOIN sell_order_lines sol ON sol.sell_order_id = so.id
    WHERE ${includeArchived ? sql`TRUE` : sql`so.archived_at IS NULL`}
    GROUP BY so.status
  `;
  return c.json({ byStatus: Object.fromEntries(rows.map((r) => [r.status, { count: r.count, revenue: r.revenue }])) });
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
  { header: 'Products', key: 'lines',    width: 9,  numFmt: '#,##0' },
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
      -- Products, by #; a line not numbered yet counts on its own.
      COUNT(DISTINCT COALESCE(sol.product_no::text, sol.id::text))::int AS line_count,
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

// Sellable inventory for the desktop "add inventory to an order" picker. Returns
// the same set as the search_sellable_inventory MCP tool (status Reviewing/Done,
// not on an open sell order) — registered before /:id so it isn't captured as an
// order id.
sellOrders.get('/sellable', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  // One past the page so the picker can say the list is cut off rather than
  // silently ending at 200 — it has no cursor to fetch the rest with.
  const SELLABLE_PAGE = 200;
  const rows = await searchSellableInventory(sql, {
    query: c.req.query('q') ?? null,
    warehouseId: c.req.query('warehouseId') ?? null,
    limit: SELLABLE_PAGE + 1,
  });
  return c.json({
    items: rows.slice(0, SELLABLE_PAGE),
    hasMore: rows.length > SELLABLE_PAGE,
  });
});

sellOrders.get('/:id', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const head = (await sql<{
    id: string; status: string; notes: string | null; created_at: string;
    updated_at: string; archived_at: string | null; close_reason_id: string | null;
    currency_code: string; fx_rate_to_usd: number; fx_source: string;
    customer_id: string; customer_name: string; customer_short: string;
    customer_region: string;
    created_by: string | null;
    payment_received_by: string | null; payment_received_by_name: string | null;
    pre_adjust_native_total: number | null; adjusted_at: string | null;
    adjusted_by: string | null; adjusted_by_name: string | null;
    next_product_no: number;
  }[]>`
    SELECT so.id, so.status, so.notes, so.created_at, so.updated_at, so.archived_at, so.close_reason_id,
           so.next_product_no,
           so.currency_code, so.fx_rate_to_usd::float AS fx_rate_to_usd, so.fx_source,
           so.created_by, so.payment_received_by, pu.name AS payment_received_by_name,
           so.pre_adjust_native_total::float AS pre_adjust_native_total,
           so.adjusted_at, so.adjusted_by, au.name AS adjusted_by_name,
           c.id AS customer_id, c.name AS customer_name, c.short_name AS customer_short, c.region AS customer_region
    FROM sell_orders so
    JOIN customers c ON c.id = so.customer_id
    LEFT JOIN users pu ON pu.id = so.payment_received_by
    LEFT JOIN users au ON au.id = so.adjusted_by
    WHERE so.id = ${id} LIMIT 1
  `)[0];
  if (!head) return c.json({ error: 'Not found' }, 404);

  const linesQuery = () => sql<{
    id: string; category: string; label: string; sub_label: string | null;
    part_number: string | null; qty: number; unit_price: number;
    source_unit_price: number | null;
    condition: string | null; position: number; warehouse_short: string | null;
    pack_warehouse_short: string | null;
    inventory_id: string | null; warehouse_id: string | null;
    source_order_id: string | null;
    source_line_no: number | null;
    inventory_qty: number | null;
    type: string | null; classification: string | null; rank: string | null;
    speed: string | null; interface: string | null; form_factor: string | null;
    health: number | null; image_url: string | null;
    lot_category: string | null; brand: string | null; capacity: string | null;
    generation: string | null; description: string | null; lot_part_number: string | null;
    chip_number: string | null; lot_condition: string | null; rpm: number | null;
    product_no: number | null; append_batch: number | null;
  }[]>`
    SELECT sol.id, sol.category, sol.label, sol.sub_label, sol.part_number,
           sol.qty, sol.unit_price::float AS unit_price,
           sol.source_unit_price::float AS source_unit_price,
           sol.condition, sol.position, sol.product_no, sol.append_batch,
           sol.inventory_id, sol.warehouse_id, ol.order_id AS source_order_id,
           ${poLineNo(sql, 'ol')} AS source_line_no,
           w.short AS warehouse_short, pw.short AS pack_warehouse_short,
           -- The lot's spec, read live: sell_order_lines keeps only a text
           -- snapshot. Null for a hand-typed line or a deleted lot.
           ol.type, ol.classification, ol.rank, ol.speed, ol.interface,
           ol.form_factor, ol.health::float AS health,
           -- The rest of what the packing list numbers a product by.
           ol.category AS lot_category, ol.brand, ol.capacity, ol.generation,
           ol.description, ol.part_number AS lot_part_number, ol.chip_number,
           ol.condition AS lot_condition, ol.rpm,
           img.delivery_url AS image_url,
           -- What this order may still grow its line to: the lot less the units
           -- other committed orders hold. Its own claim is excluded, so editing
           -- a line down and back up is not blocked by itself. A lot that left
           -- the sellable statuses or whose PO was archived offers nothing:
           -- validateSellLines would refuse any qty for it on save.
           CASE WHEN ol.id IS NULL THEN NULL
                WHEN ol.status IN ('Reviewing', 'Done') AND src.archived_at IS NULL
                THEN ol.qty - ${committedQtySql(sql, sql`sol.inventory_id`, { excludeOrderId: id })}
                ELSE 0 END AS inventory_qty
    FROM sell_order_lines sol
    LEFT JOIN warehouses w ON w.id = sol.warehouse_id
    LEFT JOIN order_lines ol ON ol.id = sol.inventory_id
    LEFT JOIN orders src ON src.id = ol.order_id
    LEFT JOIN warehouses pw ON pw.id = COALESCE(ol.warehouse_id, src.warehouse_id, sol.warehouse_id)
    LEFT JOIN LATERAL (
      SELECT ls.delivery_url
      FROM label_scans ls
      WHERE ls.cf_image_id = ol.scan_image_id
      ORDER BY ls.created_at ASC
      LIMIT 1
    ) img ON TRUE
    WHERE sol.sell_order_id = ${id}
    ORDER BY ${sellLineOrder(sql, 'sol')}
  `;
  const [listed, metaRows, attRows, metaStatusSet, signoff] = await allLimited([
    linesQuery,
    // Per-status evidence (notes + attachments). The frontend expects a map
    // keyed by status with both fields flattened together.
    () => sql`
      SELECT status, note, set_at FROM sell_order_status_meta
      WHERE sell_order_id = ${id}
    `,
    () => sql`
      SELECT id, status, filename, size_bytes, mime_type, delivery_url, uploaded_at
      FROM sell_order_status_attachments
      WHERE sell_order_id = ${id}
      ORDER BY uploaded_at
    `,
    () => loadMetaStatuses(sql),
    () => signoffState(sql, id),
  ] as const);
  // The lines in # order, each with its product's # — folded from this one
  // read, so a save landing mid-request can't split a product.
  const { lineOrder, noByLine } = numberSheetLines(listed.map((l): SheetLineRow => ({
    sol_id: l.id, sell_qty: l.qty,
    sol_label: l.label, sol_sub: l.sub_label, sol_part: l.part_number,
    sol_category: l.category, sol_condition: l.condition,
    product_no: l.product_no, append_batch: l.append_batch,
    pack_warehouse: l.pack_warehouse_short,
    inv_id: l.inventory_id, source_order_id: l.source_order_id, po_line_no: l.source_line_no,
    category: l.lot_category, brand: l.brand, capacity: l.capacity, generation: l.generation,
    type: l.type, classification: l.classification, rank: l.rank, speed: l.speed,
    interface: l.interface, form_factor: l.form_factor, description: l.description,
    part_number: l.lot_part_number, chip_number: l.chip_number, condition: l.lot_condition,
    health: l.health, rpm: l.rpm, image_url: l.image_url,
  })), head.next_product_no);
  const rank = new Map(lineOrder.map((lineId, i) => [lineId, i]));
  const lines = [...listed].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);

  // unit_price is always USD; source_unit_price holds the native price for
  // foreign-currency orders (null on USD orders, where native == USD).
  const subtotal = lines.reduce((a, l) => a + l.qty * l.unit_price, 0);
  const nativeSubtotal = lines.reduce(
    (a, l) => a + l.qty * (l.source_unit_price ?? l.unit_price), 0,
  );

  const statusMeta: Record<string, { note: string | null; when: string | null; attachments: unknown[] }> = {};
  for (const s of metaStatusSet) statusMeta[s] = { note: null, when: null, attachments: [] };
  // Seed on demand as well as from needs_meta: a status can carry a meta row or
  // an attachment without being flagged needs_meta (the writer keys off the
  // hardcoded META_STATUSES), and spreading an absent entry would yield a row
  // with no `attachments` array for the push below to reach.
  for (const r of metaRows) {
    statusMeta[r.status] ??= { note: null, when: null, attachments: [] };
    statusMeta[r.status] = { ...statusMeta[r.status], note: r.note, when: r.set_at };
  }
  for (const a of attRows) {
    statusMeta[a.status] ??= { note: null, when: null, attachments: [] };
    statusMeta[a.status].attachments.push({
      id: a.id, filename: a.filename, size: a.size_bytes, mime: a.mime_type,
      url: a.delivery_url, uploadedAt: a.uploaded_at,
    });
  }

  return c.json({
    order: {
      id: head.id, status: head.status, notes: head.notes, createdAt: head.created_at,
      updatedAt: head.updated_at,
      archivedAt: head.archived_at,
      closeReasonId: head.close_reason_id ?? null,
      createdBy: head.created_by,
      paymentReceivedBy: head.payment_received_by
        ? { id: head.payment_received_by, name: head.payment_received_by_name }
        : null,
      currency: head.currency_code,
      fxRateToUsd: head.fx_rate_to_usd,
      fxSource: head.fx_source,
      priceAdjustment: head.pre_adjust_native_total != null
        ? {
            preAdjustNativeTotal: head.pre_adjust_native_total,
            adjustedAt: head.adjusted_at,
            adjustedBy: head.adjusted_by
              ? { id: head.adjusted_by, name: head.adjusted_by_name }
              : null,
          }
        : null,
      customer: { id: head.customer_id, name: head.customer_name, short: head.customer_short, region: head.customer_region },
      signoff,
      lines: lines.map(l => ({
        id: l.id,
        // The product's # on this order — what the packer labels its items
        // with, and what both packing lists show. Lines of one product share
        // it.
        no: noByLine.get(l.id)!,
        category: l.category, label: l.label, sub: l.sub_label, partNumber: l.part_number,
        qty: l.qty, unitPrice: l.unit_price,
        // Native (order-currency) unit price; equals unitPrice for USD orders.
        nativeUnitPrice: l.source_unit_price ?? l.unit_price,
        condition: l.condition, position: l.position,
        warehouse: l.warehouse_short,
        // Where the lot is now: a transfer moves the lot, not the warehouse
        // this line was saved with. The packing lists go by this one.
        packWarehouse: l.pack_warehouse_short,
        inventoryId: l.inventory_id, warehouseId: l.warehouse_id,
        sourceOrderId: l.source_order_id,
        // The line's # on that PO's page.
        sourceLineNo: l.source_line_no,
        type: l.type, classification: l.classification, rank: l.rank,
        speed: l.speed, interface: l.interface, formFactor: l.form_factor,
        health: l.health,
        // The lot's label scan, which Pack mode shows on the line. A stub
        // scan's placeholder data: URL would render as a broken image.
        imageUrl: isRealPhotoUrl(l.image_url) ? l.image_url : null,
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

// Prefix download filenames with the customer so a downloads folder full of
// exports is scannable by who, not just by order id. Strip filesystem/header-
// hostile characters and collapse whitespace to a single dash. \p{L}\p{N}
// (not \w) keeps CJK names — most customers here are Chinese.
function customerSlug(name: string | null): string {
  return (name ?? '')
    .replace(/[^\p{L}\p{N}.\- ]+/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

// What both sell-order spreadsheets are built from: the product grouping the
// edit form prices by (part|label|condition, qty summed across warehouses),
// and the same grouping scoped per warehouse. One query feeds the bid sheet
// and the packing list so the two files can never disagree about what is on
// the order.
async function loadSellOrderSheetData(sql: SqlClient, id: string) {
  const head = (await sql<{ id: string; currency_code: string; customer_name: string | null; next_product_no: number }[]>`
    SELECT so.id, so.currency_code, c.name AS customer_name, so.next_product_no
    FROM sell_orders so
    JOIN customers c ON c.id = so.customer_id
    WHERE so.id = ${id} LIMIT 1
  `)[0];
  if (!head) return null;

  const rows = await sheetRows(sql, id);

  const sheet = foldSheetLines(rows, head.next_product_no);

  const slug = customerSlug(head.customer_name);
  return {
    head: {
      id: head.id,
      customerName: head.customer_name ?? '',
      currencyCode: head.currency_code,
    },
    products: sheet.products,
    warehouses: sheet.warehouses,
    poWarehouses: sheet.poWarehouses,
    filenameStem: slug ? `${head.id}-${slug}` : head.id,
  };
}

// Vendor bid sheet: one row per product on its category's worksheet
// (RAM/SSD/HDD/Other tabs), with a clickable item-photo URL and a blank Unit
// Price column. The vendor fills it and the manager round-trips it through
// POST /:id/price-import/preview — the parser reads every tab.
sellOrders.get('/:id/price-template', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const data = await loadSellOrderSheetData(getDb(c.env), c.req.param('id'));
  if (!data) return c.json({ error: 'Not found' }, 404);

  const buf = await buildPriceTemplateWorkbook(data.head, data.products);
  return xlsxResponse(buf, datedFilename(`${data.filenameStem}-price-template`));
});

// The picking side of the same order: per-warehouse checklist tabs, price-free
// and never sent to a vendor — which is why it is its own download and not a
// tab on the bid sheet (user-requested 2026-09-07). Same manager-only guard:
// warehouse staff get the file from a manager.
//
// ?groupBy=po cuts the same checklist one tab per PO per warehouse;
// ?warehouse=<short> (or 'Unassigned') narrows either shape to one warehouse.
sellOrders.get('/:id/packing-list', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const data = await loadSellOrderSheetData(getDb(c.env), c.req.param('id'));
  if (!data) return c.json({ error: 'Not found' }, 404);

  // Lines held at 0 have no row on either list, and a workbook without a
  // sheet is a file Excel calls corrupt.
  if (data.warehouses.length === 0) {
    return c.json({ error: 'there is nothing to pack — no product on this order is above 0' }, 400);
  }
  const byPo = c.req.query('groupBy') === 'po';
  const only = c.req.query('warehouse');
  const keep = (w: { warehouse: string }) => !only || w.warehouse === only;
  const warehouses = data.warehouses.filter(keep);
  if (only && warehouses.length === 0) {
    return c.json({ error: `No products in warehouse ${only} on this order` }, 400);
  }

  const buf = byPo
    ? await buildPackingListByPoWorkbook(data.head, data.poWarehouses.filter(keep))
    : await buildPackingListWorkbook(data.head, warehouses);
  const suffix = `${byPo ? '-by-po' : ''}${only ? `-${customerSlug(only)}` : ''}`;
  return xlsxResponse(buf, datedFilename(`${data.filenameStem}-packing-list${suffix}`));
});

// Vendor price import, step 1 of 2: parse an uploaded bid sheet and report how
// its rows match this order's products — by canonical part number, never by
// cell position. Writes nothing; the manager applies the matched prices
// through the edit form, whose save (PATCH /:id) owns FX, guards, and audit —
// and, when the client names the confirmed products in `bidParts`, records
// their saved prices on the Market board as `bid:<order>` data points.
const PRICE_IMPORT_MAX_BYTES = 8 * 1024 * 1024;

sellOrders.post('/:id/price-import/preview', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const head = (await sql<{ id: string; status: string; currency_code: string }[]>`
    SELECT id, status, currency_code FROM sell_orders WHERE id = ${id} LIMIT 1
  `)[0];
  if (!head) return c.json({ error: 'Not found' }, 404);
  // Same lock the edit form honors: a Done/Closed order's prices are final.
  if (head.status === 'Done' || head.status === 'Closed') {
    return c.json({ error: `prices are locked on a ${head.status} order` }, 409);
  }

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'multipart/form-data required' }, 400);
  const file = form.get('file') as File | null;
  if (!(file instanceof File)) return c.json({ error: 'file is required' }, 400);
  if (file.size > PRICE_IMPORT_MAX_BYTES) {
    return c.json({ error: `file too large (max ${PRICE_IMPORT_MAX_BYTES} bytes)` }, 413);
  }

  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(await file.arrayBuffer());
  } catch {
    return c.json({ error: 'not a valid .xlsx file' }, 400);
  }

  const lines = (await sql`
    SELECT label, part_number, condition, qty,
           unit_price::float AS unit_price,
           source_unit_price::float AS source_unit_price
    FROM sell_order_lines
    -- A line held at 0 is left off the bid sheet, so it can't be missing from it.
    WHERE sell_order_id = ${id} AND qty > 0
    ORDER BY position
  `) as SellOrderLineRow[];
  const products = groupOrderProducts(lines, head.currency_code === 'CNY');

  try {
    const preview = parsePriceWorkbook(wb, products);
    return c.json({ currency: head.currency_code, ...preview });
  } catch (e) {
    if (e instanceof PriceColumnsNotFoundError) {
      return c.json({ error: e.message, code: 'columns-not-found' }, 400);
    }
    throw e;
  }
});

// Field gates — fail fast with a clean 400 rather than letting a malformed
// line reach the uuid cast, the NOT NULL columns or the sell_order_lines CHECK
// (qty>=0, unit_price>=0) and surface as a 500. A saved order may hold a line
// at 0 rather than remove it, which would renumber the lines after it; a new
// order still needs at least 1 of everything. Which lot lines of a save are
// new is checked under the lock in PATCH; a typed line has no identity apart
// from its fields, qty included, so a typed 0 is the editor's to refuse.
function lineInputError(lines: readonly unknown[], opts: { allowZeroQty?: boolean } = {}): string | null {
  for (const l of lines) {
    if (typeof l !== 'object' || l === null) return 'each line must be an object';
    const { inventoryId, category, label, qty, unitPrice } = l as Record<string, unknown>;
    if (inventoryId != null && (typeof inventoryId !== 'string' || !UUID_RE.test(inventoryId))) {
      return 'inventoryId must be a uuid';
    }
    if (typeof category !== 'string' || category.trim() === '') return 'category is required on every line';
    if (typeof label !== 'string') return 'label is required on every line';
    const minQty = opts.allowZeroQty ? 0 : 1;
    if (!Number.isInteger(qty) || (qty as number) < minQty) {
      return opts.allowZeroQty ? 'qty must be a whole number, 0 or more' : 'qty must be a positive integer';
    }
    if (!Number.isFinite(unitPrice) || (unitPrice as number) < 0) return 'unitPrice must be ≥ 0';
  }
  return null;
}

// A Done order's line set is the historical record of what was sold, and a
// Closed one is frozen until it is reopened to Draft.
const STRUCTURE_LOCKED_STATUSES = new Set(['Done', 'Closed']);

// Create a new sell order from a set of inventory lines. The manager picks
// items off the Inventory page (or the Sell Orders page's "New from inventory"
// CTA) and the draft modal POSTs the result here. We snapshot each line's
// label / part_number / category so the sell order keeps its historical shape
// even if the upstream inventory row changes later.
sellOrders.post('/', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);

  const body = (await c.req.json().catch(() => null)) as
    | { customerId: string; lines: DraftLineInput[]; notes?: string; currency?: string;
        paymentReceivedBy?: string | null }
    | null;
  if (!body || !body.customerId || !Array.isArray(body.lines) || body.lines.length === 0) {
    return c.json({ error: 'customerId and at least one product required' }, 400);
  }
  if (typeof body.customerId !== 'string' || !UUID_RE.test(body.customerId)) {
    return c.json({ error: 'customerId must be a uuid' }, 400);
  }
  // Receiver must be an active manager — catch a stale/forged id as a clean
  // 400 instead of an FK violation 500.
  if (body.paymentReceivedBy != null
      && !(await isActiveManager(sql, body.paymentReceivedBy))) {
    return c.json({ error: 'paymentReceivedBy must be an active manager' }, 400);
  }
  // Currency is per-order; every line is quoted in it. Default USD keeps the
  // common path unchanged. unitPrice on each line is the NATIVE price.
  const currency: SupportedCurrency = body.currency === undefined ? 'USD' : body.currency as SupportedCurrency;
  if (!isSupportedCurrency(currency)) {
    return c.json({ error: 'unsupported currency' }, 400);
  }
  const lineErr = lineInputError(body.lines);
  if (lineErr) return c.json({ error: lineErr }, 400);

  const result = await createSellOrderDraft(sql, {
    customerId: body.customerId,
    currency,
    notes: body.notes ?? null,
    paymentReceivedBy: body.paymentReceivedBy ?? null,
    lines: body.lines,
    actorUserId: u.id,
    source: 'manager',
  });
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true, id: result.id }, 201);
});

// A line as the editor saves it: the row it was, when it was on the order —
// the rewrite below replaces every row, and the id is how a line keeps its
// place in the numbering through it.
type SaveLineInput = DraftLineInput & { id?: string | null };

// The # each saved line is written with. A line that was on the order keeps
// its own — found by the row the editor says it was, else by its lot, else (a
// hand-typed line saved without its row) by its text — so neither an edit nor
// the rewrite moves it. Anything else is new and is numbered after the save
// (assignSellProductNos).
async function carriedProductNos(
  tx: SqlLike, orderId: string,
): Promise<(l: SaveLineInput) => number | null> {
  const rows = await tx<{
    id: string; inventory_id: string | null; product_no: number | null;
    category: string; label: string; sub_label: string | null; part_number: string | null;
    condition: string | null; warehouse_id: string | null;
  }[]>`
    SELECT id, inventory_id, product_no, category, label, sub_label, part_number, condition, warehouse_id
    FROM sell_order_lines WHERE sell_order_id = ${orderId}`;
  const byRow = new Map(rows.map((r) => [r.id, r.product_no]));
  const lowest = (m: Map<string, number>, k: string, no: number | null) => {
    if (no == null) return;
    const had = m.get(k);
    if (had == null || no < had) m.set(k, no);
  };
  const typedKey = (l: {
    category: string; label: string; subLabel?: string | null; partNumber?: string | null;
    condition?: string | null; warehouseId?: string | null;
  }) => JSON.stringify([
    l.category, l.label, l.subLabel ?? null, l.partNumber ?? null, l.condition ?? null, l.warehouseId ?? null,
  ]);
  const byLot = new Map<string, number>();
  const byText = new Map<string, number>();
  for (const r of rows) {
    if (r.inventory_id) lowest(byLot, r.inventory_id.toLowerCase(), r.product_no);
    else {
      lowest(byText, typedKey({
        ...r, subLabel: r.sub_label, partNumber: r.part_number, warehouseId: r.warehouse_id,
      }), r.product_no);
    }
  }
  return (l) => {
    if (typeof l.id === 'string' && byRow.has(l.id)) return byRow.get(l.id)!;
    const lot = l.inventoryId?.toLowerCase();
    if (lot) return byLot.get(lot) ?? null;
    return byText.get(typedKey(l)) ?? null;
  };
}

// What the release before 0170 numbered a line by (sell_order_lines.append_batch),
// still written so a rollback to it moves no #: a line keeps its own — by row,
// else by lot — and a line new to an order past Draft gets the next batch. Drop
// it with legacyNumbers.
async function appendBatches(
  tx: SqlLike, orderId: string, status: string,
): Promise<(l: SaveLineInput) => number | null> {
  const rows = await tx<{ id: string; inventory_id: string | null; append_batch: number | null }[]>`
    SELECT id, inventory_id, append_batch FROM sell_order_lines WHERE sell_order_id = ${orderId}`;
  const byRow = new Map(rows.map((r) => [r.id, r.append_batch]));
  const byLot = new Map<string, number | null>();
  for (const r of rows) {
    if (!r.inventory_id) continue;
    const lot = r.inventory_id.toLowerCase();
    const had = byLot.get(lot);
    if (!byLot.has(lot) || r.append_batch === null || (had != null && r.append_batch < had)) {
      byLot.set(lot, r.append_batch);
    }
  }
  const next = status === 'Draft'
    ? null
    : rows.reduce((max, r) => Math.max(max, r.append_batch ?? 0), 0) + 1;
  return (l) => {
    if (typeof l.id === 'string' && byRow.has(l.id)) return byRow.get(l.id)!;
    const lot = l.inventoryId?.toLowerCase();
    if (lot && byLot.has(lot)) return byLot.get(lot)!;
    return next;
  };
}

// Edit an existing sell order. Status / discount / notes are simple COALESCE
// updates. Optionally the manager can also re-pick the customer and rewrite the
// whole line set (same builder UI as a new order) — those edits replace
// sell_order_lines wholesale and are blocked once the order is Done or Closed.
sellOrders.patch('/:id', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { status?: string; notes?: string;
        customerId?: string; lines?: SaveLineInput[]; currency?: string;
        paymentReceivedBy?: string | null; bidParts?: BidPart[] }
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
  if (body.customerId !== undefined
      && (typeof body.customerId !== 'string' || !UUID_RE.test(body.customerId))) {
    return c.json({ error: 'customerId must be a uuid' }, 400);
  }
  const sql = getDb(c.env);

  // Same active-manager gate as POST; explicit null is a clear (always allowed).
  if (body.paymentReceivedBy != null
      && !(await isActiveManager(sql, body.paymentReceivedBy))) {
    return c.json({ error: 'paymentReceivedBy must be an active manager' }, 400);
  }

  const editsStructure = body.customerId !== undefined || body.lines !== undefined
    || body.currency !== undefined;

  // Unlocked read: it answers 404 and picks the currency to fetch FX for. The
  // status is re-read under the row lock below, which is the check that holds.
  const current = (await sql<{ status: string; currency_code: string }[]>`
    SELECT status, currency_code FROM sell_orders WHERE id = ${id} LIMIT 1
  `)[0];
  if (!current) return c.json({ error: 'Not found' }, 404);
  if (editsStructure && STRUCTURE_LOCKED_STATUSES.has(current.status)) {
    return c.json({ error: `cannot edit products or customer of a ${current.status} order` }, 409);
  }

  // Resolve FX outside the transaction (a cold-cache frankfurter fetch must not
  // run while the sell_orders row lock is held). Only a line rewrite needs a
  // fresh rate; currency is the caller's new one, else the order's stored one.
  const fxCurrency = (body.currency ?? current.currency_code) as SupportedCurrency;
  const preFx: FxLookup | null = body.lines !== undefined
    ? await getLatestRateToUsd(sql, fxCurrency)
    : null;

  if (body.lines !== undefined && (!Array.isArray(body.lines) || body.lines.length === 0)) {
    return c.json({ error: 'at least one product required' }, 400);
  }
  if (Array.isArray(body.lines)) {
    const lineErr = lineInputError(body.lines, { allowZeroQty: true });
    if (lineErr) return c.json({ error: lineErr }, 400);
  }

  // A confirmed vendor price import names the products whose saved prices
  // are the customer's bid — a product being a (part, condition), since the
  // sheet prices New and Used separately. It only means something alongside
  // the lines it prices, so it is refused on its own.
  if (body.bidParts !== undefined) {
    const badPart = (p: unknown) => {
      if (typeof p !== 'object' || p === null) return true;
      const { partNumber, condition } = p as { partNumber?: unknown; condition?: unknown };
      if (typeof partNumber !== 'string' || partNumber.trim() === '' || partNumber.length > 200) return true;
      return !(condition === null || condition === undefined
        || (typeof condition === 'string' && condition.length > 0 && condition.length <= 200));
    };
    if (!Array.isArray(body.bidParts) || body.bidParts.length > 1000 || body.bidParts.some(badPart)) {
      return c.json({ error: 'bidParts must be an array of { partNumber, condition } objects' }, 400);
    }
    if (body.lines === undefined) {
      return c.json({ error: 'bidParts requires lines' }, 400);
    }
  }

  type Outcome = { code: 400 | 404 | 409; msg: string } | { code: 200 };
  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    // Snapshot BEFORE state for diffing. Lock the header row so a concurrent
    // edit can't slip an event we'd then miss; lines are read consistently
    // inside the same tx so no extra lock is needed.
    const beforeHead = (await tx<{
      status: string; notes: string | null; customer_id: string;
      currency_code: string; payment_received_by: string | null;
    }[]>`
      SELECT status, notes, customer_id, currency_code, payment_received_by
      FROM sell_orders WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0];
    if (!beforeHead) return { code: 404, msg: 'Not found' };
    // Under the lock: a status move to Done committed between the read above
    // and here would otherwise let this rewrite the record of what was sold.
    if (editsStructure && STRUCTURE_LOCKED_STATUSES.has(beforeHead.status)) {
      return { code: 409, msg: `cannot edit products or customer of a ${beforeHead.status} order` };
    }
    // A line rewrite re-snapshots every line's USD value at the current rate.
    // Currency is the explicit new one (validated above) or the order's
    // existing one when only qty/price changed. `preFx` is null without a
    // line rewrite.
    const effectiveCurrency = (body.currency ?? beforeHead.currency_code) as SupportedCurrency;
    const fx = preFx;
    // preFx was fetched for the currency read before the lock; a concurrent
    // currency change would have the lines priced at the wrong rate.
    if (fx && effectiveCurrency !== fxCurrency) {
      return { code: 409, msg: 'sell order currency changed while saving — reload and retry' };
    }
    const beforeLines = body.lines !== undefined
      ? await tx<SOLineSnap[]>`
          SELECT inventory_id, qty, unit_price::float AS unit_price, condition,
                 category, label, sub_label, part_number, warehouse_id
          FROM sell_order_lines WHERE sell_order_id = ${id} ORDER BY position
        `
      : [];
    if (body.lines !== undefined) {
      // A 0 is how a line already on the order keeps its # once its lot has
      // gone, so validateSellLines passes it unchecked. A lot new to the order
      // has to come with at least 1, or a stale or made-up id reaches the FK.
      const onOrder = new Set(beforeLines.flatMap(l => (l.inventory_id ? [l.inventory_id.toLowerCase()] : [])));
      if (body.lines.some(l => l.qty === 0 && l.inventoryId && !onOrder.has(l.inventoryId.toLowerCase()))) {
        return { code: 400, msg: 'a new product needs a qty of at least 1 — only a lot already on the order can be held at 0' };
      }
      // Same sellability check as POST, run inside the tx with FOR UPDATE.
      // This order is excluded so keeping its own already-committed lines
      // doesn't trip the one-open-sell-order-per-line rule.
      const err = await validateSellLines(tx, body.lines, id);
      if (err) return { code: 400, msg: err };
    }
    // COALESCE can't express "clear to NULL", so the receiver (the one nullable
    // editable field) gets a CASE keyed on whether the key was present at all.
    await tx`
      UPDATE sell_orders SET
        notes          = COALESCE(${body.notes ?? null}, notes),
        customer_id    = COALESCE(${body.customerId ?? null}, customer_id),
        currency_code  = COALESCE(${fx ? effectiveCurrency : null}, currency_code),
        fx_rate_to_usd = COALESCE(${fx ? fx.rate : null}, fx_rate_to_usd),
        fx_source      = COALESCE(${fx ? fx.source : null}, fx_source),
        payment_received_by = CASE WHEN ${body.paymentReceivedBy !== undefined}
                                   THEN ${body.paymentReceivedBy ?? null}::uuid
                                   ELSE payment_received_by END,
        -- A line rewrite replaces the priced set wholesale, so the negotiated
        -- baseline no longer describes this order — clear the adjustment badge.
        -- The price_adjusted events stay in the immutable timeline.
        pre_adjust_native_total = CASE WHEN ${body.lines !== undefined}
                                       THEN NULL ELSE pre_adjust_native_total END,
        adjusted_at    = CASE WHEN ${body.lines !== undefined}
                              THEN NULL ELSE adjusted_at END,
        adjusted_by    = CASE WHEN ${body.lines !== undefined}
                              THEN NULL ELSE adjusted_by END,
        updated_at     = NOW()
      WHERE id = ${id}
    `;
    if (body.lines !== undefined && fx) {
      const isNonUsd = effectiveCurrency !== 'USD';
      // Lines an older instance rewrote mid-deploy carry no #: store the ones
      // they show before carrying them across this rewrite.
      await healSellProductNos(tx, id);
      const carriedNo = await carriedProductNos(tx, id);
      const batchFor = await appendBatches(tx, id, beforeHead.status);
      await tx`DELETE FROM sell_order_lines WHERE sell_order_id = ${id}`;
      for (let i = 0; i < body.lines.length; i++) {
        const l = body.lines[i];
        const unitPriceUsd = isNonUsd ? convertToUsd(l.unitPrice, fx.rate) : l.unitPrice;
        await insertSellOrderLine(tx, id, {
          inventoryId: l.inventoryId ?? null,
          category: l.category,
          label: l.label,
          subLabel: l.subLabel ?? null,
          partNumber: l.partNumber ?? null,
          qty: l.qty,
          unitPriceUsd,
          warehouseId: l.warehouseId ?? null,
          condition: l.condition ?? null,
          position: i,
          sourceCurrency: isNonUsd ? effectiveCurrency : null,
          sourceUnitPrice: isNonUsd ? l.unitPrice : null,
          sourceFxRate: isNonUsd ? fx.rate : null,
          productNo: carriedNo(l),
          appendBatch: batchFor(l),
        });
      }
      await assignSellProductNos(tx, id);
      if (body.bidParts?.length) {
        await recordBidDataPoints(tx, id, u.id, body.bidParts);
      }
    }

    // Diff events — emitted only when something actually changed.
    const afterHead = (await tx<{ notes: string | null; customer_id: string; currency_code: string; payment_received_by: string | null }[]>`
      SELECT notes, customer_id, currency_code, payment_received_by
      FROM sell_orders WHERE id = ${id} LIMIT 1
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
    return { code: 200 };
  });
  if (outcome.code !== 200) return c.json({ error: outcome.msg }, outcome.code);
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
  // Ensure the order exists; otherwise the FK upsert silently inserts.
  const [metaStatusSet, exists] = await metaStatusAndOrder(sql, id);
  if (!metaStatusSet.has(status)) return c.json({ error: 'invalid status' }, 400);
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

// Statuses whose attachments are payment receipts — eligible for AI rename.
// 'Shipped' evidence is packing/label photos; those keep their name.
const RECEIPT_RENAME_STATUSES = new Set(['Awaiting payment', 'Done']);

// Upload one attachment for (order, status). Multipart with field `file`.
sellOrders.post('/:id/status-meta/:status/attachments', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const status = c.req.param('status');

  const sql = getDb(c.env);
  const [metaStatusSet, exists] = await metaStatusAndOrder(sql, id);
  if (!metaStatusSet.has(status)) return c.json({ error: 'invalid status' }, 400);
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
  // Oversized images are downscaled to fit the cap rather than rejected —
  // receipts arrive as multi-MB phone screenshots. Non-images (PDF) can't be
  // recompressed and fall through to the 413.
  const fitted = await shrinkImageToFit(file, maxBytes);
  if (fitted.size > maxBytes) {
    return c.json({ error: `file too large (max ${maxBytes} bytes)` }, 413);
  }

  const stored = RECEIPT_RENAME_STATUSES.has(status)
    ? await maybeRenameReceipt(c.env, fitted)
    : fitted;

  // R2 upload happens outside the transaction — it's the slow part. A tx open
  // across it would hold a row lock for the whole upload. If the DB INSERT
  // below fails the uploaded object is orphaned in R2; r2.ts treats orphans
  // as a separate concern.
  const uploaded = await uploadAttachment(c.env, stored, `sell-orders/${id}/${status}`)
    .catch(e => { log.error('attachment upload', e); return null; });
  if (!uploaded) return c.json({ error: 'upload failed' }, 502);

  const row = await sql.begin(async (tx) => {
    const r = (await tx`
      INSERT INTO sell_order_status_attachments
        (sell_order_id, status, filename, size_bytes, mime_type, storage_key, delivery_url, uploaded_by)
      VALUES
        (${id}, ${status}, ${stored.name}, ${stored.size},
         ${stored.type || 'application/octet-stream'},
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
  await deleteAttachment(c.env, removed.storage_key).catch(e => log.error('r2 delete', e));
  return c.json({ ok: true });
});

// Sell-order lifecycle. A transition may carry a note; files are evidence
// through the status-meta attachments endpoints, and only a reopen requires
// the note.
// Transitioning to Done also flips every underlying inventory line to Done
// and writes an audit row per line, so the inventory page stays in sync.
//
// Evidence is persisted on main's split schema (migration 0003): the text
// note lives on sell_order_status_meta (PK = sell_order_id+status, columns
// note/set_at/set_by); file evidence lives in its own table and is uploaded
// via the status-meta attachments endpoints above.
// Transition map is the single source of truth for what status changes
// are legal. Any open stage can jump straight to Awaiting payment, to Done
// (the deal can be marked paid at any point), or to Closed. Done has no outgoing edges
// (terminal happy path). Closed has exactly one outgoing edge (reopen →
// Draft) and cannot go to Done. Packing can step back to Draft — Pack mode
// moves a Draft there on opening, and a mistaken open must be undoable.
// Adding a new status means editing this map + the CHECK constraint + the
// seed — no parallel guards elsewhere (see CLAUDE.md "Status guards").
const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  Draft:               new Set(['Packing', 'Shipped', 'Awaiting payment', 'Done', 'Closed']),
  Packing:             new Set(['Draft', 'Shipped', 'Awaiting payment', 'Done', 'Closed']),
  Shipped:             new Set(['Awaiting payment', 'Done', 'Closed']),
  'Awaiting payment':  new Set(['Done', 'Closed']),
  Done:                new Set([]),
  Closed:              new Set(['Draft']),
};
const KNOWN_STATUSES = new Set<string>([
  'Draft', 'Packing', 'Shipped', 'Awaiting payment', 'Done', 'Closed',
]);
// Statuses that carry a per-status meta row (note + attachments). The DB
// row sell_order_statuses.needs_meta tracks the same idea for the per-status
// upload routes (those look it up dynamically); this set governs which
// transitions upsert a sell_order_status_meta row. Evidence is optional —
// the note/attachments are captured opportunistically, never required.
const META_STATUSES = new Set(['Shipped', 'Awaiting payment', 'Done', 'Closed']);

// Fixed close-reason taxonomy from @recycle-erp/shared (single source of
// truth, shared with the frontend picker). The SQL CHECK on
// sell_orders.close_reason_id (migration 0057) must list the same values;
// adding a reason means extending CLOSE_REASON_IDS and widening the CHECK.
const CLOSE_REASONS = new Set<string>(CLOSE_REASON_IDS);

// Statuses in which the negotiated final total may still change. Done is the
// sold historical record and Closed is frozen until reopened — same reasoning
// as the PATCH structural-edit lock, kept next to ALLOWED_TRANSITIONS per the
// status-guard convention (CLAUDE.md).
const ADJUSTABLE_STATUSES = new Set(['Draft', 'Packing', 'Shipped', 'Awaiting payment']);

// Negotiated final-price adjustment: the buyer names one final total and we
// prorate the delta across line unit prices server-side (client rounding
// could break the total===Σlines invariant). Works on the read-only view
// modal, so it deliberately does NOT require the caller to resend lines —
// that's why this isn't part of PATCH /:id.
sellOrders.post('/:id/adjust-price', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { targetTotal?: number }
    | null;
  if (!body || typeof body.targetTotal !== 'number') {
    return c.json({ error: 'targetTotal is required' }, 400);
  }
  const targetTotal = body.targetTotal;
  const sql = getDb(c.env);

  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'locked'; status: string }
    | { kind: 'invalid'; msg: string }
    | { kind: 'done'; fromTotal: number; achievedTotal: number };

  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const cur = (await tx<{
      status: string; currency_code: string; fx_rate_to_usd: number;
    }[]>`
      SELECT status, currency_code, fx_rate_to_usd::float AS fx_rate_to_usd
      FROM sell_orders WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0];
    if (!cur) return { kind: 'notFound' };
    if (!ADJUSTABLE_STATUSES.has(cur.status)) {
      return { kind: 'locked', status: cur.status };
    }

    const lines = await tx<{
      id: string; qty: number; unit_price: number; source_unit_price: number | null;
    }[]>`
      SELECT id, qty, unit_price::float AS unit_price,
             source_unit_price::float AS source_unit_price
      FROM sell_order_lines WHERE sell_order_id = ${id} ORDER BY position
    `;
    const native = lines.map(l => ({
      qty: l.qty,
      price: l.source_unit_price ?? l.unit_price,
    }));
    const invalid = validateTarget(native, targetTotal);
    if (invalid) return { kind: 'invalid', msg: invalid };

    const fromTotal = +native.reduce((a, l) => a + l.qty * l.price, 0).toFixed(2);
    const { prices, achievedTotal } = prorateLines(native, targetTotal);

    // In-place updates keep line ids, positions, and serial/chip snapshots.
    // Non-USD lines re-derive the USD value at the header's frozen rate; the
    // source_* columns keep carrying the native negotiation truth.
    const isNonUsd = cur.currency_code !== 'USD';
    const usdPrices = prices.map((p) => isNonUsd ? convertToUsd(p, cur.fx_rate_to_usd) : p);
    const nativePrices = prices.map((p) => isNonUsd ? p : null);
    // The array casts are load-bearing: on a USD order the native array is all
    // nulls, which carries no type of its own.
    await tx`
      UPDATE sell_order_lines sol
      SET unit_price = v.usd, source_unit_price = v.native
      FROM unnest(${lines.map((l) => l.id)}::uuid[], ${usdPrices}::numeric[],
                  ${nativePrices}::numeric[]) AS v(id, usd, native)
      WHERE sol.id = v.id
    `;

    // Baseline is the first pre-negotiation total; later adjustments only move
    // adjusted_at/by so the badge always compares first-quoted vs current.
    await tx`
      UPDATE sell_orders SET
        pre_adjust_native_total = COALESCE(pre_adjust_native_total, ${fromTotal}),
        adjusted_at = NOW(),
        adjusted_by = ${u.id},
        updated_at  = NOW()
      WHERE id = ${id}
    `;

    const pct = +((achievedTotal / fromTotal - 1) * 100).toFixed(2);
    await writeSellOrderEvent(tx, id, u.id, 'price_adjusted', {
      fromTotal, toTotal: achievedTotal, requestedTotal: targetTotal,
      currency: cur.currency_code, pct,
    });
    return { kind: 'done', fromTotal, achievedTotal };
  });

  switch (outcome.kind) {
    case 'notFound': return c.json({ error: 'Not found' }, 404);
    case 'locked':
      return c.json({ error: `cannot adjust price of a ${outcome.status} order` }, 409);
    case 'invalid': return c.json({ error: outcome.msg }, 400);
    case 'done':
      return c.json({ ok: true, achievedTotal: outcome.achievedTotal });
  }
});

sellOrders.post('/:id/status', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { to: string; note?: string; closeReasonId?: string }
    | null;
  if (!body?.to) return c.json({ error: 'to is required' }, 400);
  if (!KNOWN_STATUSES.has(body.to)) {
    return c.json({ error: `unknown status: ${body.to}` }, 400);
  }

  const hasNote = typeof body.note === 'string' && body.note.trim().length > 0;

  // Close requires a structured reason; the note remains optional.
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
    | { kind: 'notCreator' }
    | { kind: 'reopenNeedsNote' }
    | { kind: 'conflict'; msg: string }
    | { kind: 'archived'; to: string }
    | { kind: 'needsSignoff'; missing: string[] }
    | { kind: 'done' };

  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const cur = (await tx<{ status: string; created_by: string | null; archived_at: string | null }[]>`
      SELECT status, created_by, archived_at FROM sell_orders WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0];
    if (!cur) return { kind: 'notFound' };
    if (cur.status === body.to) return { kind: 'idempotent', status: cur.status };

    const allowed = ALLOWED_TRANSITIONS[cur.status] ?? new Set<string>();
    if (!allowed.has(body.to)) {
      return { kind: 'illegal', from: cur.status, to: body.to };
    }
    // An archived order is hidden from the inbox, so a reservation it staked
    // would hold stock nobody can see. Reopening an archived Closed order
    // lands in Draft, which is how one could otherwise get here.
    if (cur.archived_at !== null && committedSellStatuses().includes(body.to)) {
      return { kind: 'archived', to: body.to };
    }

    // Reopen (Closed → Draft) is creator-only. NULL created_by (MCP
    // client_credentials orders) falls through so those aren't permanently
    // bricked — any manager may reopen them. Checked before the note gate so
    // a non-creator gets 403, not a misleading "note required" 400.
    const reopening = cur.status === 'Closed' && body.to === 'Draft';
    if (reopening && cur.created_by !== null && cur.created_by !== u.id) {
      return { kind: 'notCreator' };
    }

    // Reopen (Closed → Draft) needs a note. This is the one remaining
    // required-note rule: a fresh Draft creation doesn't need a note, so the
    // rule is "transitions *into* Draft from Closed need a note", not "Draft
    // is a meta status".
    if (reopening && !hasNote) {
      return { kind: 'reopenNeedsNote' };
    }

    // Lines held at 0 hold nothing; an order made only of them would ship,
    // bill or sell nothing. Checked on every move into those statuses, not
    // only out of Draft: a shipped order can be zeroed through PATCH.
    if (body.to === 'Shipped' || body.to === 'Awaiting payment' || body.to === 'Done') {
      const [{ any }] = await tx<{ any: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM sell_order_lines WHERE sell_order_id = ${id} AND qty > 0) AS any
      `;
      if (!any) return { kind: 'conflict', msg: 'every product on this order is at 0 — there is nothing to sell' };
    }

    // Done rewrites every source PO (goods total, sold settlement) after it
    // has locked their lines, so those orders are locked first: lines-then-
    // orders is the order PO PATCH deadlocks against (services/orderLocks.ts).
    // Before the Draft check below too, which locks the lines.
    if (body.to === 'Done') {
      const sources = await tx<{ inventory_id: string }[]>`
        SELECT inventory_id FROM sell_order_lines
        WHERE sell_order_id = ${id} AND inventory_id IS NOT NULL
      `;
      await lockOrdersForLinesTx(tx, sources.map((r) => r.inventory_id));
    }

    // Leaving the proposals (Draft, Packing) is where the order actually claims
    // its inventory, so it's where the one-committed-order-per-line rule is
    // enforced. Rivals may name the same line, and the qty a proposal was
    // written against may have been sold since, so both checks run here rather
    // than at create time. Closing claims nothing, and neither does moving
    // between the proposals.
    const proposals = proposalSellStatuses();
    if (proposals.includes(cur.status) && !proposals.includes(body.to) && body.to !== 'Closed') {
      const own = await tx<{ inventory_id: string | null; qty: number }[]>`
        SELECT inventory_id, qty FROM sell_order_lines WHERE sell_order_id = ${id}
      `;
      const err = await validateSellLines(
        tx,
        own.map(l => ({ inventoryId: l.inventory_id, qty: l.qty })),
        id,
      );
      if (err) return { kind: 'conflict', msg: err };
    }

    // Done needs every active manager's sign-off on the order as it stands.
    // Checked after the source POs are locked: a PO archive takes lines off
    // this order holding only the PO's lock, and the fingerprint has to see
    // that. Last, too, so any other refusal names its own reason.
    if (body.to === 'Done') {
      const missing = missingSigners((await signoffState(tx, id)).managers);
      if (missing.length > 0) return { kind: 'needsSignoff', missing: missing.map(m => m.name) };
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
    } else if (reopening) {
      // The reopen reason also lands on the order itself as an appended notes
      // line — the events timeline alone is too easy to miss. Prior notes are
      // preserved; each reopen cycle appends its own line.
      const reopenLine = `Reopened: ${body.note!.trim()}`;
      await tx`
        UPDATE sell_orders
           SET status = 'Draft',
               close_reason_id = NULL,
               notes = CASE WHEN notes IS NULL OR notes = ''
                            THEN ${reopenLine}
                            ELSE notes || ${'\n\n' + reopenLine} END,
               updated_at = NOW()
         WHERE id = ${id}
      `;
      // A deal revived after it was closed is a new deal to approve.
      await tx`DELETE FROM sell_order_signoffs WHERE sell_order_id = ${id}`;
    } else {
      // done_at is the date the sale belongs to (dashboard, contributions).
      // Done is terminal, so it is set here once and never cleared.
      await tx`
        UPDATE sell_orders
           SET status = ${body.to}, updated_at = NOW(),
               done_at = CASE WHEN ${body.to} = 'Done' THEN NOW() ELSE done_at END
         WHERE id = ${id}
      `;
    }

    // Evidence persistence (status_meta upsert). Fires for any transition
    // INTO a meta-tracked status (Shipped / Awaiting payment / Done / Closed).
    // Draft is intentionally excluded: reopen-to-Draft notes live in
    // sell_order_events so successive reopen cycles don't overwrite each
    // other (status_meta PK is sell_order_id + status, single row per pair).
    if (META_STATUSES.has(body.to)) {
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
    } else if (reopening) {
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
      // Done consumes stock. A sold-out line doesn't drop to 0 — a 0-qty
      // line means none of it arrived — instead it flips to status 'Sold'.
      // In-stock aggregates key off status, so a Sold line falls out
      // regardless of its retained qty. Partially-sold lines lose qty and
      // stay sellable. Aggregated by inventory_id so multiple lines hitting
      // the same source net out.
      //
      // Consuming stock moves qty, which is an input to each source PO's
      // derived goods total. The mirror verdict has to be taken before the
      // decrement — afterwards a stale mirror reads as a negotiated lot price
      // and that PO's total_cost pins itself against its lines for good.
      // Lines held at 0 sold nothing: they move no stock and owe no commission.
      const sourceOrders = await tx<{ order_id: string }[]>`
        SELECT DISTINCT l.order_id
        FROM sell_order_lines sol
        JOIN order_lines l ON l.id = sol.inventory_id
        WHERE sol.sell_order_id = ${id} AND sol.inventory_id IS NOT NULL AND sol.qty > 0
      `;
      const goodsFollowsLines = new Map<string, boolean>();
      for (const o of sourceOrders) {
        goodsFollowsLines.set(o.order_id, await goodsTotalIsMirror(tx, o.order_id));
      }

      // The decrement and its audit rows are one statement: `sold` feeds the
      // inserts directly, with the same detail keys each row used to be
      // written with one at a time.
      await tx`
        WITH sold AS (
          UPDATE order_lines ol
             SET qty    = CASE WHEN ol.qty - s.q <= 0 THEN ol.qty ELSE ol.qty - s.q END,
                 status = CASE WHEN ol.qty - s.q <= 0 THEN 'Sold' ELSE ol.status END,
                 -- A partial sale is the moment qty stops meaning "how many were
                 -- bought", so the PO's goods total needs that number kept here
                 -- before the decrement below overwrites it. Selling a line out
                 -- leaves qty alone, so it still speaks for both.
                 qty_purchased = CASE WHEN ol.qty - s.q <= 0 THEN ol.qty_purchased
                                      ELSE COALESCE(ol.qty_purchased, ol.qty) END
            FROM (
              SELECT inventory_id, SUM(qty)::int AS q
              FROM sell_order_lines
              WHERE sell_order_id = ${id} AND inventory_id IS NOT NULL AND qty > 0
              GROUP BY inventory_id
            ) s
           WHERE s.inventory_id = ol.id
          RETURNING ol.id AS line_id,
                    CASE WHEN ol.status = 'Sold' THEN 0 ELSE ol.qty END AS remaining,
                    s.q AS sold
        )
        INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
        SELECT r.line_id, ${u.id}::uuid, 'sold',
               jsonb_build_object('soldQty', r.sold, 'remainingQty', r.remaining,
                                  'sellOrder', ${id}::text)
        FROM sold r
      `;
      for (const [orderId, isMirror] of goodsFollowsLines) {
        await syncOrderGoodsTotal(tx, orderId, isMirror);
      }
      // A source PO already at Done whose last unsold line just went is sold.
      for (const o of sourceOrders) {
        await settleSoldTx(tx, o.order_id, u.id);
      }
      const submitters = await tx<{ user_id: string }[]>`
        SELECT DISTINCT o.user_id
        FROM sell_order_lines sol
        JOIN order_lines l ON l.id = sol.inventory_id
        JOIN orders o ON o.id = l.order_id
        WHERE sol.sell_order_id = ${id} AND sol.inventory_id IS NOT NULL AND sol.qty > 0
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

      // A completed sale is the most authoritative price signal we have —
      // record one market data point per sold product.
      await recordSaleDataPoints(tx, id, u.id);
    }
    return { kind: 'done' };
  });

  if (outcome.kind === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome.kind === 'illegal') {
    return c.json({ error: `illegal transition: ${outcome.from} → ${outcome.to}` }, 409);
  }
  if (outcome.kind === 'idempotent') return c.json({ ok: true, status: outcome.status });
  if (outcome.kind === 'notCreator') {
    return c.json({ error: 'only the creator can reopen this order' }, 403);
  }
  if (outcome.kind === 'reopenNeedsNote') {
    return c.json({ error: 'note required to reopen' }, 400);
  }
  if (outcome.kind === 'conflict') return c.json({ error: outcome.msg }, 409);
  if (outcome.kind === 'archived') {
    return c.json({ error: `unarchive this sell order before moving it to ${outcome.to}` }, 409);
  }
  if (outcome.kind === 'needsSignoff') {
    return c.json({
      error: `needs sign-off from ${outcome.missing.join(', ')}`,
      missingSignoff: outcome.missing,
    }, 409);
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
    | { kind: 'isCommitted' }
    | { kind: 'noChange' }
    | { kind: 'ok' };

  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const existing = (await tx`
      SELECT status, archived_at FROM sell_orders WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0] as { status: string; archived_at: string | null } | undefined;
    if (!existing) return { kind: 'notFound' };
    const wasArchived = existing.archived_at !== null;
    if (wasArchived === archive) return { kind: 'noChange' };
    // Archive-only: a Draft reached by reopening an archived Closed order must
    // still be unarchivable, or it could never return to the inbox.
    if (archive && proposalSellStatuses().includes(existing.status)) return { kind: 'isDraft' };
    // A committed order still reserves its units, and archived ones drop out
    // of the inbox — the stock would stay held by an order nobody sees.
    if (archive && committedSellStatuses().includes(existing.status)) {
      return { kind: 'isCommitted' };
    }

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
    return c.json({ error: 'Draft or Packing sell orders cannot be archived — delete instead' }, 403);
  }
  if (outcome.kind === 'isCommitted') {
    return c.json({ error: 'close or complete this sell order before archiving it' }, 409);
  }
  if (outcome.kind === 'noChange') {
    return c.json({ error: archive ? 'Sell order is already archived' : 'Sell order is not archived' }, 409);
  }
  return c.json({ ok: true });
}

sellOrders.post('/:id/archive',   c => setSellOrderArchived(c, true));
sellOrders.post('/:id/unarchive', c => setSellOrderArchived(c, false));

// ── Manager sign-off. Signing approves the order as it stands and only
// unlocks Done (the gate is in POST /:id/status); a manager signs for
// themselves alone. Open orders only: a Done order's sign-offs are its
// record, and a Closed one is reopened before it is signed again.
//
// A signature names the version it approves — the fingerprint the page read —
// so an edit landing between the manager's review and the click can't be
// signed for them unseen.
async function setSignoff(c: SOCtx, signing: boolean) {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id') as string;
  let reviewed: string | null = null;
  if (signing) {
    const body = (await c.req.json().catch(() => null)) as { fingerprint?: unknown } | null;
    if (typeof body?.fingerprint !== 'string') {
      return c.json({ error: 'fingerprint is required — sign from the order as you read it' }, 400);
    }
    reviewed = body.fingerprint;
  }
  const sql = getDb(c.env);

  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'locked'; status: string }
    | { kind: 'changed' }
    | { kind: 'done'; signoff: SignoffState };

  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    // The row lock orders this against a PATCH or a Done on the same order.
    const cur = (await tx<{ status: string }[]>`
      SELECT status FROM sell_orders WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0];
    if (!cur) return { kind: 'notFound' };
    if (!openSellStatuses().includes(cur.status)) return { kind: 'locked', status: cur.status };

    if (signing) {
      const current = (await orderFingerprint(tx, id))!;
      if (current !== reviewed) return { kind: 'changed' };
      await tx`
        INSERT INTO sell_order_signoffs (sell_order_id, user_id, fingerprint)
        VALUES (${id}, ${u.id}, ${current})
        ON CONFLICT (sell_order_id, user_id) DO UPDATE SET
          fingerprint = EXCLUDED.fingerprint,
          signed_at   = NOW()
      `;
      await writeSellOrderEvent(tx, id, u.id, 'signed_off', {});
    } else {
      const gone = await tx`
        DELETE FROM sell_order_signoffs WHERE sell_order_id = ${id} AND user_id = ${u.id}
        RETURNING 1
      `;
      if (gone.length > 0) await writeSellOrderEvent(tx, id, u.id, 'signoff_withdrawn', {});
    }

    const signoff = await signoffState(tx, id);
    if (signing) {
      const signer = signoff.managers.find(m => m.id === u.id)?.name ?? u.name;
      for (const m of missingSigners(signoff.managers)) {
        if (m.id === u.id) continue;
        await notify(tx, {
          userId: m.id,
          kind: 'sell_order_signoff',
          icon: 'check',
          title: `${signer} signed off sell order ${id}`,
          body: 'Your sign-off is needed before it can be marked Done.',
        });
      }
    }
    return { kind: 'done', signoff };
  });

  switch (outcome.kind) {
    case 'notFound': return c.json({ error: 'Not found' }, 404);
    case 'locked':
      return c.json({ error: `cannot change sign-off on a ${outcome.status} order` }, 409);
    case 'changed':
      return c.json({ error: 'this sell order changed since you opened it — reload it and review it again' }, 409);
    case 'done': return c.json({ signoff: outcome.signoff });
  }
}

sellOrders.post('/:id/signoff', (c) => setSignoff(c, true));
sellOrders.delete('/:id/signoff', (c) => setSignoff(c, false));

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
