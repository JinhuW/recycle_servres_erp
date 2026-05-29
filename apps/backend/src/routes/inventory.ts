import { Hono } from 'hono';
import { getDb } from '../db';
import { notify } from '../lib/notify';
import { getWorkspaceSetting } from '../lib/settings';
import { nextHumanId } from '../lib/id-seq';
import { canonPartCol, canonPartArg } from '../lib/part-number';
import { buildXlsxBuffer, xlsxResponse, datedFilename, type XlsxColumn } from '../lib/xlsx';
import type { Env, User } from '../types';

const inventory = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// Category-specific attribute filter parsing. Comma-separated multi-select per
// facet — within a facet values OR, across facets they AND. `rpm` is a smallint
// column so values get coerced to int; `speed` is stored as text (OCR-derived,
// e.g. "2400") so values stay as strings. Non-numeric tokens for either are
// dropped silently so a stale chip from a deleted catalog row can't poison the
// query.
type AttrFilters = {
  brand: string[]; capacity: string[]; generation: string[]; type: string[];
  classification: string[]; rank: string[]; speed: string[];
  interface: string[]; form_factor: string[]; rpm: number[];
};
function parseAttrFilters(q: (k: string) => string | undefined): AttrFilters {
  const list = (k: string) => (q(k) ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const ints = (k: string) => list(k).map(Number).filter(n => Number.isFinite(n));
  const numericStrings = (k: string) => list(k).filter(s => Number.isFinite(Number(s)));
  return {
    brand: list('brand'), capacity: list('capacity'), generation: list('generation'),
    type: list('type'), classification: list('classification'), rank: list('rank'),
    speed: numericStrings('speed'), interface: list('interface'), form_factor: list('form'),
    rpm: ints('rpm'),
  };
}
function attrFragments(sql: ReturnType<typeof getDb>, a: AttrFilters) {
  return sql`
    ${a.brand.length          ? sql`l.brand = ANY(${a.brand}::text[])`                   : sql`TRUE`} AND
    ${a.capacity.length       ? sql`l.capacity = ANY(${a.capacity}::text[])`             : sql`TRUE`} AND
    ${a.generation.length     ? sql`l.generation = ANY(${a.generation}::text[])`         : sql`TRUE`} AND
    ${a.type.length           ? sql`l.type = ANY(${a.type}::text[])`                     : sql`TRUE`} AND
    ${a.classification.length ? sql`l.classification = ANY(${a.classification}::text[])` : sql`TRUE`} AND
    ${a.rank.length           ? sql`l.rank = ANY(${a.rank}::text[])`                     : sql`TRUE`} AND
    ${a.speed.length          ? sql`l.speed = ANY(${a.speed}::text[])`                   : sql`TRUE`} AND
    ${a.interface.length      ? sql`l.interface = ANY(${a.interface}::text[])`           : sql`TRUE`} AND
    ${a.form_factor.length    ? sql`l.form_factor = ANY(${a.form_factor}::text[])`       : sql`TRUE`} AND
    ${a.rpm.length            ? sql`l.rpm = ANY(${a.rpm}::int[])`                        : sql`TRUE`}
  `;
}

// Combined WHERE fragment for the inventory list — shared by the JSON list and
// the xlsx export so the two always filter identically. Purchasers are scoped
// to their own lines; managers see the whole workspace.
function inventoryWhereFrag(
  c: { req: { query: (k: string) => string | undefined } },
  sql: ReturnType<typeof getDb>,
  u: User,
) {
  const isManager = u.role === 'manager';
  const category = c.req.query('category');
  const status = c.req.query('status');
  const search = c.req.query('q')?.toLowerCase().trim();
  const warehouse = c.req.query('warehouse');
  const attrs = parseAttrFilters((k) => c.req.query(k));

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
  const attrFrag     = attrFragments(sql, attrs);

  return sql`${scopeFrag} AND ${categoryFrag} AND ${statusFrag} AND ${whFrag} AND ${searchFrag} AND ${attrFrag}`;
}

// List inventory with the same filters as the desktop screen.
inventory.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const isManager = u.role === 'manager';
  const whereFrag = inventoryWhereFrag(c, sql, u);

  const rows = await sql`
    SELECT l.id, l.category, l.brand, l.capacity, l.generation, l.type, l.classification, l.rank, l.speed,
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
    WHERE ${whereFrag}
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

// Excel export of the inventory list. Manager-only — the workbook carries
// cost/profit/margin, which purchasers may never see. Reuses the exact list
// filters but drops the 200-row UI cap so the file is the full filtered set.
// Registered before '/:id' so the literal path wins over the param route.
const INV_EXPORT_COLS: XlsxColumn[] = [
  { header: 'ID',           key: 'id',        width: 12 },
  { header: 'Date',         key: 'date',      width: 12 },
  { header: 'Category',     key: 'category',  width: 10 },
  { header: 'Item',         key: 'item',      width: 30 },
  { header: 'Spec',         key: 'spec',      width: 26 },
  { header: 'Rank',         key: 'rank',      width: 10 },
  { header: 'Speed',        key: 'speed',     width: 10 },
  { header: 'Part #',       key: 'part',      width: 22 },
  { header: 'Warehouse',    key: 'warehouse', width: 12 },
  { header: 'Condition',    key: 'condition', width: 12 },
  { header: 'Qty',          key: 'qty',       width: 8,  numFmt: '#,##0' },
  { header: 'Unit cost',    key: 'unitCost',  width: 12, numFmt: '#,##0.00' },
  { header: 'Sell price',   key: 'sellPrice', width: 12, numFmt: '#,##0.00' },
  { header: 'Profit',       key: 'profit',    width: 12, numFmt: '#,##0.00' },
  { header: 'Margin %',     key: 'margin',    width: 10, numFmt: '#,##0.0' },
  { header: 'Submitted by', key: 'submitter', width: 18 },
  { header: 'Status',       key: 'status',    width: 14 },
  { header: 'Image URL',    key: 'imageUrl',  width: 52 },
];

function invLabel(r: Record<string, unknown>): string {
  const s = (v: unknown) => (v == null ? '' : String(v));
  switch (r.category) {
    case 'RAM': return [s(r.brand), s(r.capacity), s(r.generation)].filter(Boolean).join(' ');
    case 'SSD':
    case 'HDD': return [s(r.brand), s(r.capacity)].filter(Boolean).join(' ');
    default:    return s(r.description);
  }
}
function invSpec(r: Record<string, unknown>): string {
  const s = (v: unknown) => (v == null ? '' : String(v));
  switch (r.category) {
    case 'RAM': return [s(r.classification), s(r.rank), r.speed ? `${r.speed}MHz` : ''].filter(Boolean).join(' · ');
    case 'SSD': return [s(r.interface), s(r.form_factor), r.health != null ? `${r.health}%` : ''].filter(Boolean).join(' · ');
    case 'HDD': return [s(r.interface), s(r.form_factor), r.rpm ? `${r.rpm}rpm` : '', r.health != null ? `${r.health}%` : ''].filter(Boolean).join(' · ');
    default:    return s(r.condition);
  }
}

inventory.get('/export', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const whereFrag = inventoryWhereFrag(c, sql, u);

  const rows = await sql`
    SELECT l.id, l.category, l.brand, l.capacity, l.generation, l.type, l.classification, l.rank, l.speed,
           l.interface, l.form_factor, l.description, l.part_number, l.condition,
           l.qty, l.unit_cost::float AS unit_cost, l.sell_price::float AS sell_price,
           l.status, l.created_at, l.health::float AS health, l.rpm,
           u.name AS user_name, w.short AS warehouse_short,
           img.delivery_url AS image_url
    FROM order_lines l
    JOIN orders o ON o.id = l.order_id
    JOIN users  u ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = COALESCE(l.warehouse_id, o.warehouse_id)
    -- One representative scan per line (LATERAL + LIMIT 1 keeps the join from
    -- multiplying inventory rows). delivery_url is null for stub-provider scans.
    LEFT JOIN LATERAL (
      SELECT ls.delivery_url
      FROM label_scans ls
      WHERE ls.cf_image_id = l.scan_image_id
      ORDER BY ls.created_at ASC
      LIMIT 1
    ) img ON TRUE
    WHERE ${whereFrag}
    ORDER BY l.created_at DESC
  `;

  const data = (rows as Record<string, unknown>[]).map((r) => {
    const unitCost = Number(r.unit_cost ?? 0);
    const sellPrice = r.sell_price == null ? null : Number(r.sell_price);
    const qty = Number(r.qty ?? 0);
    const profit = sellPrice == null ? null : (sellPrice - unitCost) * qty;
    const margin = sellPrice != null && sellPrice > 0 ? ((sellPrice - unitCost) / sellPrice) * 100 : null;
    return {
      id: String(r.id).slice(0, 8),
      date: r.created_at ? new Date(r.created_at as string).toISOString().slice(0, 10) : '',
      category: r.category ?? '',
      item: invLabel(r),
      spec: invSpec(r),
      rank: r.rank ?? '',
      speed: r.speed ?? '',
      part: r.part_number ?? '',
      warehouse: r.warehouse_short ?? '',
      condition: r.condition ?? '',
      qty,
      unitCost,
      sellPrice,
      profit,
      margin,
      submitter: r.user_name ?? '',
      status: r.status ?? '',
      imageUrl: r.image_url ?? '',
    };
  });

  const buf = await buildXlsxBuffer('Inventory', INV_EXPORT_COLS, data);
  return xlsxResponse(buf, datedFilename('inventory'));
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
      l.id AS line_id, l.category, l.brand, l.capacity, l.generation, l.type,
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

// Product-level change log: the UNION of inventory_events across every line
// that shares a part number. PO lines are never merged into a real product
// row, so "the product's history" is the merged history of its peer lines.
//
// Part numbers are matched on a CANONICAL form (strip a leading PN/P/N/S/N/
// PART prefix, drop all whitespace, upper-case) so the same item entered
// sloppily on two POs — "ABC-123", " abc-123 ", "PN: ABC-123" — counts as one
// product. Kept in lockstep with frontend canonicalPartNumber() in
// frontend/src/lib/format.ts and the scan-time rule in src/ai/normalize.ts.
//
// Scoped exactly like the inventory list: managers see the whole workspace,
// purchasers only their own lines (also prevents a purchaser reading another
// buyer's unit_cost out of an 'edited' event detail).
inventory.get('/events/by-part', async (c) => {
  const u = c.var.user;
  const pnRaw = c.req.query('partNumber');
  if (!pnRaw || !pnRaw.trim()) return c.json({ error: 'partNumber is required' }, 400);
  const sql = getDb(c.env);
  const isManager = u.role === 'manager';
  const scopeFrag = isManager ? sql`TRUE` : sql`o.user_id = ${u.id}`;

  const canonCol = canonPartCol(sql, sql`l.part_number`);
  const canonArg = canonPartArg(sql, pnRaw);

  const rows = await sql`
    SELECT
      e.id, e.kind, e.detail, e.created_at,
      l.id AS line_id, l.category, l.brand, l.capacity, l.generation, l.type,
      l.interface, l.description, l.part_number, l.rpm,
      act.name AS actor_name, act.initials AS actor_initials
    FROM inventory_events e
    JOIN order_lines l ON l.id = e.order_line_id
    JOIN orders o      ON o.id = l.order_id
    LEFT JOIN users act ON act.id = e.actor_id
    WHERE ${scopeFrag}
      AND l.part_number IS NOT NULL
      AND ${canonCol} = ${canonArg}
    ORDER BY e.created_at DESC
    LIMIT 200
  `;
  return c.json({ events: rows });
});

// Transfer orders. Manager-only. ?status=pending|received|all (default
// pending). Each order carries every line currently linked to it (no line-
// status filter; lines are In Transit under a Pending order and Done under a
// Received one as a natural consequence of receive/reopen), enriched with
// each line's prior 'from' warehouse from its latest 'transferred' event.
inventory.get('/transfer-orders', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);

  const sp = (c.req.query('status') ?? 'pending').toLowerCase();
  const statusFrag =
    sp === 'received' ? sql`t.status = 'Received'`
    : sp === 'all'    ? sql`TRUE`
    :                   sql`t.status = 'Pending'`;

  const orders = (await sql`
    SELECT t.id, t.from_warehouse_id, t.to_warehouse_id, t.note, t.status,
           t.created_at, t.received_at,
           fw.short AS from_short, tw.short AS to_short,
           cu.name  AS created_by_name,
           (SELECT COUNT(*)::int FROM order_lines ol WHERE ol.transfer_order_id = t.id)             AS item_count,
           (SELECT COALESCE(SUM(ol.qty),0)::int FROM order_lines ol WHERE ol.transfer_order_id = t.id) AS unit_count
    FROM transfer_orders t
    LEFT JOIN warehouses fw ON fw.id = t.from_warehouse_id
    LEFT JOIN warehouses tw ON tw.id = t.to_warehouse_id
    LEFT JOIN users cu      ON cu.id = t.created_by
    WHERE ${statusFrag}
    ORDER BY t.created_at DESC
    LIMIT 200
  `) as unknown as Array<Record<string, unknown> & { id: string }>;

  const orderIds = orders.map((o) => o.id);
  type LineRow = Record<string, unknown> & { transfer_order_id: string };
  const lines = orderIds.length === 0 ? [] : (await sql`
    SELECT l.id, l.transfer_order_id, l.category, l.brand, l.capacity, l.generation,
           l.type, l.description, l.part_number, l.qty, l.position, l.status,
           te.detail->>'from' AS from_wh,
           fw.short AS from_short,
           te.created_at AS transferred_at
    FROM order_lines l
    -- INNER lateral: safe because /transfer always writes a 'transferred'
    -- event in the same tx that sets transfer_order_id (invariant).
    JOIN LATERAL (
      SELECT e.detail, e.created_at
      FROM inventory_events e
      WHERE e.order_line_id = l.id AND e.kind = 'transferred'
      ORDER BY e.created_at DESC
      LIMIT 1
    ) te ON TRUE
    LEFT JOIN warehouses fw ON fw.id = te.detail->>'from'
    WHERE l.transfer_order_id = ANY(${orderIds}::text[])
    ORDER BY l.position
  `) as unknown as LineRow[];

  const byOrder = new Map<string, LineRow[]>();
  for (const ln of lines) {
    const b = byOrder.get(ln.transfer_order_id);
    if (b) b.push(ln);
    else byOrder.set(ln.transfer_order_id, [ln]);
  }
  return c.json({
    orders: orders.map((o) => ({ ...o, lines: byOrder.get(o.id) ?? [] })),
  });
});

// Product-grouped inventory (PRD §5.10 follow-up). Same scoping/filters/cost-
// stripping as the flat list, but collapses lines that share a canonical part
// number into one product row, with each PO/lot embedded. Lines with no part
// number are NOT grouped — each is its own singleton (key `line:<id>`).
//
// Grouping is done in JS over the scoped line set (ordered newest-first).
// RAW_CAP bounds memory; GROUP_CAP bounds the response — matches the flat
// list's 200-row intent applied to groups instead of lines.
inventory.get('/products', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const isManager = u.role === 'manager';
  const category = c.req.query('category');
  const status = c.req.query('status');
  const search = c.req.query('q')?.toLowerCase().trim();
  const warehouse = c.req.query('warehouse');
  const attrs = parseAttrFilters((k) => c.req.query(k));

  const RAW_CAP = 2000;
  const GROUP_CAP = 200;

  const scopeFrag    = isManager ? sql`TRUE` : sql`o.user_id = ${u.id}`;
  const categoryFrag = category ? sql`l.category = ${category}` : sql`TRUE`;
  const statusFrag   = status ? sql`l.status = ${status}` : sql`TRUE`;
  // Warehouse is intentionally NOT pushed into SQL here — keeping every
  // warehouse's rows in the working set lets the warehouse pill counts use the
  // same drop-self facet semantics as the attribute chips.
  const searchFrag   = search
    ? sql`(LOWER(COALESCE(l.brand,'')) LIKE '%' || ${search} || '%' OR LOWER(COALESCE(l.part_number,'')) LIKE '%' || ${search} || '%' OR LOWER(COALESCE(l.description,'')) LIKE '%' || ${search} || '%')`
    : sql`TRUE`;

  const canonCol = canonPartCol(sql, sql`l.part_number`);

  type Row = {
    id: string; order_id: string; user_id: string;
    category: string; brand: string | null; capacity: string | null;
    generation: string | null; type: string | null; classification: string | null;
    rank: string | null; speed: string | null; interface: string | null;
    form_factor: string | null; description: string | null;
    part_number: string | null; canon: string; rpm: number | null;
    condition: string; qty: number; unit_cost: number; sell_price: number | null;
    status: string; health: number | null; created_at: string;
    warehouse_id: string | null; warehouse_short: string | null;
    user_name: string; user_initials: string;
  };

  const rows = (await sql`
    SELECT l.id, l.order_id, o.user_id,
           l.category, l.brand, l.capacity, l.generation, l.type, l.classification,
           l.rank, l.speed, l.interface, l.form_factor, l.description,
           l.part_number, ${canonCol} AS canon, l.rpm,
           l.condition, l.qty, l.unit_cost::float AS unit_cost,
           l.sell_price::float AS sell_price, l.status, l.health::float AS health,
           l.created_at,
           COALESCE(l.warehouse_id, o.warehouse_id) AS warehouse_id,
           w.short AS warehouse_short,
           u.name AS user_name, u.initials AS user_initials
    FROM order_lines l
    JOIN orders o ON o.id = l.order_id
    JOIN users  u ON u.id = o.user_id
    LEFT JOIN warehouses w ON w.id = COALESCE(l.warehouse_id, o.warehouse_id)
    WHERE ${scopeFrag} AND ${categoryFrag} AND ${statusFrag} AND ${searchFrag}
    ORDER BY l.created_at DESC
    LIMIT ${RAW_CAP}
  `) as unknown as Row[];

  const groups = new Map<string, Row[]>();
  const order: string[] = [];
  for (const r of rows) {
    const key = r.canon && r.canon.length > 0 ? r.canon : `line:${r.id}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else { groups.set(key, [r]); order.push(key); }
  }

  // Facet model: across-facet AND, within-facet OR. Each facet's chip counts
  // are computed with that facet's OWN filter dropped (drop-self) so picking
  // DDR4 doesn't make DDR5 vanish from the bar — same applies to warehouses.
  type FacetKey = keyof AttrFilters;
  const FACET_KEYS: FacetKey[] = ['brand','capacity','generation','type','classification','rank','speed','interface','form_factor','rpm'];
  const groupMatchesWarehouse = (lots: Row[]): boolean => {
    if (!warehouse) return true;
    return lots.some((l) => l.warehouse_id === warehouse);
  };
  const groupMatchesAttr = (lots: Row[], skip: FacetKey | null): boolean => {
    for (const fk of FACET_KEYS) {
      if (fk === skip) continue;
      const sel = attrs[fk] as Array<string | number>;
      if (!sel.length) continue;
      const ok = lots.some((l) => {
        const v = (l as unknown as Record<string, unknown>)[fk];
        if (v == null) return false;
        return (sel as Array<string | number>).some((s) => String(s) === String(v));
      });
      if (!ok) return false;
    }
    return true;
  };
  const facets: Record<FacetKey, Record<string, number>> = {
    brand: {}, capacity: {}, generation: {}, type: {}, classification: {},
    rank: {}, speed: {}, interface: {}, form_factor: {}, rpm: {},
  };
  for (const key of order) {
    const lots = groups.get(key)!;
    if (!groupMatchesWarehouse(lots)) continue;
    for (const fk of FACET_KEYS) {
      if (!groupMatchesAttr(lots, fk)) continue;
      const seen = new Set<string>();
      for (const l of lots) {
        const v = (l as unknown as Record<string, unknown>)[fk];
        if (v == null || v === '') continue;
        const sv = String(v);
        if (seen.has(sv)) continue;
        seen.add(sv);
        facets[fk][sv] = (facets[fk][sv] ?? 0) + 1;
      }
    }
  }

  // Final product list: keep groups where at least one lot matches every facet
  // (warehouse + attributes).
  const applyAll = (lots: Row[]) =>
    groupMatchesWarehouse(lots) && groupMatchesAttr(lots, null);
  const filteredOrder = order.filter((k) => applyAll(groups.get(k)!));

  const SPEC_KEYS = ['category','brand','capacity','generation','type','classification','rank','speed','interface','form_factor','description','rpm'] as const;

  const products = filteredOrder.slice(0, GROUP_CAP).map((key) => {
    const lots = groups.get(key)!;
    const head = lots[0];
    const isSingleton = !(head.canon && head.canon.length > 0);

    let qty = 0, inTransit = 0, inStock = 0, reviewing = 0;
    let costMin = Infinity, costMax = -Infinity, costWeighted = 0;
    const whs = new Set<string>();
    const submitters = new Set<string>();
    let mixed = false;
    let repPn: string | null = null;

    for (const l of lots) {
      qty += l.qty;
      if (l.status === 'In Transit') inTransit += l.qty;
      else if (l.status === 'Done') inStock += l.qty;
      else if (l.status === 'Reviewing') reviewing += l.qty;
      costMin = Math.min(costMin, l.unit_cost);
      costMax = Math.max(costMax, l.unit_cost);
      costWeighted += l.unit_cost * l.qty;
      if (l.warehouse_short) whs.add(l.warehouse_short);
      if (l.user_name) submitters.add(l.user_name);
      if (repPn === null && l.part_number) repPn = l.part_number;
      for (const k of SPEC_KEYS) {
        if (String((l as Record<string, unknown>)[k] ?? '') !== String((head as Record<string, unknown>)[k] ?? '')) mixed = true;
      }
    }

    const base = {
      key,
      part_number: repPn,
      category: head.category, brand: head.brand, capacity: head.capacity,
      generation: head.generation, type: head.type, classification: head.classification,
      rank: head.rank, speed: head.speed, interface: head.interface,
      form_factor: head.form_factor, description: head.description, rpm: head.rpm,
      mixed_spec: isSingleton ? false : mixed,
      qty,
      qty_in_transit: inTransit, qty_in_stock: inStock, qty_reviewing: reviewing,
      lot_count: lots.length,
      po_count: new Set(lots.map((l) => l.order_id)).size,
      sell_price: head.sell_price,
      warehouses: [...whs],
      created_at: head.created_at,
      submitters: [...submitters],
      lines: lots.map((l) => ({
        id: l.id, order_id: l.order_id, created_at: l.created_at,
        user_name: l.user_name, user_initials: l.user_initials,
        sell_price: l.sell_price, condition: l.condition, health: l.health,
        warehouse_id: l.warehouse_id, warehouse_short: l.warehouse_short,
        qty: l.qty, status: l.status,
        ...(isManager ? { unit_cost: l.unit_cost } : {}),
      })),
    };

    if (!isManager) return base;
    return {
      ...base,
      unit_cost_min: costMin === Infinity ? 0 : costMin,
      unit_cost_max: costMax === -Infinity ? 0 : costMax,
      unit_cost_avg: qty > 0 ? costWeighted / qty : 0,
    };
  });

  // Warehouse pill counts: drop-self warehouse facet — every warehouse shows
  // its count assuming the warehouse filter is cleared, with all attribute
  // filters still applied. `total` is the "All warehouses" pill count under
  // the same attribute filters.
  const warehouseProducts: Record<string, number> = {};
  let totalProducts = 0;
  for (const key of order) {
    const lots = groups.get(key)!;
    if (!groupMatchesAttr(lots, null)) continue;
    totalProducts += 1;
    const whs = new Set<string>();
    for (const l of lots) if (l.warehouse_id) whs.add(l.warehouse_id);
    for (const w of whs) warehouseProducts[w] = (warehouseProducts[w] ?? 0) + 1;
  }

  return c.json({
    products,
    facets,
    warehouse_counts: warehouseProducts,
    total: totalProducts,
  });
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
  // Field range gates — surface as 400s before we ever reach the DB. Without
  // these, qty=0 / negative price hit a CHECK constraint and surfaced as a
  // 500 (looks like an internal error to the caller).
  if (body.qty !== undefined && (!Number.isInteger(body.qty) || body.qty <= 0)) {
    return c.json({ error: 'qty must be a positive integer' }, 400);
  }
  if (body.unitCost !== undefined && (!Number.isFinite(body.unitCost) || body.unitCost < 0)) {
    return c.json({ error: 'unitCost must be ≥ 0' }, 400);
  }
  if (body.sellPrice !== undefined && body.sellPrice !== null &&
      (!Number.isFinite(body.sellPrice) || body.sellPrice < 0)) {
    return c.json({ error: 'sellPrice must be ≥ 0' }, 400);
  }

  // Permission probe runs outside the tx — it doesn't write and the user_id
  // on the parent order doesn't change under us.
  const probe = (await sql<{ user_id: string }[]>`
    SELECT o.user_id FROM order_lines ol
    JOIN orders o ON o.id = ol.order_id
    WHERE ol.id = ${id} LIMIT 1
  `)[0];
  if (!probe) return c.json({ error: 'Not found' }, 404);
  if (u.role !== 'manager' && probe.user_id !== u.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (u.role !== 'manager' && (body.status !== undefined || body.sellPrice !== undefined)) {
    return c.json({ error: 'Only managers can change status or sell price' }, 403);
  }

  // The snapshot read, the open-sell-order check and the UPDATE all run in
  // one transaction with the order_lines row locked FOR UPDATE. Previously
  // the snapshot + the sell-order check happened on the pool, then the
  // UPDATE on a separate connection — a concurrent sell-order POST could
  // attach an open order to the line between the check and the UPDATE and
  // we'd silently change qty/status out from under the deal.
  type Outcome =
    | { kind: 'notFound' }
    | { kind: 'committed' }
    | { kind: 'ok'; before: Record<string, unknown> };
  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const before = (await tx<Record<string, unknown>[]>`
      SELECT * FROM order_lines WHERE id = ${id} LIMIT 1 FOR UPDATE
    `)[0];
    if (!before) return { kind: 'notFound' };

    // A line committed to an open (non-Done) sell order is "spoken for":
    // editing its qty or status out from under the deal silently corrupts
    // that sell order's totals/sellability. Mirrors the reopen guard
    // (sell_count > 0) and the one-active-sell-order-per-line invariant.
    // Other fields stay editable. Run under the row lock so a concurrent
    // sell-order create can't slip an attachment in between.
    if (body.qty !== undefined || body.status !== undefined) {
      const open = (await tx<{ n: number }[]>`
        SELECT COUNT(*)::int AS n
        FROM sell_order_lines sol
        JOIN sell_orders so ON so.id = sol.sell_order_id
        WHERE sol.inventory_id = ${id} AND so.status <> 'Done'
      `)[0];
      if (open.n > 0) return { kind: 'committed' };
    }

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
    return { kind: 'ok', before };
  });

  if (outcome.kind === 'notFound') return c.json({ error: 'Not found' }, 404);
  if (outcome.kind === 'committed') {
    return c.json({ error: 'line is committed to an open sell order; close or unlink it before changing qty/status' }, 409);
  }
  const before = outcome.before;

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
    const floor = await getWorkspaceSetting(sql, 'low_margin_floor', 0.15);
    if (margin < floor) {
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
    generation: string | null;
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

  type ResultLine = { sourceId: string; destId: string; qty: number };
  type Outcome =
    | { kind: 'missing' }
    | { kind: 'lineNotFound'; id: string }
    | { kind: 'notSellable'; id: string; status: string }
    | { kind: 'overQty'; id: string; have: number }
    | { kind: 'alreadyThere'; id: string }
    | { kind: 'ok'; transferOrderId: string; result: ResultLine[] };

  // Source read, validation and writes all run in one tx with the source
  // order_lines rows locked FOR UPDATE. Validating a pre-tx snapshot let a
  // concurrent transfer / qty edit / sell-order consumption change the rows
  // before the writes — double-moves or a CHECK(qty>0) 500.
  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const sources = (await tx`
      SELECT l.id, l.order_id, l.category, l.brand, l.capacity, l.generation, l.type, l.classification,
             l.rank, l.speed, l.interface, l.form_factor, l.description, l.part_number,
             l.condition, l.qty, l.unit_cost, l.sell_price, l.status, l.position,
             l.health, l.rpm, l.scan_image_id, l.scan_confidence,
             COALESCE(l.warehouse_id, o.warehouse_id) AS effective_wh
      FROM order_lines l
      JOIN orders o ON o.id = l.order_id
      WHERE l.id = ANY(${ids}::uuid[])
      FOR UPDATE OF l
    `) as unknown as SourceRow[];

    if (sources.length !== reqLines.length) return { kind: 'missing' };
    const byId = new Map(sources.map((s) => [s.id, s]));

    // Validate every line before touching anything. One bad line aborts the
    // whole submission — partial transfers across the batch are confusing.
    for (const r of reqLines) {
      const s = byId.get(r.id);
      if (!s) return { kind: 'lineNotFound', id: r.id };
      if (s.status !== 'Reviewing' && s.status !== 'Done') {
        return { kind: 'notSellable', id: r.id, status: s.status };
      }
      if (r.qty > s.qty) return { kind: 'overQty', id: r.id, have: s.qty };
      if (s.effective_wh === toWarehouseId) return { kind: 'alreadyThere', id: r.id };
    }

    const result: ResultLine[] = [];

    // Single common source if every line shares one effective warehouse,
    // else NULL (mixed-source transfer order). effective_wh may be null.
    const sourceSet = new Set(reqLines.map((r) => byId.get(r.id)!.effective_wh ?? null));
    const fromWarehouse = sourceSet.size === 1 ? ([...sourceSet][0] ?? null) : null;

    // Human-friendly id like TO-1001, allocated atomically (see id-seq.ts).
    const transferOrderId = await nextHumanId(tx, 'TO', 'TO');
    await tx`
      INSERT INTO transfer_orders (id, from_warehouse_id, to_warehouse_id, note, created_by, status)
      VALUES (${transferOrderId}, ${fromWarehouse}, ${toWarehouseId}, ${note}, ${u.id}, 'Pending')
    `;

    for (const r of reqLines) {
      const s = byId.get(r.id)!;
      const fromWh = s.effective_wh ?? '';

      if (r.qty === s.qty) {
        // Full move — flip the override on the existing line.
        await tx`
          UPDATE order_lines
             SET warehouse_id = ${toWarehouseId}, status = 'In Transit',
                 transfer_order_id = ${transferOrderId}
           WHERE id = ${r.id}
        `;
        await tx`
          INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
          VALUES (${r.id}, ${u.id}, 'transferred',
                  ${tx.json({ from: fromWh, to: toWarehouseId, qty: r.qty, transfer_order_id: transferOrderId, ...(note ? { note } : {}) })})
        `;
        result.push({ sourceId: r.id, destId: r.id, qty: r.qty });
      } else {
        // Partial — decrement source, clone the rest at destination.
        // Source line stays put (not moved) — intentionally NOT stamped with
        // transfer_order_id; only the moved clone belongs to this order.
        await tx`
          UPDATE order_lines SET qty = qty - ${r.qty} WHERE id = ${r.id}
        `;
        const inserted = (await tx`
          INSERT INTO order_lines (
            order_id, category, brand, capacity, generation, type, classification, rank, speed,
            interface, form_factor, description, part_number, condition,
            qty, unit_cost, sell_price, status,
            scan_image_id, scan_confidence, position,
            health, rpm, warehouse_id, transfer_order_id
          )
          VALUES (
            ${s.order_id}, ${s.category}, ${s.brand}, ${s.capacity}, ${s.generation}, ${s.type},
            ${s.classification}, ${s.rank}, ${s.speed}, ${s.interface},
            ${s.form_factor}, ${s.description}, ${s.part_number}, ${s.condition},
            ${r.qty}, ${s.unit_cost}, ${s.sell_price}, 'In Transit',
            ${s.scan_image_id}, ${s.scan_confidence}, ${s.position},
            ${s.health}, ${s.rpm}, ${toWarehouseId}, ${transferOrderId}
          )
          RETURNING id
        `) as unknown as Array<{ id: string }>;
        const destId = inserted[0].id;
        const detail = { from: fromWh, to: toWarehouseId, qty: r.qty, transfer_order_id: transferOrderId, ...(note ? { note } : {}) };
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
    return { kind: 'ok', transferOrderId, result };
  });

  if (outcome.kind === 'missing') return c.json({ error: 'one or more lines not found' }, 404);
  if (outcome.kind === 'lineNotFound') return c.json({ error: `line ${outcome.id} not found` }, 404);
  if (outcome.kind === 'notSellable') {
    return c.json({ error: `line ${outcome.id} is ${outcome.status}; only Reviewing/Done can be transferred` }, 400);
  }
  if (outcome.kind === 'overQty') return c.json({ error: `line ${outcome.id} only has ${outcome.have} units` }, 400);
  if (outcome.kind === 'alreadyThere') return c.json({ error: `line ${outcome.id} is already in ${toWarehouseId}` }, 400);
  return c.json({ ok: true, transferOrderId: outcome.transferOrderId, lines: outcome.result });
});

// Receive a whole transfer order. Manager-only. Validates the order is
// Pending (row-locked inside the tx), flips every still-In-Transit line under
// it to Done with a 'received' event, and marks the order Received.
inventory.post('/transfer-orders/:id/receive', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const sql = getDb(c.env);

  // Lock the order row inside the tx and re-check status there — prevents two
  // concurrent receives from both passing the guard and double-writing events.
  type Outcome = { code: 404 | 400; msg: string } | { code: 200 };
  let outcome: Outcome = { code: 200 };

  await sql.begin(async (tx) => {
    const ord = (await tx`
      SELECT id, status, to_warehouse_id FROM transfer_orders
      WHERE id = ${id} FOR UPDATE
    `)[0] as { id: string; status: string; to_warehouse_id: string } | undefined;
    if (!ord) { outcome = { code: 404, msg: `transfer order ${id} not found` }; return; }
    if (ord.status !== 'Pending') {
      outcome = { code: 400, msg: `transfer order ${id} is ${ord.status}; only Pending can be received` };
      return;
    }
    const lines = (await tx`
      SELECT id FROM order_lines
      WHERE transfer_order_id = ${id} AND status = 'In Transit'
    `) as unknown as Array<{ id: string }>;
    if (lines.length > 0) {
      // Collapse the per-line UPDATE+INSERT pair into two bulk statements.
      // Receiving a 200-line transfer order used to fire 400 sequential
      // round-trips inside the tx — under load that's a slow request and
      // unnecessary lock duration on the order_lines rows.
      const lineIds = lines.map(l => l.id);
      await tx`
        UPDATE order_lines SET status = 'Done'
        WHERE id = ANY(${lineIds}::uuid[])
      `;
      const detail = tx.json({ at: ord.to_warehouse_id, transfer_order_id: id });
      await tx`
        INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
        SELECT id, ${u.id}::uuid, 'received', ${detail}::jsonb
        FROM order_lines
        WHERE id = ANY(${lineIds}::uuid[])
      `;
    }
    await tx`
      UPDATE transfer_orders
         SET status = 'Received', received_at = NOW(), received_by = ${u.id}
       WHERE id = ${id}
    `;
  });

  if (outcome.code !== 200) {
    const err = outcome as { code: 404 | 400; msg: string };
    return c.json({ error: err.msg }, err.code);
  }
  return c.json({ ok: true, id });
});

// Re-open a received transfer order. Manager-only. Reverts the lines that
// CURRENTLY point to the order (a line re-transferred elsewhere had its
// transfer_order_id overwritten and is intentionally not chased). Guard:
// every such line must still be Done and not committed to a sell order.
inventory.post('/transfer-orders/:id/reopen', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const sql = getDb(c.env);

  type Outcome = { code: 404 | 400 | 409; msg: string } | { code: 200 };
  let outcome: Outcome = { code: 200 };

  await sql.begin(async (tx) => {
    const ord = (await tx`
      SELECT id, status FROM transfer_orders WHERE id = ${id} FOR UPDATE
    `)[0] as { id: string; status: string } | undefined;
    if (!ord) { outcome = { code: 404, msg: `transfer order ${id} not found` }; return; }
    if (ord.status !== 'Received') {
      outcome = { code: 400, msg: `transfer order ${id} is ${ord.status}; only Received can be re-opened` };
      return;
    }

    const lines = (await tx`
      SELECT l.id, l.status,
             (SELECT COUNT(*)::int FROM sell_order_lines sl WHERE sl.inventory_id = l.id) AS sell_count
      FROM order_lines l
      WHERE l.transfer_order_id = ${id}
      FOR UPDATE OF l
    `) as unknown as Array<{ id: string; status: string; sell_count: number }>;

    if (lines.length === 0) {
      outcome = { code: 409, msg: `transfer order ${id} has no lines to re-open` };
      return;
    }
    const bad = lines.filter((l) => l.status !== 'Done' || l.sell_count > 0);
    if (bad.length > 0) {
      outcome = { code: 409, msg: `cannot re-open: line(s) ${bad.map((l) => l.id).join(', ')} have moved on since receipt` };
      return;
    }

    for (const l of lines) {
      await tx`UPDATE order_lines SET status = 'In Transit' WHERE id = ${l.id}`;
      await tx`
        INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
        VALUES (${l.id}, ${u.id}, 'reopened', ${tx.json({ transfer_order_id: id })})
      `;
    }
    await tx`
      UPDATE transfer_orders
         SET status = 'Pending', received_at = NULL, received_by = NULL
       WHERE id = ${id}
    `;
  });

  if (outcome.code !== 200) {
    const err = outcome as { code: 404 | 400 | 409; msg: string };
    return c.json({ error: err.msg }, err.code);
  }
  return c.json({ ok: true, id });
});

export default inventory;
