import { Hono, type Context } from 'hono';
import { getDb } from '../db';
import { uploadAttachment, deleteAttachment, deleteAttachments } from '../r2';
import { clampLimit, decodeCursor, encodeCursor, parseSort } from '../lib/pagination';
import { nextHumanId } from '../lib/id-seq';
import {
  diff, writeOrderEvent, META_FIELDS, LINE_FIELDS, type AuditChange, type SqlLike,
} from '../services/orderAudit';
import { autoTrackParts } from '../lib/marketAutoTrack';
import { effectiveRole } from '../lib/role';
import { getUploadLimits } from '../lib/settings';
import { buildXlsxWorkbook, xlsxResponse, type XlsxColumn } from '../lib/xlsx';
import {
  CATEGORY_ORDER, SPEC_COLS_BY_CATEGORY, exportCategory, lineSpecFields, categoryTabSheets,
  type ExportCategory,
} from '../lib/categoryColumns';
import { advanceOrderTx, revertOrderToDraftTx, LINE_STATUS_FOR_LIFECYCLE } from '../services/orderAdvance';
import { syncOrderCategory, deriveCategory, sortCategories } from '../services/orderCategory';
import { insertDraftOrderTx } from '../services/orderDraft';
import { goodsTotalIsMirror, syncOrderGoodsTotal } from '../services/orderGoodsTotal';
import { linePhotos, type LinePhoto } from '../lib/linePhotos';
import {
  synthesizePartNumber, serialIssue, staleSpecDbCols, normSellPrice, LINE_PHOTO_CAP,
  type SerialIssue,
} from '@recycle-erp/shared';
import type { Env, LineCategory, User } from '../types';
import { maybeRenameReceipt } from '../ai/receipt';
import { shrinkImageToFit } from '../lib/image-shrink';
import { log } from '../lib/log';

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

// Chip markings are die codes, always printed upper-case on the module; case
// noise (typed or OCR'd) would fork one chip into two spellings, so the column
// is normalised at every write. `''` passes through untouched — PATCH uses it
// as the explicit "clear this field" sentinel, distinct from undefined/"keep".
function canonChipNumber(v: string | null | undefined): string | null {
  return v == null ? null : v.trim().toUpperCase();
}

// Serial rules (shared with the frontend forms via @recycle-erp/shared):
// DDR5 RAM must carry serials, and any entered serials must match qty.
// Enforced here too so no client can write a violating line.
function serialErr(label: string, issue: SerialIssue): string {
  return issue.kind === 'ddr5Required'
    ? `${label}: DDR5 RAM lines require serial numbers`
    : `${label}: serial number count (${issue.count}) must equal qty (${issue.qty})`;
}

// Every category a write touches must exist and be enabled. Checked per line
// rather than once per order — a PO may span categories — and only over the
// categories the request actually names, so a category disabled after the fact
// can't retro-block an unrelated edit to a legacy line.
async function assertCategoriesEnabled(
  sql: ReturnType<typeof getDb>,
  cats: readonly string[],
): Promise<string | null> {
  const wanted = [...new Set(cats.filter(Boolean))];
  if (wanted.length === 0) return null;
  const rows = await sql<{ id: string; enabled: boolean }[]>`
    SELECT id, enabled FROM categories WHERE id = ANY(${wanted})
  `;
  const known = new Map(rows.map(r => [r.id, r.enabled]));
  for (const cat of wanted) {
    if (!known.has(cat)) return `unknown category: ${cat}`;
    if (!known.get(cat)) return `category ${cat} is disabled`;
  }
  return null;
}

// Managers may file a PO for a purchaser (`onBehalfOfUserId`). The raw role is
// checked — not effectiveRole — so a manager previewing as purchaser keeps the
// ability, and the target is validated up front so a typo'd id fails as a 400
// rather than an FK 500. Returns the resolved owner or an error response.
async function resolveOrderOwner(
  sql: ReturnType<typeof getDb>,
  u: User,
  onBehalfOfUserId: unknown,
): Promise<
  | { ownerId: string; ownerName: string | null; ownerDefaultWarehouseId: string | null }
  | { error: string; status: 400 | 403 }
> {
  if (onBehalfOfUserId === undefined || onBehalfOfUserId === null || onBehalfOfUserId === u.id) {
    return { ownerId: u.id, ownerName: null, ownerDefaultWarehouseId: u.defaultWarehouseId };
  }
  // The format gate matters, not just the lookup: users.id is uuid, so a
  // malformed string would make the SELECT itself 22P02 into a 500.
  if (typeof onBehalfOfUserId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(onBehalfOfUserId)) {
    return { error: 'onBehalfOfUserId must be a user id', status: 400 };
  }
  if (u.role !== 'manager') {
    return { error: 'Only managers can create orders on behalf of someone else', status: 403 };
  }
  const rows = await sql<{ id: string; name: string; defaultWarehouseId: string | null }[]>`
    SELECT id, name, default_warehouse_id AS "defaultWarehouseId" FROM users
    WHERE id = ${onBehalfOfUserId} AND active = TRUE AND role = 'purchaser'
    LIMIT 1
  `;
  if (!rows.length) {
    return { error: 'onBehalfOfUserId must name an active purchaser', status: 400 };
  }
  return {
    ownerId: onBehalfOfUserId,
    ownerName: rows[0].name,
    ownerDefaultWarehouseId: rows[0].defaultWarehouseId,
  };
}

// A client that sends warehouseId at all must name a real warehouse — the
// label wizard once sent "" before a destination was picked, which sailed
// past `?? null` into the FK and 500ed. Every endpoint that writes the
// column shares this boundary check.
async function warehouseErr(
  sql: ReturnType<typeof getDb>,
  warehouseId: string | null,
): Promise<string | null> {
  if (warehouseId === null) return null;
  const wh = await sql<{ id: string }[]>`SELECT id FROM warehouses WHERE id = ${warehouseId} LIMIT 1`;
  return wh.length ? null : 'Unknown warehouse';
}

// An `Other` line has no spec fields to identify it, so its type carries the
// whole answer to "what kind of thing is this?". Required alongside the
// description, and only for that category — the rest are self-describing.
//
// Brand is deliberately NOT required here even though both editors gate Confirm
// on it: the API has always accepted a line without one, and the scan and
// import paths rely on that. The rule that stops an order becoming unsaveable
// lives in lib/lineRequirements.ts, which both shells share.
function identityErr(label: string, category: string | undefined, l: { itemType?: string | null }): string | null {
  if (category !== 'Other') return null;
  return (l.itemType ?? '').trim() ? null : `${label}: Other lines require an item type`;
}

// Order-level fees, shared by POST / and PATCH /:id so the two can't drift.
// Rejected rather than clamped: other_fees carries a CHECK (>= 0), so a
// negative slipping through would surface as a 500 from inside the transaction
// instead of a 400 at the door. null means "clear" and must be excluded before
// Number.isFinite is asked anything, since Number(null) is 0.
const FEE_NOTE_MAX = 280;

function badFees(b: { otherFees?: unknown; otherFeesNote?: unknown }): string | null {
  if (b.otherFees !== undefined && b.otherFees !== null) {
    if (typeof b.otherFees !== 'number' || !Number.isFinite(b.otherFees) || b.otherFees < 0) {
      return 'otherFees must be a number >= 0';
    }
  }
  if (b.otherFeesNote !== undefined && b.otherFeesNote !== null) {
    if (typeof b.otherFeesNote !== 'string') return 'otherFeesNote must be a string or null';
    if (b.otherFeesNote.length > FEE_NOTE_MAX) {
      return `otherFeesNote must be ${FEE_NOTE_MAX} characters or fewer`;
    }
  }
  return null;
}

// '' means the user cleared the box — the edit forms echo every field back on
// save — so store NULL rather than an empty string.
function normFeeNote(v: string | null | undefined): string | null {
  return v == null ? null : (v.trim() || null);
}

// A purchaser edit puts a submitted order back in Draft, so "is a draft" no
// longer means "was never submitted". Delete, Archive and the client all read
// the history instead of the stage — and they must agree, or an order lands in
// a state that refuses both.
async function wasEverSubmitted(sql: SqlLike, id: string): Promise<boolean> {
  return !!(await sql`
    SELECT 1 FROM order_events
    WHERE order_id = ${id} AND kind IN ('submitted', 'reverted') LIMIT 1
  `)[0];
}

// A `reverted` event stays pending until a `revert_ack` names its id. A
// timestamp watermark loses any revert whose PATCH commits after the ack:
// order_events.created_at is transaction-START time, and the ack cannot see
// the still-uncommitted row it would need to cover. Acks written before this
// carried no ids and keep falling back to the timestamp.
function unackedRevertFrag(sql: SqlLike, id: string) {
  return sql`
    NOT EXISTS (
      SELECT 1 FROM order_events a
      WHERE a.order_id = ${id} AND a.kind = 'revert_ack'
        AND (a.detail->'ackedIds' @> to_jsonb(e.id::text)
             OR (a.detail->'ackedIds' IS NULL AND a.created_at > e.created_at))
    )`;
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
  itemType?: string | null;
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

  // The mobile capture flow's draft picker asks for `mine` so a manager only
  // ever appends scanned items to their own POs, not someone else's draft.
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
  // Matched against the LINES, not the order header: a PO may mix categories,
  // and header-matching would hide every mixed PO from every chip. Served by
  // order_lines_category_order_idx (migration 0083). A zero-line draft matches
  // no category, which is correct — it contains nothing.
  const categoryFrag = category
    ? sql`EXISTS (SELECT 1 FROM order_lines ocf WHERE ocf.order_id = o.id AND ocf.category = ${category})`
    : sql`TRUE`;
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
  // The org-wide default view drowns in finished POs, so clients can carve a
  // stage out (mobile sends excludeStatus=Done unless the Done chip is
  // active). An unknown label excludes nothing — the mirror of `status`,
  // where an unknown label matches nothing.
  const excludeStatus = c.req.query('excludeStatus');
  const excludeFrag = excludeStatus && STATUS_TO_LIFECYCLE[excludeStatus]
    ? sql`o.lifecycle <> ${STATUS_TO_LIFECYCLE[excludeStatus]}`
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
      o.other_fees::float AS other_fees,
      o.other_fees_note,
      o.paypal_txn_id,
      o.supplier_id, sup.name AS supplier_name,
      u.name AS user_name, u.initials AS user_initials,
      o.commission_rate::float AS commission_rate,
      w.id AS warehouse_id, w.short AS warehouse_short, w.region AS warehouse_region,
      COALESCE(SUM(l.qty), 0)::int                                                  AS qty,
      -- A line with no sell price contributes nothing: NULL drops out of SUM.
      -- It used to fall back to unit_cost, which invented revenue equal to the
      -- cost — so a PO nobody had priced yet reported its full cost as
      -- projected revenue. The spreadsheet and the edit screen never did that;
      -- this is the list catching up to them.
      COALESCE(SUM(l.sell_price * l.qty), 0)::float                                 AS revenue,
      -- The whole fee nets against the margin, so a PO whose lines aren't
      -- priced yet reads as a loss the size of its fees. That is intended: the
      -- fee is money already spent. It does mean this figure is deliberately
      -- more conservative than the edit screen's tape, which reports margin on
      -- priced lines alone and says outright that fees are not allocated there.
      (COALESCE(SUM((l.sell_price - l.unit_cost) * l.qty), 0)
         - o.other_fees)::float                                                     AS profit,
      COUNT(l.id)::int                                                              AS line_count,
      -- So the UI can explain a revenue figure that looks low rather than
      -- leaving the reader to wonder.
      COUNT(l.id) FILTER (WHERE l.sell_price IS NULL)::int                           AS unpriced_line_count,
      -- The row chip needs every category present, not just the derived header
      -- value, so a mixed PO can show what it actually holds. Free here: the
      -- query already groups by o.id over the joined lines.
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT l.category), NULL)                            AS categories
    FROM orders o
    JOIN users u      ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    LEFT JOIN suppliers sup ON sup.id = o.supplier_id
    LEFT JOIN order_lines l ON l.order_id = o.id
    WHERE ${scopeFrag} AND ${categoryFrag} AND ${statusFrag} AND ${excludeFrag} AND ${archivedFrag} ${cursorFrag}
    GROUP BY o.id, u.name, u.initials, w.id, w.short, w.region, sup.name
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
      categories: sortCategories((r.categories as string[] | null) ?? []),
      payment: r.payment,
      notes: r.notes,
      lifecycle: r.lifecycle,
      archivedAt: r.archived_at,
      createdAt: r.created_at,
      totalCost: r.total_cost,
      otherFees: r.other_fees,
      otherFeesNote: r.other_fees_note,
      paypalTxnId: r.paypal_txn_id,
      // Optional and additive: a stale SPA that never reads it is unaffected.
      supplier: r.supplier_id ? { id: r.supplier_id, name: r.supplier_name } : null,
      warehouse: r.warehouse_id ? { id: r.warehouse_id, short: r.warehouse_short, region: r.warehouse_region } : null,
      qty: r.qty,
      revenue: r.revenue,
      profit: r.profit,
      lineCount: r.line_count,
      unpricedLineCount: r.unpriced_line_count,
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
           o.other_fees::float AS other_fees,
           o.other_fees_note,
           o.paypal_txn_id,
           o.supplier_id, sup.name AS supplier_name,
           o.commission_rate::float AS commission_rate,
           u.name AS user_name, u.initials AS user_initials,
           w.id AS warehouse_id, w.short AS warehouse_short, w.region AS warehouse_region,
           (SELECT COUNT(*) FROM shipments s WHERE s.order_id = o.id)::int AS shipment_count
    FROM orders o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = o.warehouse_id
    LEFT JOIN suppliers sup ON sup.id = o.supplier_id
    WHERE o.id = ${id}
    LIMIT 1
  `)[0];

  if (!order) return c.json({ error: 'Not found' }, 404);
  if (effectiveRole(u) !== 'manager' && order.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);

  const lines = await sql`
    SELECT ol.id, ol.category, ol.brand, ol.capacity, ol.generation, ol.type, ol.classification,
           ol.rank, ol.speed, ol.interface, ol.form_factor, ol.description, ol.item_type,
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
  // One flat select stitched in JS rather than a lateral per line — same shape
  // as the status-meta rows above.
  const photoRows = await sql`
    SELECT id, order_line_id, filename, size_bytes, mime_type, delivery_url, uploaded_at
    FROM order_line_photos WHERE order_id = ${id}
    ORDER BY order_line_id, position, uploaded_at
  `;
  const photosByLine = new Map<string, LinePhoto[]>();
  for (const p of photoRows) {
    const key = p.order_line_id as string;
    if (!photosByLine.has(key)) photosByLine.set(key, []);
    photosByLine.get(key)!.push({
      id: p.id as string,
      url: p.delivery_url as string,
      source: 'upload',
      filename: p.filename as string,
      mime: p.mime_type as string,
      uploadedAt: String(p.uploaded_at),
    });
  }
  const everSubmitted = await wasEverSubmitted(sql, id);

  // Changes a purchaser made after submitting, that no manager has looked at
  // yet — the edit page opens a review dialog on them. Managers only: the
  // purchaser is the one who made the changes.
  const pendingRevert = effectiveRole(u) === 'manager'
    ? (await sql`
        SELECT e.id, e.detail, e.created_at,
               act.id AS actor_id, act.name AS actor_name, act.initials AS actor_initials
        FROM order_events e
        LEFT JOIN users act ON act.id = e.actor_id
        WHERE e.order_id = ${id} AND e.kind = 'reverted'
          AND ${unackedRevertFrag(sql, id)}
        ORDER BY e.created_at DESC, e.id DESC
      `).map(r => ({
        id: r.id,
        createdAt: r.created_at,
        detail: r.detail,
        actor: r.actor_id
          ? { id: r.actor_id, name: r.actor_name ?? '', initials: r.actor_initials ?? '' }
          : null,
      }))
    : null;

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
      categories: sortCategories([...new Set(lines.map(l => l.category as string).filter(Boolean))]),
      payment: order.payment,
      notes: order.notes,
      lifecycle: order.lifecycle,
      archivedAt: order.archived_at,
      status,
      statusMeta,
      pendingRevert,
      everSubmitted,
      createdAt: order.created_at,
      totalCost: order.total_cost,
      otherFees: order.other_fees,
      otherFeesNote: order.other_fees_note,
      paypalTxnId: order.paypal_txn_id,
      supplier: order.supplier_id ? { id: order.supplier_id, name: order.supplier_name } : null,
      commissionRate: order.commission_rate,
      warehouse: order.warehouse_id
        ? { id: order.warehouse_id, short: order.warehouse_short, region: order.warehouse_region }
        : null,
      // Count only — the mobile detail page renders a nav badge and shouldn't
      // have to download the labels themselves (those live on /shipping).
      shipmentCount: order.shipment_count,
      lines: lines.map(l => ({
        id: l.id,
        category: l.category,
        photos: linePhotos(l, photosByLine.get(l.id as string)),
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
        itemType: l.item_type,
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

// ── Mark the purchaser's post-submission changes as reviewed. One manager
// acknowledging clears the dialog for all of them: the point is that somebody
// looked, not that everybody did. A later edit writes a newer `reverted` event
// and arms it again.
orders.post('/:id/revert-ack', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);

  if (effectiveRole(u) !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const order = (await sql`SELECT id FROM orders WHERE id = ${id} LIMIT 1`)[0];
  if (!order) return c.json({ error: 'Not found' }, 404);

  const acknowledged = await sql.begin(async (tx) => {
    const pending = await tx<{ id: string }[]>`
      SELECT e.id FROM order_events e
      WHERE e.order_id = ${id} AND e.kind = 'reverted'
        AND ${unackedRevertFrag(tx, id)}
    `;
    // Nothing pending: acking anyway would leave a row saying a manager
    // reviewed changes that were already reviewed.
    if (pending.length > 0) {
      await writeOrderEvent(tx, id, u.id, 'revert_ack', {
        acknowledged: pending.length,
        ackedIds: pending.map(r => r.id),
      });
    }
    return pending.length;
  });

  return c.json({ ok: true, acknowledged });
});

const LIFECYCLE_LABEL: Record<string, string> = {
  draft: 'Draft', in_transit: 'In Transit', reviewing: 'Reviewing', done: 'Done',
};

const fmtTs = (v: unknown): string =>
  v ? new Date(v as string).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';

// ── PO spreadsheet (XLSX). Same access rules as GET /:id: owner + manager.
// A Payment tab with the header/payment fields, and a Line items tab with the
// costed lines. Reuses the shared exceljs builder.
//
// The line columns are a category's full spec set — the same table the
// inventory export renders — so a RAM PO carries rank/gen/speed/chip # in their
// own sortable columns. There is deliberately no composed `Item` label column:
// once every attribute has its own cell it only repeated them, unsorted.
//
// The sets are disjoint, so a PO spanning categories splits into one sheet per
// category (categoryTabSheets). A single-category PO keeps its one 'Line items'
// sheet exactly as before.
const PO_LINE_TAIL_COLS: XlsxColumn[] = [
  { header: 'Serial #',   key: 'serial',    width: 24 },
  { header: 'Qty',        key: 'qty',       width: 8,  numFmt: '#,##0' },
  { header: 'Unit cost',  key: 'unitCost',  width: 12, numFmt: '#,##0.00' },
  { header: 'Line total', key: 'lineTotal', width: 13, numFmt: '#,##0.00' },
  { header: 'Sell price', key: 'sellPrice', width: 12, numFmt: '#,##0.00' },
  { header: 'Sell total', key: 'sellTotal', width: 13, numFmt: '#,##0.00' },
  { header: 'Profit',     key: 'profit',    width: 12, numFmt: '#,##0.00' },
];

const poLineCols = (cat: ExportCategory): XlsxColumn[] => [
  ...SPEC_COLS_BY_CATEGORY[cat],
  ...PO_LINE_TAIL_COLS,
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
           o.other_fees::float AS other_fees, o.other_fees_note, o.paypal_txn_id,
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
           interface, form_factor, description, item_type, part_number, chip_number, serial_number,
           condition, qty, health::float AS health, rpm,
           unit_cost::float AS unit_cost, sell_price::float AS sell_price
    FROM order_lines WHERE order_id = ${id} ORDER BY position ASC
  ` as unknown as Record<string, unknown>[];

  // Mirror the invoice's payment summary: subtotal is the sum of line costs;
  // total_cost may be a manual override (negotiated lot price), and other_fees
  // is charged on top of whichever of the two applies.
  const subtotal = +lines.reduce((s, l) => s + Number(l.qty ?? 0) * Number(l.unit_cost ?? 0), 0).toFixed(2);
  const totalQty = lines.reduce((s, l) => s + Number(l.qty ?? 0), 0);
  const otherFees = Number(order.other_fees ?? 0);

  // Same allocation rule as lib/po-cost.ts — keep the two in sync. Cost-weighted
  // share of the order-level fee, with a flat per-unit fallback for a free lot
  // (every unit_cost 0) so the fee can't silently disappear.
  const effUnitCost = (unitCost: number): number =>
    subtotal > 0 ? unitCost + (otherFees * unitCost) / subtotal
    : totalQty > 0 ? unitCost + otherFees / totalQty
    : unitCost;

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
      ...lineSpecFields(l),
      // Read by categoryTabSheets to pick the sheet; not a declared column on
      // any of them, so it never renders.
      category: l.category,
      serial: String(l.serial_number ?? ''),
      qty,
      unitCost,
      lineTotal: +(qty * unitCost).toFixed(2),
      sellPrice,
      sellTotal: sellPrice != null ? +(qty * sellPrice).toFixed(2) : null,
      // unitCost / lineTotal stay raw — those columns are what was paid for the
      // goods, and the fee is disclosed on its own Payment row. Only profit
      // carries the fee share, per line rather than as one subtraction at the
      // bottom, so an unpriced line's share drops out the same way it does on
      // the dashboard.
      profit: sellPrice != null ? +(qty * (sellPrice - effUnitCost(unitCost))).toFixed(2) : null,
    };
  });

  // Derived from the LINES, so a legacy PO whose header disagrees with its sole
  // line still renders that line's columns.
  // Through sortCategories, not a bare indexOf: an unknown category scores -1
  // there and would sort ahead of RAM, so the workbook's tabs and the chips on
  // screen would disagree about the same order.
  const lineCats = sortCategories([...new Set(lines.map(l => exportCategory(l.category)))]);

  const goodsCost = order.total_cost != null ? +Number(order.total_cost).toFixed(2) : subtotal;
  const totalCost = +(goodsCost + otherFees).toFixed(2);
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
    { field: 'Category',              value: lineCats.length > 1 ? lineCats.join(' · ') : String(order.category ?? '') },
    { field: 'Warehouse',             value: warehouse },
    { field: 'Payment method',        value: order.payment === 'self' ? 'Self pay' : 'Company pay' },
    { field: 'Total quantity',        value: totalQty },
    // Subtotal -> Other fees -> Total cost reads as an arithmetic column, which
    // is why the fee rows sit here rather than at the bottom.
    { field: 'Subtotal (line costs)', value: subtotal },
    { field: 'Other fees',            value: otherFees },
    { field: 'Other fees note',       value: String(order.other_fees_note ?? '') },
    { field: 'Total cost',            value: totalCost },
    { field: 'Projected sell value',  value: projectedRevenue },
    { field: 'Projected profit',      value: projectedProfit },
    { field: 'Commission rate',       value: commissionRate != null ? `${(commissionRate * 100).toFixed(2)}%` : '—' },
    { field: 'Commission amount',     value: commissionAmount != null ? commissionAmount : '—' },
    { field: 'Notes',                 value: String(order.notes ?? '') },
    { field: 'PayPal transaction ID', value: String(order.paypal_txn_id ?? '') },
  ];

  const buf = await buildXlsxWorkbook([
    { name: 'Payment', columns: PO_PAYMENT_COLS, rows: paymentRows },
    ...categoryTabSheets(lineRows, poLineCols, {
      singleSheetName: 'Line items',
      emptySheetName: 'Line items',
    }),
  ]);
  return xlsxResponse(buf, `${order.id}.xlsx`);
});

// ── Create a new order with its lines (purchaser submits from phone).
orders.post('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as
    | {
        // Optional since a PO may mix categories: it is only a fallback for
        // lines that don't name their own. The stored order category is
        // derived from the lines (see syncOrderCategory).
        category?: LineCategory;
        warehouseId?: string;
        payment?: 'company' | 'self';
        notes?: string;
        totalCost?: number;
        otherFees?: number;
        otherFeesNote?: string | null;
        onBehalfOfUserId?: string;
        /** The client we bought from. Optional — a PO can be filed before
         *  anyone says who it came from. */
        supplierId?: string | null;
        lines: LineInput[];
      }
    | null;
  if (!body || !Array.isArray(body.lines) || body.lines.length === 0) {
    return c.json({ error: 'at least one line is required' }, 400);
  }
  const owner = await resolveOrderOwner(sql, u, body.onBehalfOfUserId);
  if ('error' in owner) return c.json({ error: owner.error }, owner.status);
  const whErr = await warehouseErr(sql, body.warehouseId ?? null);
  if (whErr) return c.json({ error: whErr }, 400);
  // No warehouse named → the owner's home warehouse (FK-valid by construction).
  // The owner's, not the actor's: a manager filing on behalf ships to the
  // purchaser's location.
  const warehouseId = body.warehouseId ?? owner.ownerDefaultWarehouseId;
  const lineCats: string[] = [];
  for (let i = 0; i < body.lines.length; i++) {
    const cat = body.lines[i].category ?? body.category;
    if (!cat) return c.json({ error: `line ${i + 1}: category is required` }, 400);
    lineCats.push(cat);
  }

  // Every category a line claims must exist and be enabled — checked per line,
  // not once on the order, now that one PO can span several.
  const catErr = await assertCategoriesEnabled(sql, lineCats);
  if (catErr) return c.json({ error: catErr }, 400);

  const feeErr = badFees(body);
  if (feeErr) return c.json({ error: feeErr }, 400);

  for (let i = 0; i < body.lines.length; i++) {
    const l = body.lines[i];
    const issue = serialIssue({ ...l, category: lineCats[i] });
    if (issue) return c.json({ error: serialErr(`line ${i + 1}`, issue) }, 400);
    const labelErr = identityErr(`line ${i + 1}`, lineCats[i], l);
    if (labelErr) return c.json({ error: labelErr }, 400);
  }

  // Human-friendly id like PO-1289, allocated atomically (see id-seq.ts).
  // Allocated inside the transaction so a rollback also rolls back the counter.
  let newId!: string;
  // Returned so the client can attach per-line photos, which are buffered
  // locally until the line it belongs to actually exists. Aligned 1:1 with
  // the request's `lines` ordering, the same contract PATCH's addedLineIds has.
  const newLineIds: string[] = [];
  let derived: { category: string | null; categories: string[] } = { category: null, categories: [] };
  await sql.begin(async (tx) => {
    newId = await nextHumanId(tx, 'PO', 'PO');
    await tx`
      INSERT INTO orders (
        id, user_id, category, warehouse_id, payment, notes, total_cost,
        other_fees, other_fees_note, lifecycle, supplier_id
      )
      VALUES (
        ${newId}, ${owner.ownerId}, ${deriveCategory(lineCats) ?? lineCats[0]},
        ${warehouseId}, ${body.payment ?? 'company'}, ${body.notes ?? null},
        ${body.totalCost ?? null},
        ${body.otherFees ?? 0}, ${normFeeNote(body.otherFeesNote)}, 'draft',
        ${body.supplierId ?? null}
      )
    `;
    for (let i = 0; i < body.lines.length; i++) {
      const l = body.lines[i];
      const inserted = await tx`
        INSERT INTO order_lines (
          order_id, category, brand, capacity, generation, type, classification, rank, speed,
          interface, form_factor, description, item_type, part_number, serial_number, chip_number, condition, qty,
          unit_cost, sell_price, status, scan_image_id, scan_confidence, position,
          health, rpm
        ) VALUES (
          ${newId}, ${lineCats[i]}, ${l.brand ?? null}, ${l.capacity ?? null}, ${l.generation ?? null}, ${l.type ?? null},
          ${l.classification ?? null}, ${l.rank ?? null}, ${l.speed ?? null},
          ${l.interface ?? null}, ${l.formFactor ?? null}, ${l.description ?? null}, ${l.itemType?.trim() || null},
          ${resolvePartNumber(lineCats[i], l)}, ${l.serialNumber ?? null}, ${canonChipNumber(l.chipNumber)}, ${l.condition ?? 'Pulled — Tested'}, ${l.qty},
          ${l.unitCost}, ${normSellPrice(l.sellPrice)}, 'Draft',
          ${l.scanImageId ?? null}, ${l.scanConfidence ?? null}, ${i},
          ${l.health ?? null}, ${l.rpm ?? null}
        )
        RETURNING id
      ` as { id: string }[];
      newLineIds.push(inserted[0].id);
    }
    await autoTrackParts(tx, body.lines.map((l, i) => ({
      category: lineCats[i],
      partNumber: resolvePartNumber(lineCats[i], l),
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

    // Written before the event so `created` carries the value the order
    // actually ended up with rather than whatever the client proposed.
    derived = await syncOrderCategory(tx, newId);
    // The goods total follows the lines unless this request stated one of its
    // own — the create path is the one place a negotiated lot price can still
    // enter, since no screen offers a field for it any more. Zero is not one
    // of those: taking it literally pinned the column at $0 against real lines
    // with nothing left anywhere able to correct it.
    await syncOrderGoodsTotal(tx, newId, !(Number(body.totalCost) > 0));

    // Baseline of the timeline. Without it a freshly-created PO reads as an
    // order with no history at all until someone submits it.
    await writeOrderEvent(tx, newId, u.id, 'created', {
      category: derived.category,
      categories: derived.categories,
      lineCount: body.lines.length,
      qty: body.lines.reduce((s, l) => s + Number(l.qty ?? 0), 0),
      totalCost: body.totalCost ?? null,
      otherFees: body.otherFees ?? 0,
      // Present only when a manager filed the PO for someone else, so the
      // timeline can say who the order was created for. The name is snapshot
      // here because events render without joining users on the owner.
      ...(owner.ownerId !== u.id
        ? { onBehalfOfUserId: owner.ownerId, onBehalfOfName: owner.ownerName }
        : {}),
    });
  });

  return c.json({ id: newId, lineIds: newLineIds }, 201);
});

// ── Edit — update order meta + line item details. The order owner
// (purchaser) or a manager may PATCH. Draft is purchaser-editable; later
// stages are manager-only apart from `notes` — enforced here, not just in the
// client, so a purchaser can't rewrite costs/lines on an order under review.
//
// Line shape on the wire:
//   lines:          updates for existing lines (each carries `id`)
//   addLines:       new line rows to INSERT (no `id`)
//   removeLineIds:  ids to DELETE (will 409 if referenced by sell_order_lines)
type LineFields = {
  // Editable: a line filed under the wrong category is corrected in place
  // rather than deleted and retyped. Switching clears the spec fields the old
  // category owned — see staleSpecDbCols.
  category?: LineCategory;
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
  itemType?: string | null;
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

// `materialEdit` below says the request *carries* a field the manager review is
// about. These say it actually *changes* one, compared under the same
// normalisations the UPDATE writes with — so a purchaser re-saving a line
// untouched, or a queued autosave replaying, never drops a submitted order back
// to Draft and hands a manager an empty change set to review.
function sameStoredValue(before: unknown, after: unknown): boolean {
  const blank = (v: unknown) => v === null || v === undefined || v === '';
  if (typeof before === 'number' || typeof after === 'number') {
    if (blank(before) || blank(after)) return blank(before) && blank(after);
    const a = Number(before);
    const b = Number(after);
    // NUMERIC columns arrive as floats, and a client that rounds one for
    // display sends back a value that differs only in the last bits.
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
  }
  return JSON.stringify(blank(before) ? null : before) === JSON.stringify(blank(after) ? null : after);
}

const LINE_FIELD_SET: ReadonlySet<string> = new Set(LINE_FIELDS);

function changesMaterialField(
  body: {
    lines?: LinePatch[]; addLines?: unknown[]; removeLineIds?: string[];
    totalCost?: number | null; otherFees?: number | null; otherFeesNote?: string | null;
    warehouseId?: string | null; payment?: string; paypalTxnId?: string | null;
  },
  before: Record<string, unknown>,
  linesBefore: Map<string, Record<string, unknown>>,
): boolean {
  if (body.addLines?.length) return true;
  // Ids this order no longer holds delete nothing — the DELETE is keyed off the
  // rows it finds, not off the request's list.
  if (body.removeLineIds?.some(lineId => linesBefore.has(lineId))) return true;

  for (const patch of body.lines ?? []) {
    const row = linesBefore.get(patch.id);
    if (!row) continue;
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'id') continue;
      const col = key.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`);
      // Anything outside LINE_FIELDS is not part of the record a manager
      // reviews (scan refs, positions) and does not cost the order its stage.
      if (!LINE_FIELD_SET.has(col)) continue;
      if (!sameStoredValue(row[col], value)) return true;
    }
  }

  // Only a positive figure is a stated goods total; anything else is "not
  // stated" and writes nothing. Same reading as the UPDATE below.
  if (body.totalCost !== undefined && Number(body.totalCost) > 0
      && !sameStoredValue(before.total_cost, Number(body.totalCost))) return true;
  if (body.otherFees !== undefined
      && !sameStoredValue(before.other_fees, Number(body.otherFees ?? 0))) return true;
  if (body.otherFeesNote !== undefined
      && !sameStoredValue(before.other_fees_note, normFeeNote(body.otherFeesNote))) return true;
  if (body.warehouseId !== undefined
      && !sameStoredValue(before.warehouse_id, body.warehouseId)) return true;
  if (body.payment !== undefined && body.payment !== before.payment) return true;
  if (body.paypalTxnId !== undefined) {
    const norm = typeof body.paypalTxnId === 'string'
      ? body.paypalTxnId.replace(/\s+/g, '').toUpperCase() || null
      : null;
    if (!sameStoredValue(before.paypal_txn_id, norm)) return true;
  }
  return false;
}

// The stored shape PATCH reads before writing: enough to merge a patch against
// (category/serial/item-type rules) and to tell a synthetic part number from a
// typed one when a line changes category.
type StoredLine = {
  id: string;
  category: string | null;
  generation: string | null;
  qty: number;
  serial_number: string | null;
  item_type: string | null;
  part_number: string | null;
  brand: string | null;
  capacity: string | null;
  interface: string | null;
  form_factor: string | null;
  speed: string | null;
  rpm: number | null;
};

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
        supplierId?: string | null;
        otherFees?: number | null;
        otherFeesNote?: string | null;
        notes?: string | null;
        warehouseId?: string | null;
        payment?: 'company' | 'self';
        commissionRate?: number | null;
        paypalTxnId?: string | null;
        onBehalfOfUserId?: string | null;
      }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const existing = (await sql`SELECT user_id, category, lifecycle FROM orders WHERE id = ${id} LIMIT 1`)[0];
  if (!existing) return c.json({ error: 'Not found' }, 404);
  if (u.role !== 'manager' && existing.user_id !== u.id) return c.json({ error: 'Forbidden' }, 403);
  // The purchaser owns their order until it is Done: goods arrive miscounted,
  // fees land late, a line turns out to be something else. What they may not
  // do is change it under a manager who has already reviewed it — so a change
  // to anything the review is about sends the order back to Draft (below, in
  // the tx, where the lifecycle read is locked). `notes` is not such a field:
  // receipts and shipping details keep arriving after the goods leave, and
  // appending one leaves the order where it stands.
  const materialEdit =
    !!body.lines?.length || !!body.addLines?.length || !!body.removeLineIds?.length ||
    body.totalCost !== undefined || body.otherFees !== undefined ||
    body.otherFeesNote !== undefined || body.warehouseId !== undefined ||
    body.payment !== undefined || body.paypalTxnId !== undefined;
  if (u.role !== 'manager' && existing.lifecycle !== 'draft') {
    // A Done PO is a closed book to the purchaser, note included.
    if (existing.lifecycle === 'done') {
      return c.json({ error: 'Only managers can edit an order after submission' }, 403);
    }
    if (!materialEdit && body.notes === undefined && body.supplierId === undefined) {
      return c.json({ error: 'Only managers can edit an order after submission' }, 403);
    }
  }
  if (body.commissionRate !== undefined && u.role !== 'manager') {
    return c.json({ error: 'Only managers can set the commission rate' }, 403);
  }
  // Owner reassignment: same manager-only rule as creating on behalf of
  // someone else, validated up front so a bad target fails before the tx.
  // `null` (or the manager's own id) hands the order back to the manager.
  if (body.onBehalfOfUserId !== undefined && u.role !== 'manager') {
    return c.json({ error: 'Only managers can change the order owner' }, 403);
  }
  let newOwner: { ownerId: string; ownerName: string | null } | undefined;
  if (body.onBehalfOfUserId !== undefined) {
    const resolved = await resolveOrderOwner(sql, u, body.onBehalfOfUserId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    newOwner = resolved;
  }
  if (typeof body.paypalTxnId === 'string' && body.paypalTxnId.replace(/\s+/g, '').length > 64) {
    return c.json({ error: 'PayPal transaction ID is too long' }, 400);
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

  const feeErr = badFees(body);
  if (feeErr) return c.json({ error: feeErr }, 400);

  // null clears the warehouse; a non-null value must exist (same boundary
  // check as the create endpoints — "" would 500 on the FK inside the tx).
  if (body.warehouseId !== undefined) {
    const whErr = await warehouseErr(sql, body.warehouseId ?? null);
    if (whErr) return c.json({ error: whErr }, 400);
  }

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

  // Serial rules. New rows are validated outright (defaults mirror the
  // INSERT below); existing-row patches only when the merged value (patch ??
  // stored — the same null-keeps-old semantics as the COALESCE in the UPDATE)
  // actually CHANGES serial/qty/generation. The edit forms echo every field
  // back on save, so a mere "touched" test would retro-block price/status
  // edits on legacy serial-less lines.

  // A new line may inherit the order's category, but orders.category is a
  // DERIVATION of the lines — it reads 'Mixed' when they disagree, and an empty
  // draft holds 'Mixed' as a placeholder. Neither is a category a line may
  // claim, so there is nothing to inherit and the request has to name one.
  const inheritedCat =
    existing.category && existing.category !== 'Mixed' ? (existing.category as string) : null;
  const addCats: string[] = [];
  for (let i = 0; i < (body.addLines ?? []).length; i++) {
    const l = body.addLines![i];
    const cat = l.category ?? inheritedCat;
    if (!cat) return c.json({ error: `line ${i + 1}: category is required` }, 400);
    addCats.push(cat);
    const issue = serialIssue({ ...l, category: cat, qty: l.qty ?? 1 });
    if (issue) return c.json({ error: serialErr(`line ${i + 1}`, issue) }, 400);
    const labelErr = identityErr(`line ${i + 1}`, cat, l);
    if (labelErr) return c.json({ error: labelErr }, 400);
  }

  // One pre-read covering both the item-type and the serial rules. Each is
  // evaluated against the line's OWN category merged with the patch — the
  // order's category is derived from its lines and says nothing about any
  // individual one.
  const patchIds = (body.lines ?? []).map(l => l.id);
  const storedById = new Map<string, StoredLine>();
  if (patchIds.length) {
    const rows = await sql`
      SELECT id, category, generation, qty, serial_number, item_type, part_number,
             brand, capacity, interface, form_factor, speed, rpm
      FROM order_lines
      WHERE order_id = ${id} AND id = ANY(${patchIds}::uuid[])
    ` as StoredLine[];
    for (const r of rows) storedById.set(r.id, r);
  }

  // Categories this request actually PUTS a line into: every new line's
  // resolved category (a new line inheriting the order's must be checked too —
  // reading the raw field would let it be filed under a disabled one), and only
  // those existing lines whose category really moves. The edit forms echo
  // `category` back on every line, so testing the raw field instead would
  // retro-block a price edit on any PO holding a legacy line of a category
  // that has since been turned off.
  const touchedCats = [...addCats];

  for (const l of body.lines ?? []) {
    const row = storedById.get(l.id);
    if (!row) continue; // unknown ids no-op in the UPDATE below too
    const mergedCat = l.category ?? row.category ?? undefined;
    if (l.category !== undefined && l.category !== row.category) touchedCats.push(l.category);

    // Checked when the patch carries the item type, and when it moves the line
    // between categories — switching INTO Other without naming a type in the
    // same patch would otherwise land an unidentifiable line. Lines predating
    // item types hold NULL, so an untouched one is left alone.
    if (l.itemType !== undefined || l.category !== undefined) {
      const merged = l.itemType !== undefined ? l : { itemType: row.item_type };
      const labelErr = identityErr(`line ${l.id}`, mergedCat, merged);
      if (labelErr) return c.json({ error: labelErr }, 400);
    }

    // Generation belongs to RAM alone, so a line leaving RAM has it cleared —
    // evaluate the post-clear value, or switching a DDR5 line to SSD would
    // still demand serials for a generation the line no longer has.
    const clearing = l.category !== undefined && l.category !== row.category
      ? new Set(staleSpecDbCols(l.category))
      : new Set<string>();
    const merged = {
      generation: clearing.has('generation') ? null : (l.generation ?? row.generation),
      qty: l.qty ?? row.qty,
      serialNumber: l.serialNumber ?? row.serial_number,
    };
    const changes =
      l.category !== undefined && l.category !== row.category ||
      (merged.generation ?? null) !== (row.generation ?? null) ||
      Number(merged.qty) !== Number(row.qty) ||
      (merged.serialNumber ?? '') !== (row.serial_number ?? '');
    if (!changes) continue;
    const issue = serialIssue({ category: mergedCat ?? null, ...merged });
    if (issue) return c.json({ error: serialErr(`line ${l.id}`, issue) }, 400);
  }

  const patchCatErr = await assertCategoriesEnabled(sql, touchedCats);
  if (patchCatErr) return c.json({ error: patchCatErr }, 400);

  // R2 keys of label scans whose lines get removed — deleted after the tx
  // commits (R2 isn't transactional; never delete on a rolled-back change).
  const removedScanKeys: string[] = [];

  // Surfaced so the mobile autosave path can capture the new DB id of each
  // appended line; aligns 1:1 with the request's `addLines` ordering. Populated
  // inside the tx and only read after the tx commits.
  const addedLineIds: string[] = [];

  // Where the order ends up. Returned to the client so an edit that moved the
  // stage doesn't need a refetch to be shown correctly.
  let lifecycleAfter = existing.lifecycle as string;
  // The stage a purchaser edit pulled the order back from — set only when the
  // revert ran, and the flag the audit block writes its `reverted` event on.
  let revertedFrom: string | null = null;
  let committedLineIds: string[] = [];

  try {
    await sql.begin(async (tx) => {
      // Lock the order + read fields we need for audit-diffing. The lock keeps
      // a concurrent advance from changing lifecycle between our pre/post
      // snapshots, so the diff describes one settled state transition.
      const orderBefore = (await tx`
        SELECT id, user_id, lifecycle, notes, warehouse_id, payment,
               total_cost::float AS total_cost,
               commission_rate::float AS commission_rate,
               other_fees::float AS other_fees,
               other_fees_note,
               paypal_txn_id,
               supplier_id
        FROM orders WHERE id = ${id} LIMIT 1 FOR UPDATE
      `)[0] as
        | { id: string; user_id: string; lifecycle: string; notes: string | null;
            warehouse_id: string | null;
            payment: string; total_cost: number | null; commission_rate: number | null;
            other_fees: number; other_fees_note: string | null; paypal_txn_id: string | null;
            supplier_id: string | null }
        | undefined;
      if (!orderBefore) throw new Error('order disappeared mid-edit');
      lifecycleAfter = orderBefore.lifecycle;
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
          // The fee note is frozen alongside the amount: it is metadata on a
          // closed-book cost, not the free-append `notes` field.
          body.otherFees !== undefined ||
          body.otherFeesNote !== undefined ||
          body.commissionRate !== undefined ||
          // The payment reference is part of the closed book too.
          body.paypalTxnId !== undefined ||
          // Ownership decides whose closed book this is — commission and
          // "my orders" both key off it, so it freezes with the rest.
          body.onBehalfOfUserId !== undefined;
        if (touchesFrozen) {
          // Outcome thrown out of the tx callback — the surrounding try/catch
          // re-throws unrecognised errors, so we encode the response intent
          // on the error message instead.
          throw new Error('__DONE_LOCKED__');
        }
        // The pre-tx read may have seen an earlier stage: a concurrent advance
        // to Done must close the book on the purchaser here too, not revert it.
        if (u.role !== 'manager') throw new Error('__PURCHASER_DONE__');
      }

      // Read before anything moves: afterwards a goods total that merely went
      // stale is indistinguishable from one that was negotiated. Only asked
      // when this request will actually change the lines, and skipped when it
      // states a goods total outright — then the client's figure is the answer.
      const touchesLines = !!(body.lines || body.addLines || body.removeLineIds);
      // Only a positive figure is a negotiated lot price. POST reads it the
      // same way, and for the same reason: stored literally, a 0 pins the
      // column at $0 against real lines, and no screen sends a totalCost any
      // more to put it back. Anything else non-positive (or unparseable) is
      // read as "not stated" rather than written through.
      const statedGoods = Number(body.totalCost) > 0 ? Number(body.totalCost) : undefined;
      const goodsFollowsLines = (touchesLines || body.totalCost !== undefined) && statedGoods === undefined
        ? await goodsTotalIsMirror(tx, id)
        : false;

      // Snapshot the lines we'll edit / remove so we can diff after the writes.
      // NUMERIC columns come back as strings from postgres.js by default; cast
      // to float so the diff compares numbers, not "120.00" string forms.
      // The ids being removed ride along so the no-op check below can tell a
      // real removal from a replay naming rows that are already gone.
      const editIds = [
        ...(Array.isArray(body.lines) ? body.lines.map(l => l.id) : []),
        ...(Array.isArray(body.removeLineIds) ? body.removeLineIds : []),
      ];
      const linesBefore = editIds.length
        ? await tx`
            SELECT id, status, qty, category, brand, capacity, type, generation, classification,
                   rank, speed, interface, form_factor, description, item_type, part_number,
                   serial_number, chip_number, condition, rpm,
                   unit_cost::float AS unit_cost,
                   sell_price::float AS sell_price,
                   health::float AS health
            FROM order_lines WHERE order_id = ${id} AND id = ANY(${editIds}::uuid[])`
        : [];
      const beforeMap = new Map<string, Record<string, unknown>>(
        linesBefore.map(l => [l.id as string, l as Record<string, unknown>]));

      // Back to Draft before anything is written, so the lines this request
      // adds are inserted at the stage the order is landing in rather than the
      // one it is leaving. The snapshot above is a read, so it is safe to take
      // first — and it is what tells a real edit from a no-op re-save. The
      // guards inside run against the pre-edit lines, so the ids they report
      // are the ones the client can see.
      if (u.role !== 'manager' && orderBefore.lifecycle !== 'draft' && materialEdit
          && changesMaterialField(body, orderBefore as unknown as Record<string, unknown>, beforeMap)) {
        const outcome = await revertOrderToDraftTx(tx, id, u, orderBefore.lifecycle);
        if (outcome.kind === 'committedLines') {
          committedLineIds = outcome.offendingLineIds;
          throw new Error('__REVERT_COMMITTED__');
        }
        if (outcome.kind === 'transferClaimed') {
          committedLineIds = outcome.offendingLineIds;
          throw new Error('__REVERT_TRANSFER__');
        }
        revertedFrom = outcome.from;
        lifecycleAfter = 'draft';
      }

      let removedSnapshots: Array<{ id: string; category: string; part_number: string | null; qty: number; unit_cost: number }> = [];

      const touchesOrder =
        body.totalCost !== undefined ||
        body.otherFees !== undefined ||
        body.otherFeesNote !== undefined ||
        body.notes !== undefined ||
        body.warehouseId !== undefined ||
        body.payment !== undefined ||
        body.commissionRate !== undefined ||
        body.paypalTxnId !== undefined ||
        body.supplierId !== undefined;
      if (touchesOrder) {
        // Nullable fields use a CASE WHEN sentinel so the client can clear
        // them by sending `null`; bare COALESCE would treat null as "no
        // change" and silently keep the old value. `payment` is a non-null
        // enum, so COALESCE is correct for it.
        const setTotalCost = statedGoods !== undefined ? 1 : 0;
        const setNotes     = body.notes       !== undefined ? 1 : 0;
        const setWarehouse = body.warehouseId !== undefined ? 1 : 0;
        const setCommission = body.commissionRate !== undefined ? 1 : 0;
        const setOtherFees = body.otherFees     !== undefined ? 1 : 0;
        const setFeesNote  = body.otherFeesNote !== undefined ? 1 : 0;
        const setPaypal    = body.paypalTxnId   !== undefined ? 1 : 0;
        const setSupplier  = body.supplierId    !== undefined ? 1 : 0;
        // Same canon as the add-package boundary — a pasted id with spaces or
        // lowercase must diff clean against the AI-extracted value.
        const normPaypal = typeof body.paypalTxnId === 'string'
          ? body.paypalTxnId.replace(/\s+/g, '').toUpperCase() || null
          : null;
        await tx`
          UPDATE orders SET
            total_cost   = CASE WHEN ${setTotalCost}::int = 1 THEN ${statedGoods ?? null}      ELSE total_cost   END,
            notes        = CASE WHEN ${setNotes}::int     = 1 THEN ${body.notes ?? null}       ELSE notes        END,
            warehouse_id = CASE WHEN ${setWarehouse}::int = 1 THEN ${body.warehouseId ?? null} ELSE warehouse_id END,
            commission_rate = CASE WHEN ${setCommission}::int = 1 THEN ${clampedRate ?? null} ELSE commission_rate END,
            paypal_txn_id = CASE WHEN ${setPaypal}::int = 1 THEN ${normPaypal} ELSE paypal_txn_id END,
            supplier_id  = CASE WHEN ${setSupplier}::int = 1 THEN ${body.supplierId ?? null} ELSE supplier_id END,
            -- other_fees is NOT NULL: a client clearing the field sends null and
            -- means 0, so the sentinel writes 0 rather than passing the null
            -- through into the constraint. The note is nullable and follows the
            -- same clear-with-null contract as notes/warehouse_id.
            other_fees      = CASE WHEN ${setOtherFees}::int = 1 THEN ${Number(body.otherFees ?? 0)}    ELSE other_fees      END,
            other_fees_note = CASE WHEN ${setFeesNote}::int  = 1 THEN ${normFeeNote(body.otherFeesNote)} ELSE other_fees_note END,
            payment      = COALESCE(${body.payment ?? null}, payment)
          WHERE id = ${id}
        `;
      }
      // Owner moves under the same lock as the meta fields, with its own
      // event kind: user_id isn't a META_FIELD (the timeline names people,
      // not a uuid diff), and both names are snapshotted here because events
      // render without joining users on the owner.
      if (newOwner && newOwner.ownerId !== orderBefore.user_id) {
        const prev = (await tx`
          SELECT name FROM users WHERE id = ${orderBefore.user_id} LIMIT 1
        `)[0] as { name: string } | undefined;
        await tx`UPDATE orders SET user_id = ${newOwner.ownerId} WHERE id = ${id}`;
        await writeOrderEvent(tx, id, u.id, 'owner_changed', {
          fromUserId: orderBefore.user_id,
          from: prev?.name ?? null,
          toUserId: newOwner.ownerId,
          to: newOwner.ownerName ?? u.name,
        });
      }
      if (Array.isArray(body.removeLineIds) && body.removeLineIds.length) {
        const doomed = await tx`
          SELECT id, category, scan_image_id, part_number, qty, unit_cost::float AS unit_cost FROM order_lines
          WHERE order_id = ${id} AND id = ANY(${body.removeLineIds}::uuid[])
        ` as { id: string; category: string; scan_image_id: string | null; part_number: string | null; qty: number; unit_cost: number }[];
        removedSnapshots = doomed.map(r => ({ id: r.id, category: r.category, part_number: r.part_number, qty: r.qty, unit_cost: r.unit_cost }));
        // Read before the DELETE cascades the rows away. Same list as the scan
        // keys, so the existing post-commit sweep covers both.
        //
        // Keyed off `doomed`, NOT the raw removeLineIds: the request's ids are
        // unverified, and an id belonging to somebody else's PO would delete
        // that PO's objects out of R2 while its rows survived pointing at them.
        const doomedPhotos = doomed.length ? await tx`
          SELECT storage_key FROM order_line_photos
          WHERE order_line_id = ANY(${doomed.map(r => r.id)}::uuid[])
        ` as { storage_key: string }[] : [];
        for (const p of doomedPhotos) removedScanKeys.push(p.storage_key);
        await tx`DELETE FROM order_lines WHERE order_id = ${id} AND id = ANY(${body.removeLineIds}::uuid[])`;

        // A scan key is NOT owned by the line that carries it: a partial
        // transfer clones scan_image_id onto a second line in the same order,
        // so deleting one of the pair would take the survivor's picture with
        // it. Photo storage_keys need no such test — each upload mints its own
        // key and the clone doesn't copy the rows.
        const doomedScans = doomed.map(r => r.scan_image_id).filter(Boolean) as string[];
        if (doomedScans.length) {
          const stillUsed = new Set((await tx`
            SELECT DISTINCT scan_image_id FROM order_lines
            WHERE scan_image_id = ANY(${doomedScans})
          ` as { scan_image_id: string }[]).map(r => r.scan_image_id));
          for (const k of doomedScans) if (!stillUsed.has(k)) removedScanKeys.push(k);
        }
      }
      if (Array.isArray(body.lines)) {
        // Re-read under the order lock. `storedById` was read on the pool
        // before the transaction and is right for the 400-level validation,
        // but it decides the spec-column clear below — and a concurrent patch
        // that committed a category switch in between leaves it claiming the
        // OLD category, so the clear is skipped and the row keeps columns the
        // category it now holds does not own.
        const lockedById = new Map<string, StoredLine>();
        const lockedRows = await tx`
          SELECT id, category, generation, qty, serial_number, item_type, part_number,
                 brand, capacity, interface, form_factor, speed, rpm
          FROM order_lines
          WHERE order_id = ${id} AND id = ANY(${body.lines.map(l => l.id)}::uuid[])
        ` as StoredLine[];
        for (const r of lockedRows) lockedById.set(r.id, r);

        for (let l of body.lines) {
          const stored = lockedById.get(l.id);
          // Clear-then-apply. A line moving to a new category first has the old
          // category's spec columns NULLed (the COALESCE update below can only
          // write values, never clear them), then the normal update re-applies
          // whatever the patch carries for the new one.
          if (stored && l.category !== undefined && l.category !== stored.category) {
            const stale = staleSpecDbCols(l.category);
            if (stale.length) {
              await tx`
                UPDATE order_lines SET ${tx(Object.fromEntries(stale.map(col => [col, null])))}
                WHERE id = ${l.id} AND order_id = ${id}
              `;
            }
            // A synthetic part number describes the specs of the category it was
            // built from, so it has to be rebuilt — while a typed/OCR one is the
            // manufacturer's and stays. Never written back as NULL: inventory
            // grouping and reference pricing are both keyed on this column.
            const wasSynthetic = !!stored.part_number
              && stored.part_number === synthesizePartNumber(stored.category ?? '', {
                brand: stored.brand, capacity: stored.capacity, interface: stored.interface,
                formFactor: stored.form_factor, generation: stored.generation,
                speed: stored.speed, rpm: stored.rpm,
              });
            if (wasSynthetic) {
              const keep = (col: string) => !stale.includes(col);
              const rebuilt = synthesizePartNumber(l.category, {
                brand:       l.brand      ?? (keep('brand')       ? stored.brand : null),
                capacity:    l.capacity   ?? (keep('capacity')    ? stored.capacity : null),
                interface:   l.interface  ?? (keep('interface')   ? stored.interface : null),
                formFactor:  l.formFactor ?? (keep('form_factor') ? stored.form_factor : null),
                generation:  l.generation ?? (keep('generation')  ? stored.generation : null),
                speed:       l.speed      ?? (keep('speed')       ? stored.speed : null),
                rpm:         l.rpm        ?? (keep('rpm')         ? stored.rpm : null),
              });
              if (rebuilt) l = { ...l, partNumber: rebuilt };
            }
          }
          const setSellPrice = l.sellPrice !== undefined ? 1 : 0;
          // `status` is deliberately NOT settable here. Line status is driven
          // by the lifecycle (advance handler) and 'Sold' is a protected
          // terminal state; accepting a client-supplied status would let any
          // editor forge 'Sold'/'Done' and defeat the sell-order/inventory
          // guards that key off it. order_lines.status has no CHECK, so this
          // route layer is the gate.
          await tx`
            UPDATE order_lines SET
              category       = COALESCE(${l.category ?? null}, category),
              sell_price     = CASE WHEN ${setSellPrice}::int = 1 THEN ${normSellPrice(l.sellPrice)} ELSE sell_price END,
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
              item_type     = COALESCE(${l.itemType?.trim() || null}, item_type),
              part_number    = COALESCE(${l.partNumber ?? null}, part_number),
              serial_number  = COALESCE(${l.serialNumber ?? null}, serial_number),
              -- '' means "cleared by the user" (the edit forms always send the
              -- field); NULLIF turns it into NULL instead of storing ''.
              chip_number    = NULLIF(COALESCE(${canonChipNumber(l.chipNumber)}, chip_number), ''),
              condition      = COALESCE(${l.condition ?? null}, condition),
              health         = COALESCE(${l.health ?? null}, health),
              rpm            = COALESCE(${l.rpm ?? null}, rpm),
              scan_image_id  = COALESCE(${l.scanImageId ?? null}, scan_image_id),
              scan_confidence = COALESCE(${l.scanConfidence ?? null}, scan_confidence)
            WHERE id = ${l.id} AND order_id = ${id}
          `;
        }
      }
      let addedRows: Array<{ id: string; category: string; part_number: string | null; qty: number; unit_cost: number }> = [];
      if (Array.isArray(body.addLines) && body.addLines.length) {
        // New lines default to the order's category. Position appends after
        // current max so they sort to the end.
        const posRow = (await tx`SELECT COALESCE(MAX(position), -1) AS p FROM order_lines WHERE order_id = ${id}`)[0] as { p: number };
        let pos = posRow.p + 1;
        for (let i = 0; i < body.addLines.length; i++) {
          const l = body.addLines[i];
          const cat = addCats[i];
          const inserted = await tx`
            INSERT INTO order_lines (
              order_id, category, brand, capacity, generation, type, classification, rank, speed,
              interface, form_factor, description, item_type, part_number, serial_number, chip_number, condition, qty,
              unit_cost, sell_price, status, scan_image_id, scan_confidence, position,
              health, rpm
            ) VALUES (
              ${id}, ${cat},
              ${l.brand ?? null}, ${l.capacity ?? null}, ${l.generation ?? null}, ${l.type ?? null},
              ${l.classification ?? null}, ${l.rank ?? null}, ${l.speed ?? null},
              ${l.interface ?? null}, ${l.formFactor ?? null}, ${l.description ?? null}, ${l.itemType?.trim() || null},
              ${resolvePartNumber(cat, l)}, ${l.serialNumber ?? null}, ${canonChipNumber(l.chipNumber)}, ${l.condition ?? 'Pulled — Tested'}, ${l.qty ?? 1},
              ${l.unitCost ?? 0}, ${normSellPrice(l.sellPrice)},
              ${LINE_STATUS_FOR_LIFECYCLE[lifecycleAfter] ?? 'In Transit'},
              ${l.scanImageId ?? null}, ${l.scanConfidence ?? null}, ${pos++},
              ${l.health ?? null}, ${l.rpm ?? null}
            )
            RETURNING id, category, part_number, qty, unit_cost::float AS unit_cost
          ` as { id: string; category: string; part_number: string | null; qty: number; unit_cost: number }[];
          addedRows.push(inserted[0]);
          addedLineIds.push(inserted[0].id);
        }
        await autoTrackParts(tx, body.addLines.map((l, i) => ({
          category: addCats[i],
          partNumber: resolvePartNumber(addCats[i], l),
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

      // A PO that HAD lines may not be left with none. Both clients block it,
      // but the API did not, and an emptied order keeps the NOT NULL category
      // its last line derived — a chip with nothing behind it — while its goods
      // total resets to 0. An always-empty draft is untouched: it has nothing
      // to remove, so this can only fire on a request that removed something.
      if (Array.isArray(body.removeLineIds) && body.removeLineIds.length) {
        const [{ n }] = await tx<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM order_lines WHERE order_id = ${id}
        `;
        if (n === 0) throw new Error('__ORDER_WOULD_BE_EMPTY__');
      }

      // Category and goods total are both denormalizations of the lines,
      // recomputed after every add, remove and edit. Without this the tape
      // itemised categories that summed to one figure under a goods total that
      // still held the pre-edit one. Ahead of the audit block, not after it:
      // total_cost is one of META_FIELDS, so diffing before the derivation ran
      // left every goods-total move off the timeline.
      if (touchesLines) {
        await syncOrderCategory(tx, id);
        await syncOrderGoodsTotal(tx, id, goodsFollowsLines);
      }

      // ── Audit. Each kind is written as its own event row so the timeline
      // reads in the order it happened.
      //
      // Also entered on a lines-only patch: total_cost is a META_FIELD that the
      // derivation above may have just moved, and `diff` reports nothing when
      // it hasn't, so the extra read costs a query and never a false event.
      // Collected alongside the per-kind events below so a revert can carry
      // the whole change set on one row: the review dialog renders from it
      // without stitching sibling events together by timestamp.
      const revertFields: AuditChange[] = [];
      const revertLinesEdited: Array<Record<string, unknown>> = [];

      if (touchesOrder || touchesLines) {
        const orderAfter = (await tx`
          SELECT notes, warehouse_id, payment, total_cost::float AS total_cost,
                 commission_rate::float AS commission_rate,
                 other_fees::float AS other_fees, other_fees_note, paypal_txn_id,
                 supplier_id
          FROM orders WHERE id = ${id} LIMIT 1
        `)[0] as Record<string, unknown>;
        const metaChanges = diff(
          orderBefore as unknown as Record<string, unknown>,
          orderAfter,
          META_FIELDS,
        );
        if (metaChanges.length) {
          await writeOrderEvent(tx, id, u.id, 'meta_changed', { changes: metaChanges });
          revertFields.push(...metaChanges);
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
          SELECT id, status, qty, category, brand, capacity, type, generation, classification,
                 rank, speed, interface, form_factor, description, item_type, part_number,
                 serial_number, chip_number, condition, rpm,
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
            const detail = {
              lineId: patch.id,
              partNumber: after.part_number ?? null,
              changes,
            };
            await writeOrderEvent(tx, id, u.id, 'line_edited', detail);
            revertLinesEdited.push(detail);
          }
        }
      }
      for (const r of addedRows) {
        await writeOrderEvent(tx, id, u.id, 'line_added', {
          lineId: r.id,
          category: r.category,
          partNumber: r.part_number,
          qty: r.qty,
          unitCost: r.unit_cost,
        });
      }
      for (const r of removedSnapshots) {
        await writeOrderEvent(tx, id, u.id, 'line_removed', {
          lineId: r.id,
          category: r.category,
          partNumber: r.part_number,
          qty: r.qty,
          unitCost: r.unit_cost,
        });
      }

      const lineSnapshot = (r: { id: string; category: string; part_number: string | null; qty: number; unit_cost: number }) => ({
        lineId: r.id,
        category: r.category,
        partNumber: r.part_number,
        qty: r.qty,
        unitCost: r.unit_cost,
      });
      if (revertedFrom) {
        await writeOrderEvent(tx, id, u.id, 'reverted', {
          from: revertedFrom,
          to: 'draft',
          fields: revertFields,
          lines: {
            added: addedRows.map(lineSnapshot),
            removed: removedSnapshots.map(lineSnapshot),
            edited: revertLinesEdited,
          },
        });
      }
    });
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? '';
    if (msg.includes('__DONE_LOCKED__')) {
      return c.json({ error: 'Order is Done and cannot be modified. Use the advance-back flow if needed.' }, 409);
    }
    if (msg.includes('__PURCHASER_DONE__')) {
      return c.json({ error: 'Only managers can edit an order after submission' }, 403);
    }
    if (msg.includes('__REVERT_COMMITTED__')) {
      return c.json({
        error: 'Lines in this order are committed to open sell orders. Cancel those sell orders before editing it.',
        offendingLineIds: committedLineIds,
      }, 409);
    }
    if (msg.includes('__REVERT_TRANSFER__')) {
      return c.json({
        error: 'Lines in this order are out on an open transfer order. Receive or discard that transfer before editing it.',
        offendingLineIds: committedLineIds,
      }, 409);
    }
    if (msg.includes('__ORDER_WOULD_BE_EMPTY__')) {
      return c.json({ error: 'An order must keep at least one line. Delete the order instead.' }, 409);
    }
    if (/foreign key|violates|referenced/i.test(msg)) {
      return c.json({ error: 'A line you tried to remove is referenced by a sell-order and cannot be deleted' }, 409);
    }
    throw e;
  }

  // Best-effort R2 cleanup after a successful commit (stub/CF-era keys are
  // no-ops; a missing object delete is idempotent). Batched: this runs with the
  // response still open, and a wide removal used to mean one round trip per key.
  const unswept = await deleteAttachments(c.env, removedScanKeys);
  if (unswept.length) log.error('r2 delete (line removed)', unswept);

  return c.json({ ok: true, addedLineIds, lifecycle: lifecycleAfter });
});

// ── Create an empty Draft order so the submit screen can autosave lines as
// the purchaser builds them (nothing is lost if they leave mid-entry).
orders.post('/draft', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as
    | {
        category?: LineCategory; warehouseId?: string; payment?: 'company' | 'self';
        notes?: string; onBehalfOfUserId?: string;
      }
    | null;

  const owner = await resolveOrderOwner(sql, u, body?.onBehalfOfUserId);
  if ('error' in owner) return c.json({ error: owner.error }, owner.status);

  // No category required: the draft is empty, and the order's category is
  // derived from lines that don't exist yet. The column is NOT NULL, so an
  // uncommitted draft holds 'Mixed' as a placeholder — clients render the chip
  // from `categories`, which is empty, so the placeholder never surfaces.
  if (body?.category) {
    const catErr = await assertCategoriesEnabled(sql, [body.category]);
    if (catErr) return c.json({ error: catErr }, 400);
  }

  const whErr = await warehouseErr(sql, body?.warehouseId ?? null);
  if (whErr) return c.json({ error: whErr }, 400);
  // No warehouse named → the owner's home warehouse (FK-valid by construction).
  const warehouseId = body?.warehouseId ?? owner.ownerDefaultWarehouseId;

  // Allocated inside the transaction so a rollback also rolls back the counter.
  let newId!: string;
  await sql.begin(async (tx) => {
    newId = await insertDraftOrderTx(tx, {
      ownerId: owner.ownerId,
      actorId: u.id,
      category: body?.category,
      warehouseId,
      payment: body?.payment,
      notes: body?.notes,
      onBehalfOfName: owner.ownerName,
    });
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
    | { kind: 'wasSubmitted' }
    | { kind: 'sold' }
    | { kind: 'hasLabels' }
    | { kind: 'ok'; scanned: { k: string }[] };

  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const existing = (await tx`
      SELECT user_id, lifecycle FROM orders WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0] as { user_id: string; lifecycle: string } | undefined;
    if (!existing) return { kind: 'notFound' };
    if (u.role !== 'manager' && existing.user_id !== u.id) return { kind: 'forbidden' };
    if (existing.lifecycle !== 'draft') return { kind: 'notDraft' };
    // A purchaser edit puts a submitted order back in Draft, which would
    // otherwise re-open this door: delete follows the order's history, not its
    // current stage, so once it has left Draft it can only be archived.
    // `reverted` counts on its own — an order can only be reverted from a
    // later stage, and rows seeded past Draft have no `submitted` event.
    if (await wasEverSubmitted(tx, id)) return { kind: 'wasSubmitted' };

    const sold = (await tx`
      SELECT 1 FROM sell_order_lines sol
      JOIN order_lines ol ON ol.id = sol.inventory_id
      WHERE ol.order_id = ${id} LIMIT 1
    `)[0];
    if (sold) return { kind: 'sold' };

    // A bought label is real money on the books; the shipments CASCADE may
    // only ever sweep draft/quoted/voided rows.
    const labeled = (await tx`
      SELECT 1 FROM shipments
      WHERE order_id = ${id} AND status IN ('purchased','in_transit','delivered')
      LIMIT 1
    `)[0];
    if (labeled) return { kind: 'hasLabels' };

    // Both R2 sources for this order: label scans and explicit line photos.
    const scanned = await tx`
      SELECT scan_image_id AS k FROM order_lines
      WHERE order_id = ${id} AND scan_image_id IS NOT NULL
      UNION ALL
      SELECT storage_key AS k FROM order_line_photos WHERE order_id = ${id}
    ` as { k: string }[];

    await tx`DELETE FROM orders WHERE id = ${id}`; // order_lines cascade via FK
    return { kind: 'ok', scanned };
  });

  if (outcome.kind === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome.kind === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
  if (outcome.kind === 'notDraft') return c.json({ error: 'Only Draft orders can be deleted' }, 403);
  if (outcome.kind === 'wasSubmitted') {
    return c.json({ error: 'This order has already been submitted — archive it instead' }, 403);
  }
  if (outcome.kind === 'sold') {
    return c.json({ error: 'A line in this order is referenced by a sell-order and cannot be deleted' }, 409);
  }
  if (outcome.kind === 'hasLabels') {
    return c.json({ error: 'This order has purchased shipping labels — void them first' }, 409);
  }

  // Best-effort: drop the images from R2 too (after the commit). One PO can
  // carry a scan plus six photos per line, so this is batched rather than a
  // round trip each.
  const orphaned = await deleteAttachments(c.env, outcome.scanned.map(r => r.k));
  if (orphaned.length) log.error('r2 delete (order deleted)', orphaned);

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
    // order is part of the business record. A reverted order is a Draft that
    // HAS been submitted, and Delete refuses exactly those, so the history has
    // to decide here too or the order can be neither deleted nor archived.
    // Unarchiving is never blocked: whatever got archived can always go back.
    if (archive && existing.lifecycle === 'draft' && !(await wasEverSubmitted(tx, id))) {
      return { kind: 'isDraft' };
    }
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
  // Submission evidence belongs to the purchaser who raised the PO and stays
  // theirs until it's Done — a receipt or a photo of the goods routinely shows
  // up after the order has already moved to In Transit or Reviewing.
  return status === 'Submission' && order.user_id === u.id && order.lifecycle !== 'done';
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
    if (fromNote !== note) {
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
    .catch(e => { log.error('attachment upload', e); return null; });
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
    await writeOrderEvent(tx, id, u.id, 'status_meta_changed', {
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

  const removed = await sql.begin(async (tx) => {
    const row = (await tx`
      SELECT storage_key, filename FROM order_status_attachments
      WHERE id = ${attachmentId} AND order_id = ${id} AND status = ${status}
      LIMIT 1
    `)[0] as { storage_key: string; filename: string } | undefined;
    if (!row) return null;
    await tx`DELETE FROM order_status_attachments WHERE id = ${attachmentId}`;
    await writeOrderEvent(tx, id, u.id, 'status_meta_changed', {
      status, field: 'attachment_removed',
      attachmentId, filename: row.filename,
    });
    return row;
  });

  if (!removed) return c.json({ error: 'Not found' }, 404);
  // R2 delete outside the tx — slow side effect, kept out of the lock window.
  // Best-effort.
  await deleteAttachment(c.env, removed.storage_key).catch(e => log.error('r2 delete', e));
  return c.json({ ok: true });
});

// ─── Per-line photos ───────────────────────────────────────────────────────
// A picture of the actual goods, attached to one line. Distinct from the
// order-level Submission evidence above (that is the receipt for the whole
// PO) and from the AI label scan (that is a by-product of OCR, and only RAM
// lines ever get one). Any line may carry photos. The cap is shared so the
// picker stops at the same number this route enforces.

// order_lines.id is uuid-typed, so a mangled id would make Postgres throw and
// 500 the route rather than 404 cleanly.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The purchaser who raised the PO photographs the goods, and pictures keep
// arriving after it has moved to In Transit — so ownership lasts until Done,
// mirroring the Submission-evidence rule in canWriteMeta.
function canWritePhotos(u: User, order: { user_id: string; lifecycle: string }): boolean {
  if (effectiveRole(u) === 'manager') return true;
  return order.user_id === u.id && order.lifecycle !== 'done';
}

// Resolves the order + verifies the line belongs to it. A lineId from another
// order must 404, not silently attach across POs.
async function loadPhotoTarget(
  sql: ReturnType<typeof getDb>,
  orderId: string,
  lineId: string,
): Promise<{ user_id: string; lifecycle: string } | null> {
  if (!UUID_RE.test(lineId)) return null;
  const order = (await sql`SELECT user_id, lifecycle FROM orders WHERE id = ${orderId} LIMIT 1`)[0] as
    | { user_id: string; lifecycle: string } | undefined;
  if (!order) return null;
  const line = (await sql`
    SELECT 1 FROM order_lines WHERE id = ${lineId}::uuid AND order_id = ${orderId} LIMIT 1
  `)[0];
  return line ? order : null;
}

orders.post('/:id/lines/:lineId/photos', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const lineId = c.req.param('lineId');
  const sql = getDb(c.env);

  const order = await loadPhotoTarget(sql, id, lineId);
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (!canWritePhotos(u, order)) return c.json({ error: 'Forbidden' }, 403);

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'multipart/form-data required' }, 400);
  const file = form.get('file') as File | null;
  if (!(file instanceof File)) return c.json({ error: 'file is required' }, 400);

  // Images only. The workspace allow-list also permits PDF/XLSX for receipts,
  // but a spreadsheet is not a photo of a DIMM — narrowing here keeps the
  // thumbnail grid renderable, the same way routes/scan.ts does.
  const { maxBytes, allowedMime } = await getUploadLimits(sql);
  if (!file.type || !file.type.startsWith('image/') || !allowedMime.has(file.type)) {
    return c.json({ error: `unsupported file type: ${file.type || 'unknown'}` }, 415);
  }
  const fitted = await shrinkImageToFit(file, maxBytes);
  if (fitted.size > maxBytes) {
    return c.json({ error: `file too large (max ${maxBytes} bytes)` }, 413);
  }

  // No maybeRenameReceipt — that AI rename reads payment receipts, and these
  // are pictures of hardware.
  const uploaded = await uploadAttachment(c.env, fitted, `orders/${id}/lines/${lineId}`)
    .catch(e => { log.error('line photo upload', e); return null; });
  if (!uploaded) return c.json({ error: 'upload failed' }, 502);

  try {
    const row = await sql.begin(async (tx) => {
      // Lock the ORDER first, then the line — the same order PATCH /:id and
      // /advance take. Locking the line first deadlocks against them: the
      // INSERT below needs FOR KEY SHARE on the orders row for its FK, which
      // conflicts with the FOR UPDATE they are already holding while they wait
      // on this line. Postgres kills one with 40P01 and nothing here retries.
      const live = (await tx`
        SELECT user_id, lifecycle FROM orders WHERE id = ${id} LIMIT 1 FOR UPDATE
      `)[0] as { user_id: string; lifecycle: string } | undefined;
      // Re-checked under the lock: the permission read happened before the
      // image shrink and the R2 round trip, seconds a manager can spend
      // advancing the order to Done out from under it.
      if (!live) throw new Error('__ORDER_GONE__');
      if (!canWritePhotos(u, live)) throw new Error('__FORBIDDEN__');

      // Serialise concurrent uploads on the parent line — two racing requests
      // would otherwise both see room under the cap and both insert. The lock
      // goes on order_lines because FOR UPDATE can't be combined with the
      // aggregate below.
      await tx`SELECT 1 FROM order_lines WHERE id = ${lineId}::uuid FOR UPDATE`;
      const existing = (await tx`
        SELECT COALESCE(MAX(position), -1) AS max_pos, COUNT(*)::int AS n
        FROM order_line_photos WHERE order_line_id = ${lineId}::uuid
      `)[0] as { max_pos: number; n: number };
      if (existing.n >= LINE_PHOTO_CAP) throw new Error('__PHOTO_CAP__');
      const r = (await tx`
        INSERT INTO order_line_photos
          (order_line_id, order_id, filename, size_bytes, mime_type, storage_key, delivery_url, position, uploaded_by)
        VALUES
          (${lineId}::uuid, ${id}, ${fitted.name}, ${fitted.size},
           ${fitted.type || 'image/jpeg'},
           ${uploaded.storageKey}, ${uploaded.deliveryUrl}, ${existing.max_pos + 1}, ${u.id})
        RETURNING id, filename, size_bytes, mime_type, delivery_url, uploaded_at
      `)[0];
      await writeOrderEvent(tx, id, u.id, 'line_photo_added', {
        lineId, photoId: r.id, filename: r.filename, size: r.size_bytes, mime: r.mime_type,
      });
      return r;
    });
    return c.json({
      photo: {
        id: row.id, url: row.delivery_url, source: 'upload',
        filename: row.filename, size: row.size_bytes, mime: row.mime_type,
        uploadedAt: row.uploaded_at,
      },
    });
  } catch (e) {
    // The upload precedes the transaction, so ANY rollback — the cap, a
    // serialization failure, a pool timeout — leaves an object in R2 that no
    // row owns. Nothing else can find it later: both cleanup paths (order
    // delete and the removeLineIds sweep) read their keys out of
    // order_line_photos, and the row is exactly what didn't commit.
    await deleteAttachment(c.env, uploaded.storageKey).catch(() => { /* best-effort */ });
    const msg = (e as { message?: string })?.message ?? '';
    if (msg.includes('__PHOTO_CAP__')) {
      return c.json({ error: `at most ${LINE_PHOTO_CAP} photos per line` }, 409);
    }
    if (msg.includes('__ORDER_GONE__')) return c.json({ error: 'Not found' }, 404);
    if (msg.includes('__FORBIDDEN__')) return c.json({ error: 'Forbidden' }, 403);
    throw e;
  }
});

orders.delete('/:id/lines/:lineId/photos/:photoId', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const lineId = c.req.param('lineId');
  const photoId = c.req.param('photoId');
  const sql = getDb(c.env);

  // A scan-sourced photo is addressed as `scan:<key>`, which is not a UUID —
  // it belongs to label_scans and is removed by re-scanning, not from here.
  if (!UUID_RE.test(photoId)) return c.json({ error: 'Not found' }, 404);

  const order = await loadPhotoTarget(sql, id, lineId);
  if (!order) return c.json({ error: 'Not found' }, 404);
  if (!canWritePhotos(u, order)) return c.json({ error: 'Forbidden' }, 403);

  const removed = await sql.begin(async (tx) => {
    // Orders row first, as everywhere else that writes under this order — the
    // photo delete touches a table whose FK makes Postgres take KEY SHARE on
    // it anyway, so taking it in the other order deadlocks against PATCH.
    await tx`SELECT 1 FROM orders WHERE id = ${id} LIMIT 1 FOR UPDATE`;
    const row = (await tx`
      SELECT storage_key, filename FROM order_line_photos
      WHERE id = ${photoId}::uuid AND order_line_id = ${lineId}::uuid AND order_id = ${id}
      LIMIT 1
    `)[0] as { storage_key: string; filename: string } | undefined;
    if (!row) return null;
    await tx`DELETE FROM order_line_photos WHERE id = ${photoId}::uuid`;
    await writeOrderEvent(tx, id, u.id, 'line_photo_removed', {
      lineId, photoId, filename: row.filename,
    });
    return row;
  });

  if (!removed) return c.json({ error: 'Not found' }, 404);
  await deleteAttachment(c.env, removed.storage_key).catch(e => log.error('r2 delete (line photo)', e));
  return c.json({ ok: true });
});

orders.post('/:id/advance', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as { toStage?: string } | null;

  // The lifecycle read, all stage guards and the writes run inside one tx
  // with the orders row locked FOR UPDATE (see services/orderAdvance.ts —
  // shared with the shipping tracking poll). Reading lifecycle outside the tx
  // let a concurrent delete (which also guarded on a stale lifecycle read)
  // delete an order that was being advanced, and vice-versa.
  const outcome = await sql.begin(async (tx) =>
    advanceOrderTx(tx, id, { id: u.id, name: u.name, role: u.role }, body?.toStage));

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
  if (outcome.kind === 'transferClaimed') {
    return c.json({
      error: 'Lines are out on an open transfer order — receive or discard that transfer first.',
      offendingLineIds: outcome.offendingLineIds,
    }, 409);
  }
  return c.json({ ok: true, lifecycle: outcome.nextStageId });
});

export default orders;

