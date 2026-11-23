import { Hono } from 'hono';
import type postgres from 'postgres';
import { getDb, type SqlLike } from '../db';
import { allLimited } from '../lib/concurrency';
import { nextHumanId } from '../lib/id-seq';
import { getLatestRateToUsd } from '../lib/fx';
import { inventoryLabel, inventorySpec } from '../lib/inventoryLabel';
import { linePhotos, type LinePhoto } from '../lib/linePhotos';
import { requireRole } from '../lib/role';
import { committedClaimsByLine, ebayRemainingSql, isSellableLineStatus } from '../lib/sellCommitment';
import {
  clampLimit, cursorTs, cursorTsParam, cursorTsSelect, decodeCursor, encodeCursor, escapeLike, UUID_RE,
} from '../lib/pagination';
import { lotStock } from '../services/ebayListings';
import { createSellOrderDraftTx } from '../services/sellOrderCreate';
import { moveSellOrderStatusTx } from '../services/sellOrderStatus';
import type { Env, User } from '../types';

// The eBay desk. A manager sends part of an inventory lot to eBay as one or
// more listings; the eBay operator posts them, records what sold and ends what
// didn't. A confirmed sale becomes a sell order to the customer "eBay" at
// Awaiting payment, so stock, revenue and commission run through the sell-order
// path as for any other sale. Listing JSON never carries cost, supplier or
// purchaser: the operator's role exists to keep those out of reach.
const ebay = new Hono<{ Bindings: Env; Variables: { user: User } }>()
  .use('*', requireRole('manager', 'ebay'));

type ListingStatus = 'Queued' | 'Listed' | 'Sold' | 'Ended';
const LISTING_STATUSES: readonly ListingStatus[] = ['Queued', 'Listed', 'Sold', 'Ended'];

// Sold and Ended are final for the desk: a listing's sales live on as sell
// orders, and an ended item goes back on eBay as a new listing. The one way
// back is a sale undone by closing its sell order, which puts a Sold listing
// Listed again (releaseEbaySalesTx).
const ALLOWED_TRANSITIONS: Record<ListingStatus, Set<ListingStatus>> = {
  Queued: new Set(['Listed', 'Ended']),
  Listed: new Set(['Sold', 'Ended']),
  Sold:   new Set(),
  Ended:  new Set(),
};

// 'cancelled' is a manager taking back a listing nobody posted yet.
const END_REASONS = new Set(['no_buyer', 'damaged', 'sold_elsewhere', 'other', 'cancelled']);

const MAX_TEXT = 4000;
const MAX_SHORT = 200;
const MAX_QTY = 100_000;
const MAX_AMOUNT = 1_000_000_000;
const MAX_PARTS = 50;
const DAY_MS = 86_400_000;

type EventKind =
  | 'created' | 'edited' | 'listed' | 'sale_detected' | 'sale_confirmed' | 'sale_dismissed' | 'sold' | 'ended';

async function writeEvent(
  tx: SqlLike, listingId: string, actorId: string, kind: EventKind,
  f: { from?: string | null; to?: string | null; note?: string | null; detail?: Record<string, unknown> } = {},
): Promise<void> {
  await tx`
    INSERT INTO ebay_listing_events (listing_id, kind, from_status, to_status, note, detail, actor_id)
    VALUES (${listingId}, ${kind}, ${f.from ?? null}, ${f.to ?? null}, ${f.note ?? null},
            ${tx.json((f.detail ?? {}) as never)}, ${actorId})
  `;
}

async function writeInventoryEvent(
  tx: SqlLike, lineId: string, actorId: string, kind: 'ebay_listed' | 'ebay_ended', detail: Record<string, unknown>,
): Promise<void> {
  await tx`
    INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
    VALUES (${lineId}, ${actorId}, ${kind}, ${tx.json(detail as never)})
  `;
}

// A refusal inside a transaction that has already written: thrown, so the
// transaction rolls back, and turned into a 409 by the handler.
class EbayRefusal extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'EbayRefusal';
  }
}

async function refusing<T>(run: () => Promise<T>): Promise<T | EbayRefusal> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof EbayRefusal) return e;
    throw e;
  }
}

// ── Input parsing ───────────────────────────────────────────────────────────

const textOrNull = (v: unknown, max: number): string | null | undefined => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || v.length > max) return undefined;
  return v.trim() === '' ? null : v.trim();
};

// null = absent; undefined = invalid.
function parseAmount(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return undefined;
  return Math.round(n * 100) / 100;
}

const isQty = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_QTY;

type PartInput = { qty: number; listPrice: number; spec: string | null; title: string | null };

function parseParts(raw: unknown, min: number): PartInput[] | string {
  if (!Array.isArray(raw) || raw.length < min || raw.length > MAX_PARTS) {
    return min > 1 ? `name between ${min} and ${MAX_PARTS} parts` : `name between 1 and ${MAX_PARTS} listings`;
  }
  const out: PartInput[] = [];
  for (const r of raw as unknown[]) {
    const p = (r ?? {}) as Record<string, unknown>;
    if (!isQty(p.qty)) return `each qty must be a whole number from 1 to ${MAX_QTY}`;
    const listPrice = parseAmount(p.listPrice);
    if (listPrice === undefined || listPrice === null) return 'each listing needs a listPrice of 0 or more';
    const spec = textOrNull(p.spec, MAX_SHORT);
    const title = textOrNull(p.title, MAX_SHORT);
    if (spec === undefined || title === undefined) return `spec and title are text of at most ${MAX_SHORT} characters`;
    out.push({ qty: p.qty, listPrice, spec, title });
  }
  return out;
}

// eBay item numbers are all digits; the URL is derived when only the number
// is given, which is what an operator pasting from the eBay app has.
const ITEM_ID_RE = /^\d{6,20}$/;
const itemUrl = (itemId: string) => `https://www.ebay.com/itm/${itemId}`;
const isHttpsUrl = (v: string) => {
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
};

// ── Reading listings ────────────────────────────────────────────────────────

type ListingRow = {
  id: string; status: ListingStatus; qty: number; remaining: number; list_price: number;
  title: string | null; spec: string | null; condition: string | null; notes: string | null;
  ebay_sku: string; ebay_offer_id: string | null; ebay_item_id: string | null; ebay_url: string | null;
  end_reason: string | null; end_note: string | null;
  listed_at: Date | null; ended_at: Date | null; sold_out_at: Date | null; created_at: Date; updated_at: Date;
  detected_sales: number; cursor_ts: string;
  created_by_id: string | null; created_by_name: string | null;
  line_id: string | null; order_id: string | null; product_no: number | null;
  category: string | null; brand: string | null; capacity: string | null; generation: string | null;
  type: string | null; classification: string | null; rank: string | null; speed: string | null;
  interface: string | null; form_factor: string | null; description: string | null;
  line_condition: string | null; health: number | null; rpm: number | null; part_number: string | null;
  scan_image_id: string | null; scan_image_url: string | null;
  warehouse_id: string | null; warehouse_short: string | null;
};

// Product identity only: no cost, supplier, PO owner or money from the PO.
function listingFrom(sql: SqlLike): postgres.PendingQuery<postgres.Row[]> {
  return sql`
    SELECT el.id, el.status, el.qty, ${ebayRemainingSql(sql, sql`el`)} AS remaining,
           el.list_price::float AS list_price, el.title, el.spec, el.condition, el.notes,
           el.ebay_sku, el.ebay_offer_id, el.ebay_item_id, el.ebay_url, el.end_reason, el.end_note,
           el.listed_at, el.ended_at, el.sold_out_at, el.created_at, el.updated_at,
           ${cursorTsSelect(sql, sql`el.created_at`)} AS cursor_ts,
           (SELECT COUNT(*)::int FROM ebay_sales d WHERE d.listing_id = el.id AND d.status = 'Detected')
             AS detected_sales,
           cb.id AS created_by_id, cb.name AS created_by_name,
           l.id AS line_id, l.order_id, l.product_no, l.category, l.brand, l.capacity, l.generation,
           l.type, l.classification, l.rank, l.speed, l.interface, l.form_factor, l.description,
           l.condition AS line_condition, l.health::float AS health, l.rpm, l.part_number,
           l.scan_image_id, ls.delivery_url AS scan_image_url,
           w.id AS warehouse_id, w.short AS warehouse_short
    FROM ebay_listings el
    LEFT JOIN users cb ON cb.id = el.created_by
    LEFT JOIN order_lines l ON l.id = el.inventory_id
    LEFT JOIN orders o ON o.id = l.order_id
    LEFT JOIN warehouses w ON w.id = COALESCE(l.warehouse_id, o.warehouse_id)
    LEFT JOIN LATERAL (
      SELECT delivery_url FROM label_scans WHERE cf_image_id = l.scan_image_id ORDER BY created_at LIMIT 1
    ) ls ON TRUE
  `;
}

type SiblingRow = {
  id: string; inventory_id: string; spec: string | null; status: string; qty: number; remaining: number;
};

// Photos and the lot's other listings, for a page of rows at once.
async function listingExtras(sql: SqlLike, rows: ListingRow[]) {
  const lineIds = [...new Set(rows.map(r => r.line_id).filter((x): x is string => x !== null))];
  if (lineIds.length === 0) return { photos: new Map<string, LinePhoto[]>(), siblings: new Map<string, SiblingRow[]>() };
  const [photoRows, siblingRows] = await Promise.all([
    sql<{
      id: string; order_line_id: string; filename: string; mime_type: string; delivery_url: string; uploaded_at: Date;
    }[]>`
      SELECT id, order_line_id, filename, mime_type, delivery_url, uploaded_at
      FROM order_line_photos WHERE order_line_id = ANY(${lineIds}::uuid[])
      ORDER BY order_line_id, position, uploaded_at
    `,
    sql<SiblingRow[]>`
      SELECT el.id, el.inventory_id, el.spec, el.status, el.qty, ${ebayRemainingSql(sql, sql`el`)} AS remaining
      FROM ebay_listings el WHERE el.inventory_id = ANY(${lineIds}::uuid[])
      ORDER BY el.created_at, el.id
    `,
  ]);
  const photos = new Map<string, LinePhoto[]>();
  for (const p of photoRows) {
    const list = photos.get(p.order_line_id) ?? [];
    list.push({
      id: p.id, url: p.delivery_url, source: 'upload', filename: p.filename, mime: p.mime_type,
      uploadedAt: String(p.uploaded_at),
    });
    photos.set(p.order_line_id, list);
  }
  const siblings = new Map<string, SiblingRow[]>();
  for (const s of siblingRows) siblings.set(s.inventory_id, [...(siblings.get(s.inventory_id) ?? []), s]);
  return { photos, siblings };
}

const daysBetween = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));

function listingJson(
  r: ListingRow, extras: Awaited<ReturnType<typeof listingExtras>>, now: Date,
) {
  const attrs = r.line_id ? {
    category: r.category!, brand: r.brand, capacity: r.capacity, generation: r.generation, type: r.type,
    classification: r.classification, rank: r.rank, speed: r.speed, interface: r.interface,
    form_factor: r.form_factor, description: r.description, condition: r.line_condition,
    health: r.health, rpm: r.rpm,
  } : null;
  const shelfEnd = r.ended_at ?? r.sold_out_at ?? now;
  return {
    id: r.id,
    listingNo: r.id,
    status: r.status,
    qty: r.qty,
    soldQty: r.qty - r.remaining,
    remaining: r.remaining,
    listPrice: r.list_price,
    title: r.title,
    spec: r.spec,
    condition: r.condition,
    notes: r.notes,
    ebay: { sku: r.ebay_sku, offerId: r.ebay_offer_id, itemId: r.ebay_item_id, url: r.ebay_url },
    endReason: r.end_reason,
    endNote: r.end_note,
    detectedSales: r.detected_sales,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    listedAt: r.listed_at,
    endedAt: r.ended_at,
    soldOutAt: r.sold_out_at,
    daysListed: r.listed_at ? daysBetween(r.listed_at, shelfEnd) : null,
    daysWaiting: r.status === 'Queued' ? daysBetween(r.created_at, now) : null,
    createdBy: r.created_by_id ? { id: r.created_by_id, name: r.created_by_name } : null,
    product: attrs ? {
      category: attrs.category,
      label: inventoryLabel(attrs) || null,
      subLabel: inventorySpec(attrs),
      partNumber: r.part_number,
      brand: r.brand,
      capacity: r.capacity,
      condition: r.line_condition,
    } : null,
    warehouse: r.warehouse_id ? { id: r.warehouse_id, short: r.warehouse_short } : null,
    photos: r.line_id ? linePhotos(r, extras.photos.get(r.line_id)) : [],
    lot: r.line_id ? {
      inventoryId: r.line_id,
      orderId: r.order_id,
      productNo: r.product_no,
      otherListings: (extras.siblings.get(r.line_id) ?? []).filter(s => s.id !== r.id).map(s => ({
        id: s.id, listingNo: s.id, spec: s.spec, status: s.status, qty: s.qty, remaining: s.remaining,
      })),
    } : null,
  };
}

// The tab bar's numbers: every listing, not the page loaded. "To confirm"
// counts sales, which is the operator's unit of work there.
async function listingCounts(sql: SqlLike) {
  const [byStatus, [{ detected }]] = await Promise.all([
    sql<{ status: ListingStatus; n: number }[]>`SELECT status, COUNT(*)::int AS n FROM ebay_listings GROUP BY status`,
    sql<{ detected: number }[]>`SELECT COUNT(*)::int AS detected FROM ebay_sales WHERE status = 'Detected'`,
  ]);
  const counts: Record<ListingStatus | 'ToConfirm', number> = { Queued: 0, Listed: 0, ToConfirm: detected, Sold: 0, Ended: 0 };
  for (const r of byStatus) counts[r.status] = r.n;
  return counts;
}

// ?status=Queued|Listed|Sold|Ended|ToConfirm (ToConfirm: listings with a
// detected sale waiting), ?q= searches the EB-#, eBay item #, title, spec and
// part number. Keyset paging on (created_at, id), newest first.
ebay.get('/listings', async (c) => {
  const sql = getDb(c.env);
  const status = c.req.query('status');
  if (status && status !== 'ToConfirm' && !LISTING_STATUSES.includes(status as ListingStatus)) {
    return c.json({ error: `unknown status: ${status}` }, 400);
  }
  const statusFrag = !status ? sql`TRUE`
    : status === 'ToConfirm'
      ? sql`EXISTS (SELECT 1 FROM ebay_sales d WHERE d.listing_id = el.id AND d.status = 'Detected')`
      : sql`el.status = ${status}`;
  const q = (c.req.query('q') ?? '').trim().slice(0, 200);
  const like = `%${escapeLike(q)}%`;
  const qFrag = q
    ? sql`(el.id ILIKE ${like} OR el.ebay_item_id ILIKE ${like} OR el.title ILIKE ${like}
           OR el.spec ILIKE ${like} OR l.part_number ILIKE ${like})`
    : sql`TRUE`;
  const limit = clampLimit(c.req.query('limit'), 50, 200);
  const cursor = decodeCursor(c.req.query('cursor'));
  const afterTs = cursorTs(cursor);
  const cursorFrag = afterTs && cursor
    ? sql`(el.created_at, el.id) < (${cursorTsParam(sql, afterTs)}, ${cursor.id})`
    : sql`TRUE`;

  const [rows, counts] = await Promise.all([
    sql<ListingRow[]>`
      ${listingFrom(sql)}
      WHERE ${statusFrag} AND ${qFrag} AND ${cursorFrag}
      ORDER BY el.created_at DESC, el.id DESC
      LIMIT ${limit + 1}
    `,
    listingCounts(sql),
  ]);
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const extras = await listingExtras(sql, slice);
  const now = new Date();
  const last = slice[slice.length - 1];
  return c.json({
    rows: slice.map(r => listingJson(r, extras, now)),
    counts,
    nextCursor: hasMore && last ? encodeCursor({ ts: last.cursor_ts, id: last.id }) : null,
  });
});

type SaleRow = {
  id: string; listing_id: string; qty: number; unit_price: number; fees: number | null;
  ebay_order_id: string | null; ebay_line_item_id: string | null; buyer: string | null; sold_at: Date;
  status: string; sell_order_id: string | null; confirmed_at: Date | null;
  confirmed_by_id: string | null; confirmed_by_name: string | null; created_at: Date;
};

function saleFrom(sql: SqlLike) {
  return sql`
    SELECT s.id, s.listing_id, s.qty, s.unit_price::float AS unit_price, s.fees::float AS fees,
           s.ebay_order_id, s.ebay_line_item_id, s.buyer, s.sold_at,
           s.status, s.sell_order_id, s.confirmed_at, s.created_at,
           u.id AS confirmed_by_id, u.name AS confirmed_by_name
    FROM ebay_sales s LEFT JOIN users u ON u.id = s.confirmed_by
  `;
}

const saleJson = (s: SaleRow) => ({
  id: s.id, listingId: s.listing_id, qty: s.qty, unitPrice: s.unit_price, fees: s.fees,
  ebayOrderId: s.ebay_order_id, ebayLineItemId: s.ebay_line_item_id, buyer: s.buyer, soldAt: s.sold_at,
  status: s.status, sellOrderId: s.sell_order_id, confirmedAt: s.confirmed_at,
  confirmedBy: s.confirmed_by_id ? { id: s.confirmed_by_id, name: s.confirmed_by_name } : null,
  createdAt: s.created_at,
});

ebay.get('/listings/:id', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const row = (await sql<ListingRow[]>`${listingFrom(sql)} WHERE el.id = ${id} LIMIT 1`)[0];
  if (!row) return c.json({ error: 'Not found' }, 404);
  const extras = await listingExtras(sql, [row]);
  const [stock, sales, events] = await allLimited([
    () => (row.line_id ? lotStock(sql, row.line_id) : Promise.resolve(null)),
    () => sql<SaleRow[]>`${saleFrom(sql)} WHERE s.listing_id = ${id} ORDER BY s.sold_at DESC, s.id`,
    () => sql<{
      id: string; kind: EventKind; from_status: string | null; to_status: string | null; note: string | null;
      detail: Record<string, unknown>; created_at: Date; actor_id: string | null; actor_name: string | null;
    }[]>`
      SELECT e.id, e.kind, e.from_status, e.to_status, e.note, e.detail, e.created_at,
             u.id AS actor_id, u.name AS actor_name
      FROM ebay_listing_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.listing_id = ${id} ORDER BY e.created_at, e.id
    `,
  ]);
  const json = listingJson(row, extras, new Date());
  return c.json({
    listing: {
      ...json,
      // The lot's units as the reservation counts them, so the desk can flag a
      // lot whose numbers don't add up.
      lot: json.lot && { ...json.lot, stock },
      sales: sales.map(saleJson),
      events: events.map(e => ({
        id: e.id, kind: e.kind, from: e.from_status, to: e.to_status, note: e.note, detail: e.detail,
        at: e.created_at, actor: e.actor_id ? { id: e.actor_id, name: e.actor_name } : null,
      })),
      allowedTo: [...ALLOWED_TRANSITIONS[row.status]],
    },
  });
});

// The "Sales to confirm" queue: each detected sale beside the listing it would
// draw from. ?status= picks another queue (Confirmed, Dismissed).
ebay.get('/sales', async (c) => {
  const sql = getDb(c.env);
  const status = c.req.query('status') ?? 'Detected';
  if (!['Detected', 'Confirmed', 'Dismissed'].includes(status)) return c.json({ error: `unknown status: ${status}` }, 400);
  const limit = clampLimit(c.req.query('limit'), 50, 200);
  const sales = await sql<(SaleRow & { listing_status: string; listing_title: string | null; listing_spec: string | null; listing_remaining: number })[]>`
    SELECT x.*, el.status AS listing_status, el.title AS listing_title, el.spec AS listing_spec,
           ${ebayRemainingSql(sql, sql`el`)} AS listing_remaining
    FROM (${saleFrom(sql)} WHERE s.status = ${status}) x
    JOIN ebay_listings el ON el.id = x.listing_id
    ORDER BY x.sold_at DESC, x.id
    LIMIT ${limit}
  `;
  return c.json({
    sales: sales.map(s => ({
      ...saleJson(s),
      listing: {
        id: s.listing_id, status: s.listing_status, title: s.listing_title, spec: s.listing_spec,
        remaining: s.listing_remaining,
      },
    })),
  });
});

// ── Creating listings ───────────────────────────────────────────────────────

// Several listings from one lot at once: a lot of mixed specs is sold as one
// eBay item per spec. Together with the lot's active listings and its
// committed sell orders they must fit what the lot holds.
ebay.post('/listings', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as
    | { inventoryId?: unknown; note?: unknown; condition?: unknown; listings?: unknown }
    | null;
  if (!body) return c.json({ error: 'invalid JSON body' }, 400);
  const inventoryId = typeof body.inventoryId === 'string' && UUID_RE.test(body.inventoryId)
    ? body.inventoryId.toLowerCase() : null;
  if (!inventoryId) return c.json({ error: 'inventoryId must be a uuid' }, 400);
  const note = textOrNull(body.note, MAX_TEXT);
  const condition = textOrNull(body.condition, MAX_SHORT);
  if (note === undefined || condition === undefined) return c.json({ error: 'note and condition must be text' }, 400);
  const parts = parseParts(body.listings, 1);
  if (typeof parts === 'string') return c.json({ error: parts }, 400);
  const wanted = parts.reduce((n, p) => n + p.qty, 0);

  const sql = getDb(c.env);
  const outcome = await refusing(() => sql.begin(async (tx) => {
    // The row lock is the one validateSellLines takes, so a sell order being
    // promoted and a listing being created can't both count the same units.
    const line = (await tx<{
      id: string; order_id: string; product_no: number; qty: number; status: string; archived_at: Date | null;
    }[]>`
      SELECT l.id, l.order_id, l.product_no, l.qty, l.status, o.archived_at
      FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.id = ${inventoryId} FOR UPDATE OF l
    `)[0];
    if (!line) throw new EbayRefusal(404, 'inventory lot not found');
    const ref = `${line.order_id} #${line.product_no}`;
    if (!isSellableLineStatus(line.status)) throw new EbayRefusal(400, `${ref} is not sellable (status=${line.status})`);
    if (line.archived_at !== null) throw new EbayRefusal(400, `${ref} is on an archived order`);
    const held = (await committedClaimsByLine(tx, [inventoryId])).get(inventoryId)?.qty ?? 0;
    const free = line.qty - held;
    if (wanted > free) {
      throw new EbayRefusal(400, `${wanted} units asked for but only ${free} of ${ref} are free`
        + (held > 0 ? ` — ${held} are already on sell orders or eBay listings` : ''));
    }
    const ids: string[] = [];
    for (const p of parts) {
      const id = await nextHumanId(tx, 'EB', 'EB');
      await tx`
        INSERT INTO ebay_listings (id, inventory_id, qty, list_price, title, spec, condition, notes, created_by)
        VALUES (${id}, ${inventoryId}, ${p.qty}, ${p.listPrice}, ${p.title}, ${p.spec}, ${condition}, ${note}, ${u.id})
      `;
      await writeEvent(tx, id, u.id, 'created', {
        to: 'Queued', note, detail: { inventoryId, qty: p.qty, listPrice: p.listPrice, spec: p.spec },
      });
      await writeInventoryEvent(tx, inventoryId, u.id, 'ebay_listed', { listing: id, qty: p.qty });
      ids.push(id);
    }
    return ids;
  }));
  if (outcome instanceof EbayRefusal) return c.json({ error: outcome.message }, outcome.status);
  return c.json({ ids: outcome }, 201);
});

// Break a Queued listing into the eBay items it really is. The listing keeps
// the first part; the rest become new listings from the same lot. Their qty
// adds up to the original's, so the lot's reservation doesn't move.
ebay.post('/listings/:id/split', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { parts?: unknown } | null;
  const parts = parseParts(body?.parts, 2);
  if (typeof parts === 'string') return c.json({ error: parts }, 400);

  const sql = getDb(c.env);
  const outcome = await refusing(() => sql.begin(async (tx) => {
    const cur = (await tx<{
      status: ListingStatus; qty: number; inventory_id: string | null; list_price: number;
      title: string | null; spec: string | null; condition: string | null; notes: string | null;
      created_by: string | null;
    }[]>`
      SELECT status, qty, inventory_id, list_price::float AS list_price, title, spec, condition, notes, created_by
      FROM ebay_listings WHERE id = ${id} FOR UPDATE
    `)[0];
    if (!cur) throw new EbayRefusal(404, 'Not found');
    if (cur.status !== 'Queued') throw new EbayRefusal(409, `only a listing still to post can be split — this one is ${cur.status}`);
    const total = parts.reduce((n, p) => n + p.qty, 0);
    if (total !== cur.qty) throw new EbayRefusal(400, `the parts add up to ${total}, the listing holds ${cur.qty}`);
    const [first, ...rest] = parts;
    const ids: string[] = [];
    for (const p of rest) {
      const newId = await nextHumanId(tx, 'EB', 'EB');
      await tx`
        INSERT INTO ebay_listings (id, inventory_id, qty, list_price, title, spec, condition, notes, created_by)
        VALUES (${newId}, ${cur.inventory_id}, ${p.qty}, ${p.listPrice}, ${p.title ?? cur.title}, ${p.spec},
                ${cur.condition}, ${cur.notes}, ${cur.created_by})
      `;
      await writeEvent(tx, newId, u.id, 'created', {
        to: 'Queued', detail: { splitFrom: id, qty: p.qty, listPrice: p.listPrice, spec: p.spec },
      });
      ids.push(newId);
    }
    await tx`
      UPDATE ebay_listings
         SET qty = ${first.qty}, list_price = ${first.listPrice}, spec = ${first.spec},
             title = ${first.title ?? cur.title}, updated_at = NOW()
       WHERE id = ${id}
    `;
    await writeEvent(tx, id, u.id, 'edited', {
      detail: {
        split: ids,
        changes: { qty: { from: cur.qty, to: first.qty }, listPrice: { from: cur.list_price, to: first.listPrice },
                   spec: { from: cur.spec, to: first.spec } },
      },
    });
    return ids;
  }));
  if (outcome instanceof EbayRefusal) return c.json({ error: outcome.message }, outcome.status);
  return c.json({ id, newIds: outcome }, 201);
});

// ── Editing, linking, ending ────────────────────────────────────────────────

// Title, spec, condition, notes and price, and the eBay item # once it is
// posted: linking a Queued listing to its item puts it Listed.
ebay.patch('/listings/:id', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'invalid JSON body' }, 400);

  const patch: {
    title?: string | null; spec?: string | null; condition?: string | null; notes?: string | null;
    list_price?: number; ebay_item_id?: string; ebay_url?: string;
  } = {};
  for (const [key, col, max] of [
    ['title', 'title', MAX_SHORT], ['spec', 'spec', MAX_SHORT], ['condition', 'condition', MAX_SHORT],
    ['notes', 'notes', MAX_TEXT],
  ] as const) {
    if (body[key] === undefined) continue;
    const v = textOrNull(body[key], max);
    if (v === undefined) return c.json({ error: `${key} must be text of at most ${max} characters` }, 400);
    patch[col] = v;
  }
  if (body.listPrice !== undefined) {
    const p = parseAmount(body.listPrice);
    if (p === undefined || p === null) return c.json({ error: 'listPrice must be a number, 0 or more' }, 400);
    patch.list_price = p;
  }
  if (body.ebayItemId !== undefined) {
    if (typeof body.ebayItemId !== 'string' || !ITEM_ID_RE.test(body.ebayItemId.trim())) {
      return c.json({ error: 'ebayItemId must be the eBay item number (digits)' }, 400);
    }
    patch.ebay_item_id = body.ebayItemId.trim();
  }
  if (body.ebayUrl !== undefined) {
    if (typeof body.ebayUrl !== 'string' || body.ebayUrl.length > 2000 || !isHttpsUrl(body.ebayUrl.trim())) {
      return c.json({ error: 'ebayUrl must be an https URL' }, 400);
    }
    patch.ebay_url = body.ebayUrl.trim();
  }
  if (patch.ebay_item_id && patch.ebay_url === undefined) patch.ebay_url = itemUrl(patch.ebay_item_id);
  if (Object.keys(patch).length === 0) return c.json({ error: 'nothing to change' }, 400);

  const sql = getDb(c.env);
  const outcome = await refusing(() => sql.begin(async (tx) => {
    const cur = (await tx<(Record<string, unknown> & { status: ListingStatus })[]>`
      SELECT status, title, spec, condition, notes, list_price::float AS list_price, ebay_item_id, ebay_url
      FROM ebay_listings WHERE id = ${id} FOR UPDATE
    `)[0];
    if (!cur) throw new EbayRefusal(404, 'Not found');
    if (!ALLOWED_TRANSITIONS[cur.status].size) throw new EbayRefusal(409, `a ${cur.status} listing is read-only`);
    if (patch.ebay_item_id) {
      const [taken] = await tx<{ id: string }[]>`
        SELECT id FROM ebay_listings WHERE ebay_item_id = ${patch.ebay_item_id} AND id <> ${id} LIMIT 1
      `;
      if (taken) throw new EbayRefusal(409, `eBay item ${patch.ebay_item_id} is already linked to ${taken.id}`);
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
      if (patch[k] !== cur[k]) changes[k] = { from: cur[k], to: patch[k] };
    }
    if (Object.keys(changes).length === 0) return cur.status;
    const listing = cur.status === 'Queued' && patch.ebay_item_id !== undefined;
    await tx`
      UPDATE ebay_listings SET ${tx(patch)}, updated_at = NOW(),
             status = ${listing ? 'Listed' : cur.status},
             listed_at = CASE WHEN ${listing} THEN NOW() ELSE listed_at END
       WHERE id = ${id}
    `;
    await writeEvent(tx, id, u.id, 'edited', { detail: { changes } });
    if (listing) {
      await writeEvent(tx, id, u.id, 'listed', {
        from: 'Queued', to: 'Listed', detail: { itemId: patch.ebay_item_id, url: patch.ebay_url },
      });
      return 'Listed' as const;
    }
    return cur.status;
  }));
  if (outcome instanceof EbayRefusal) return c.json({ error: outcome.message }, outcome.status);
  return c.json({ ok: true, status: outcome });
});

// Not sold: the listing ends and whatever it still offered goes back to stock.
ebay.post('/listings/:id/end', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { reason?: unknown; note?: unknown } | null;
  const reason = typeof body?.reason === 'string' ? body.reason : '';
  if (!END_REASONS.has(reason)) return c.json({ error: `reason must be one of: ${[...END_REASONS].join(', ')}` }, 400);
  if (reason === 'cancelled' && u.role !== 'manager') return c.json({ error: 'only a manager can cancel a listing' }, 403);
  const note = textOrNull(body?.note, MAX_TEXT);
  if (note === undefined) return c.json({ error: 'note must be text' }, 400);

  const sql = getDb(c.env);
  const outcome = await refusing(() => sql.begin(async (tx) => {
    const cur = (await tx<{ status: ListingStatus; inventory_id: string | null; remaining: number; detected: number }[]>`
      SELECT el.status, el.inventory_id, ${ebayRemainingSql(tx, tx`el`)} AS remaining,
             (SELECT COUNT(*)::int FROM ebay_sales d WHERE d.listing_id = el.id AND d.status = 'Detected') AS detected
      FROM ebay_listings el WHERE el.id = ${id} FOR UPDATE
    `)[0];
    if (!cur) throw new EbayRefusal(404, 'Not found');
    if (!ALLOWED_TRANSITIONS[cur.status].has('Ended')) throw new EbayRefusal(409, `a ${cur.status} listing can't be ended`);
    if (reason === 'cancelled' && cur.status !== 'Queued') {
      throw new EbayRefusal(409, 'only a listing still to post can be cancelled — end it on eBay instead');
    }
    if (cur.detected > 0) throw new EbayRefusal(409, 'confirm or dismiss the sales waiting on this listing first');
    await tx`
      UPDATE ebay_listings SET status = 'Ended', end_reason = ${reason}, end_note = ${note},
             ended_at = NOW(), updated_at = NOW()
       WHERE id = ${id}
    `;
    await writeEvent(tx, id, u.id, 'ended', {
      from: cur.status, to: 'Ended', note, detail: { reason, returnedQty: cur.remaining },
    });
    if (cur.inventory_id) {
      await writeInventoryEvent(tx, cur.inventory_id, u.id, 'ebay_ended', {
        listing: id, reason, returnedQty: cur.remaining,
      });
    }
    return cur.remaining;
  }));
  if (outcome instanceof EbayRefusal) return c.json({ error: outcome.message }, outcome.status);
  return c.json({ ok: true, status: 'Ended', returnedQty: outcome });
});

// ── Sales ───────────────────────────────────────────────────────────────────

type SaleInput = {
  qty: number; unitPrice: number; fees: number | null;
  ebayOrderId: string | null; buyer: string | null; soldAt: Date | null;
};

const money = (n: number) => `$${n.toFixed(2)}`;

// What the manager sees on the sell order: where it came from and what eBay
// kept, since the order itself carries only the sale price.
function sellOrderNote(listingId: string, s: SaleInput): string {
  return [
    `eBay sale from ${listingId}`,
    s.ebayOrderId && `eBay order ${s.ebayOrderId}`,
    s.fees !== null && `fees ${money(s.fees)}`,
    s.buyer && `buyer ${s.buyer}`,
  ].filter(Boolean).join(' · ');
}

// One sale becomes one sell order to customer eBay, at Awaiting payment. Runs
// in the caller's transaction, under the listing's lock: the sale is recorded
// as Confirmed first, which moves its units off the listing's reservation,
// and the order then claims them through the same create and status code as
// any sell order (validateSellLines, ALLOWED_TRANSITIONS). Any refusal throws,
// so nothing of a half-made order survives.
async function confirmSaleTx(
  tx: postgres.TransactionSql, listingId: string, actorId: string,
  sale: { existingId: string } | { input: SaleInput },
): Promise<{ saleId: string; sellOrderId: string; listingStatus: ListingStatus; remaining: number }> {
  const listing = (await tx<{
    status: ListingStatus; inventory_id: string | null; spec: string | null; remaining: number;
  }[]>`
    SELECT el.status, el.inventory_id, el.spec, ${ebayRemainingSql(tx, tx`el`)} AS remaining
    FROM ebay_listings el WHERE el.id = ${listingId} FOR UPDATE
  `)[0];
  if (!listing) throw new EbayRefusal(404, 'Not found');
  if (listing.status !== 'Listed') {
    throw new EbayRefusal(409, `a ${listing.status} listing takes no sales — it has to be on eBay`);
  }
  if (!listing.inventory_id) throw new EbayRefusal(409, 'the inventory lot behind this listing is gone');

  let saleId: string;
  let input: SaleInput;
  if ('existingId' in sale) {
    const row = (await tx<{
      status: string; qty: number; unit_price: number; fees: number | null;
      ebay_order_id: string | null; buyer: string | null; sold_at: Date;
    }[]>`
      SELECT status, qty, unit_price::float AS unit_price, fees::float AS fees,
             ebay_order_id, buyer, sold_at
      FROM ebay_sales WHERE id = ${sale.existingId} AND listing_id = ${listingId} FOR UPDATE
    `)[0];
    if (!row) throw new EbayRefusal(404, 'Not found');
    if (row.status !== 'Detected') throw new EbayRefusal(409, `this sale is already ${row.status}`);
    saleId = sale.existingId;
    input = {
      qty: row.qty, unitPrice: row.unit_price, fees: row.fees,
      ebayOrderId: row.ebay_order_id, buyer: row.buyer, soldAt: row.sold_at,
    };
  } else {
    input = sale.input;
    saleId = '';
  }
  if (input.qty > listing.remaining) {
    throw new EbayRefusal(409, `${input.qty} sold but the listing has only ${listing.remaining} left`);
  }

  if (saleId) {
    await tx`
      UPDATE ebay_sales SET status = 'Confirmed', confirmed_by = ${actorId}, confirmed_at = NOW()
       WHERE id = ${saleId}
    `;
  } else {
    [{ id: saleId }] = await tx<{ id: string }[]>`
      INSERT INTO ebay_sales (listing_id, qty, unit_price, fees, ebay_order_id, buyer, sold_at,
                              status, confirmed_by, confirmed_at)
      VALUES (${listingId}, ${input.qty}, ${input.unitPrice}, ${input.fees},
              ${input.ebayOrderId}, ${input.buyer}, ${input.soldAt ?? tx`NOW()`}, 'Confirmed', ${actorId}, NOW())
      RETURNING id
    `;
  }

  const [customer] = await tx<{ id: string }[]>`
    SELECT id FROM customers WHERE lower(name) = 'ebay' ORDER BY created_at, id LIMIT 1
  `;
  if (!customer) throw new EbayRefusal(409, 'there is no customer named eBay to sell to — a manager has to add it');
  const [lot] = await tx<{
    category: string; brand: string | null; capacity: string | null; generation: string | null;
    type: string | null; classification: string | null; rank: string | null; speed: string | null;
    interface: string | null; form_factor: string | null; description: string | null; condition: string | null;
    health: number | null; rpm: number | null; part_number: string | null; warehouse_id: string | null;
  }[]>`
    SELECT l.category, l.brand, l.capacity, l.generation, l.type, l.classification, l.rank, l.speed,
           l.interface, l.form_factor, l.description, l.condition, l.health::float AS health, l.rpm,
           l.part_number, COALESCE(l.warehouse_id, o.warehouse_id) AS warehouse_id
    FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.id = ${listing.inventory_id}
  `;
  const created = await createSellOrderDraftTx(tx, {
    customerId: customer.id,
    currency: 'USD',
    notes: sellOrderNote(listingId, input),
    lines: [{
      inventoryId: listing.inventory_id,
      category: lot.category,
      label: inventoryLabel(lot) || lot.category,
      // A mixed lot's listing says which of its specs this was.
      subLabel: listing.spec ?? inventorySpec(lot),
      partNumber: lot.part_number,
      qty: input.qty,
      unitPrice: input.unitPrice,
      warehouseId: lot.warehouse_id,
      condition: lot.condition,
    }],
    actorUserId: actorId,
    source: 'ebay',
  }, await getLatestRateToUsd(tx, 'USD'));
  if (!created.ok) throw new EbayRefusal(409, created.error);
  const moved = await moveSellOrderStatusTx(tx, created.id, actorId, { to: 'Awaiting payment', from: 'Draft' });
  if (moved.kind !== 'done') {
    throw new EbayRefusal(409, moved.kind === 'conflict' ? moved.msg : `the sell order could not be raised (${moved.kind})`);
  }
  await tx`UPDATE ebay_sales SET sell_order_id = ${created.id} WHERE id = ${saleId}`;

  const remaining = listing.remaining - input.qty;
  await writeEvent(tx, listingId, actorId, 'sale_confirmed', {
    detail: { saleId, qty: input.qty, unitPrice: input.unitPrice, sellOrderId: created.id, remaining },
  });
  let listingStatus: ListingStatus = 'Listed';
  if (remaining === 0) {
    listingStatus = 'Sold';
    await tx`UPDATE ebay_listings SET status = 'Sold', sold_out_at = NOW(), updated_at = NOW() WHERE id = ${listingId}`;
    await writeEvent(tx, listingId, actorId, 'sold', { from: 'Listed', to: 'Sold' });
  } else {
    await tx`UPDATE ebay_listings SET updated_at = NOW() WHERE id = ${listingId}`;
  }
  return { saleId, sellOrderId: created.id, listingStatus, remaining };
}

// "Mark sold": a sale the operator saw on eBay, confirmed as it is recorded.
ebay.post('/listings/:id/sales', async (c) => {
  const u = c.var.user;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'invalid JSON body' }, 400);
  if (!isQty(body.qty)) return c.json({ error: `qty must be a whole number from 1 to ${MAX_QTY}` }, 400);
  const unitPrice = parseAmount(body.unitPrice);
  if (unitPrice === undefined || unitPrice === null) return c.json({ error: 'unitPrice must be a number, 0 or more' }, 400);
  const fees = parseAmount(body.fees);
  if (fees === undefined) return c.json({ error: 'fees must be a number, 0 or more' }, 400);
  const ebayOrderId = textOrNull(body.ebayOrderId, MAX_SHORT);
  const buyer = textOrNull(body.buyer, MAX_SHORT);
  if (ebayOrderId === undefined || buyer === undefined) return c.json({ error: 'ebayOrderId and buyer must be text' }, 400);
  let soldAt: Date | null = null;
  if (body.soldAt != null) {
    soldAt = typeof body.soldAt === 'string' ? new Date(body.soldAt) : new Date(NaN);
    if (Number.isNaN(soldAt.getTime())) return c.json({ error: 'soldAt must be an ISO timestamp' }, 400);
  }

  const sql = getDb(c.env);
  const outcome = await refusing(() => sql.begin((tx) => confirmSaleTx(tx, id, u.id, {
    input: { qty: body.qty as number, unitPrice, fees, ebayOrderId, buyer, soldAt },
  })));
  if (outcome instanceof EbayRefusal) return c.json({ error: outcome.message }, outcome.status);
  return c.json({ ok: true, ...outcome }, 201);
});

async function saleListingId(sql: SqlLike, saleId: string): Promise<string | null> {
  if (!UUID_RE.test(saleId)) return null;
  const [row] = await sql<{ listing_id: string }[]>`SELECT listing_id FROM ebay_sales WHERE id = ${saleId}`;
  return row?.listing_id ?? null;
}

ebay.post('/sales/:id/confirm', async (c) => {
  const u = c.var.user;
  const saleId = c.req.param('id');
  const sql = getDb(c.env);
  const listingId = await saleListingId(sql, saleId);
  if (!listingId) return c.json({ error: 'Not found' }, 404);
  const outcome = await refusing(() => sql.begin((tx) => confirmSaleTx(tx, listingId, u.id, { existingId: saleId })));
  if (outcome instanceof EbayRefusal) return c.json({ error: outcome.message }, outcome.status);
  return c.json({ ok: true, ...outcome });
});

// "Not this listing": the detected sale is set aside and reserves nothing.
ebay.post('/sales/:id/dismiss', async (c) => {
  const u = c.var.user;
  const saleId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { note?: unknown } | null;
  const note = textOrNull(body?.note, MAX_TEXT);
  if (note === undefined) return c.json({ error: 'note must be text' }, 400);
  const sql = getDb(c.env);
  const listingId = await saleListingId(sql, saleId);
  if (!listingId) return c.json({ error: 'Not found' }, 404);
  const outcome = await refusing(() => sql.begin(async (tx) => {
    // Listing before sale, the order confirmSaleTx locks them in.
    await tx`SELECT 1 FROM ebay_listings WHERE id = ${listingId} FOR UPDATE`;
    const [row] = await tx<{ status: string; qty: number }[]>`
      SELECT status, qty FROM ebay_sales WHERE id = ${saleId} FOR UPDATE
    `;
    if (row.status !== 'Detected') throw new EbayRefusal(409, `this sale is already ${row.status}`);
    await tx`UPDATE ebay_sales SET status = 'Dismissed' WHERE id = ${saleId}`;
    await writeEvent(tx, listingId, u.id, 'sale_dismissed', { note, detail: { saleId, qty: row.qty } });
  }));
  if (outcome instanceof EbayRefusal) return c.json({ error: outcome.message }, outcome.status);
  return c.json({ ok: true });
});

export default ebay;
