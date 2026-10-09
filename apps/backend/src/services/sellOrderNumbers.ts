// A sell order's product # and the packing list's products, from one fold.
//
// The # is the number the packer labels a product's items with and the
// receiver checks the box by. It is stored (sell_order_lines.product_no,
// migration 0170): given once, when the product is put on the order, and never
// recomputed — a removed product leaves a gap, and a spec edit, a transfer or
// a warehouse change moves nothing. Lots of one product share its #.
//
// The fold below still decides where each product PRINTS — warehouse tab, then
// category, device, DDR generation, brand / capacity / speed — and which lot's
// details it shows. A new order's products are numbered in that order, so its
// packing list reads 1..N; later ones take the next # wherever they print.
import type postgres from 'postgres';
import type { SqlLike } from '../db';
import { comparePoIds, packSections, type PoSource, type PriceTemplateProduct } from '../lib/sellOrderPriceTemplate';
import { canonPartNumberJs } from '../lib/part-number';
import { invLabel } from '../lib/inventoryLabel';
import { poLineNo, sellLineOrder } from '../lib/poLineNo';

// Category buckets for the price template: unknown categories fold into
// Other so every line lands somewhere.
const SO_CATEGORY_ORDER = ['RAM', 'SSD', 'HDD', 'Other'] as const;
type SoCategory = (typeof SO_CATEGORY_ORDER)[number];

// One row of an order's lines as the sheets read them: the line, its lot's
// spec, and where the lot is now. Both sheetRows below and GET /:id produce
// these, so the order page and the files fold the same lines the same way —
// spelled out field by field so a typo in either producer fails to compile
// instead of quietly misplacing one of them.
export type SheetLineRow = {
  sol_id: string; sell_qty: number;
  sol_label: string; sol_sub: string | null; sol_part: string | null;
  sol_category: string; sol_condition: string | null;
  // Null until numbered: only a line an older instance wrote mid-deploy.
  product_no: number | null;
  // What the # was derived from before 0170 — read by legacyNumbers alone.
  append_batch: number | null;
  // The lot's current warehouse, not the one saved on the line: a transfer of
  // committed stock moves the lot, and the pick happens where it is.
  pack_warehouse: string | null;
  inv_id: string | null; source_order_id: string | null; po_line_no: number | null;
  category: string | null; brand: string | null; capacity: string | null;
  generation: string | null; type: string | null; classification: string | null;
  rank: string | null; speed: string | null; interface: string | null;
  form_factor: string | null; description: string | null; part_number: string | null;
  chip_number: string | null; condition: string | null; health: number | null;
  rpm: number | null; image_url: string | null;
};

type SheetSource = PoSource & { solIds: string[] };
type SheetProduct = Omit<PriceTemplateProduct, 'category' | 'poSources'>
  & { category: SoCategory; key: string; id: string; poSources: SheetSource[] };

// A line with what the fold reads off it, worked out once.
type FoldLine = {
  row: SheetLineRow; qty: number; key: string; label: string; category: SoCategory;
  part: string | null; po: string | null; lineNo: number | null;
};

// The spec fields that place a product on the sheet — device and generation
// group it, brand/capacity/speed order it. They come from the one line that
// places the product, so the row prints where it sorts and under the group
// labels it sits in.
const PLACING_SPECS = ['brand', 'capacity', 'generation', 'type', 'speed'] as const;

// The order a product's lines are read in: by PO and line # on it, never by
// `position`, which every save of the editor rewrites. A hand-typed line came
// from no PO and goes last, ordered by its text.
function byPoLine(a: FoldLine, b: FoldLine): number {
  if (a.po && b.po) return comparePoIds(a.po, b.po) || a.lineNo! - b.lineNo!;
  if (a.po || b.po) return a.po ? -1 : 1;
  return a.category.localeCompare(b.category) || (a.part ?? '').localeCompare(b.part ?? '');
}

// Only real public URLs make the sheet — seeded/stub scans carry data: URLs
// that would render as garbage text in the cell.
const publicUrl = (v: unknown): string | null =>
  typeof v === 'string' && /^https:\/\//i.test(v) ? v : null;
const text = (v: unknown) => (v == null ? '' : String(v));

function foldLine(r: SheetLineRow): FoldLine {
  const hasInv = r.inv_id != null;
  // Manual lines fold sub_label into the label — the sheet's spec columns
  // only fill from an inventory row.
  const label = hasInv ? invLabel(r) : [r.sol_label, r.sol_sub].filter(Boolean).join(' — ');
  const rawCategory = text(r.category ?? r.sol_category);
  const category: SoCategory = (SO_CATEGORY_ORDER as readonly string[]).includes(rawCategory)
    ? (rawCategory as SoCategory)
    : 'Other';
  const part = r.part_number ?? r.sol_part ?? null;
  const condition = r.condition ?? r.sol_condition ?? null;
  return {
    row: r, qty: Number(r.sell_qty ?? 0), label, category, part,
    key: `${part ? canonPartNumberJs(part) : ''}|${label}|${condition ?? ''}`,
    // Both null for a hand-typed line, both set for a lot: order_lines.order_id
    // is NOT NULL and poLineNo is null only without a lot.
    po: r.source_order_id || null,
    lineNo: r.po_line_no,
  };
}

// A line's product: its stored # — lots of one product share it. A line not
// numbered yet folds by its key until a save numbers it.
const productIdOf = (l: FoldLine): string =>
  l.row.product_no != null ? `#${l.row.product_no}` : `key:${l.key}`;
const byKey = (l: FoldLine): string => l.key;

// One product from its lines. Its place — category, label, placing specs — is
// its first line by PO and line #, 0s included, so neither a save nor zeroing
// a line can move it. What a picker checks against the lot in hand — health,
// rank, the part # spelling, the photo — is the first line above 0's: a line
// held at 0 is not what ships.
function foldProduct(id: string, lines: readonly FoldLine[]): SheetProduct {
  const ordered = [...lines].sort(byPoLine);
  const first = ordered[0]!;
  const live = ordered.filter((l) => l.qty > 0);
  const shown = live[0] ?? first;
  const lot = live.find((l) => l.row.inv_id != null)?.row;
  const placing = first.row.inv_id != null ? first.row : null;
  const specs: Record<string, string | number> = {};
  if (placing) {
    for (const k of PLACING_SPECS) specs[k] = text(placing[k]);
    Object.assign(specs, {
      classification: text(lot?.classification), rank: text(lot?.rank),
      chip: text(lot?.chip_number), interface: text(lot?.interface),
      formFactor: text(lot?.form_factor), health: lot?.health ?? '', rpm: lot?.rpm ?? '',
    });
  }
  const poSources: SheetSource[] = [];
  for (const l of ordered) {
    const src = poSources.find((x) => x.po === l.po && x.lineNo === l.lineNo);
    if (src) {
      src.qty += l.qty;
      src.solIds.push(l.row.sol_id);
    } else {
      poSources.push({ po: l.po, lineNo: l.lineNo, qty: l.qty, solIds: [l.row.sol_id] });
    }
  }
  return {
    id, category: first.category, key: first.key, label: first.label,
    partNumber: shown.part, condition: first.row.condition ?? first.row.sol_condition ?? null,
    qty: lines.reduce((a, l) => a + l.qty, 0),
    imageUrl: live.map((l) => publicUrl(l.row.image_url)).find(Boolean) ?? null,
    specs, poSources,
    ...(first.row.product_no != null ? { no: first.row.product_no } : {}),
  };
}

// Products grouped by `idOf`, in key order. Every sort after this is stable, so
// a tie on everything the sheet sorts by goes by the key — never by input order.
function foldProducts(lines: readonly FoldLine[], idOf: (l: FoldLine) => string = productIdOf): SheetProduct[] {
  const byId = new Map<string, FoldLine[]>();
  for (const l of lines) {
    const id = idOf(l);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push(l);
  }
  return [...byId.entries()]
    .map(([id, ls]) => foldProduct(id, ls))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const warehouseOf = (l: FoldLine) => text(l.row.pack_warehouse) || 'Unassigned';

// Warehouse tabs alphabetical, Unassigned last (the old packing-list rule).
function byWarehouseTab(lines: readonly FoldLine[]): [string, FoldLine[]][] {
  const byWarehouse = new Map<string, FoldLine[]>();
  for (const l of lines) {
    const wh = warehouseOf(l);
    if (!byWarehouse.has(wh)) byWarehouse.set(wh, []);
    byWarehouse.get(wh)!.push(l);
  }
  return [...byWarehouse.entries()].sort(([a], [b]) => {
    if (a === 'Unassigned') return 1;
    if (b === 'Unassigned') return -1;
    return a.localeCompare(b);
  });
}

// The packing list's products per warehouse tab, each in its sheet row, with
// its stored #; and the order's lines in # order, which is how the order page
// and Pack mode list them. A product whose lots sit in two warehouses prints
// on both tabs under its one #, and its lines stay together.
//
// A line held at 0 is folded and numbered like any other, and only then left
// off the files.
export function numberSheetLines(rows: readonly SheetLineRow[]) {
  const lines = rows.map(foldLine);
  const numbered = byWarehouseTab(lines).map(([warehouse, whLines]) => ({
    warehouse,
    products: packSections(foldProducts(whLines)).flatMap((s) => s.rows),
    lines: whLines,
  }));

  const placed = numbered.flatMap(({ products }, w) => products.map((p, i) => ({ p, w, i })));
  placed.sort((a, b) => {
    // Unnumbered products (a line an older instance wrote) come last.
    if (a.p.no !== b.p.no) {
      if (a.p.no == null) return 1;
      if (b.p.no == null) return -1;
      return a.p.no - b.p.no;
    }
    return a.w - b.w || a.i - b.i;
  });
  const lineOrder: string[] = [];
  const noByLine = new Map<string, number>();
  for (const { p } of placed) {
    for (const src of p.poSources) {
      for (const lineId of src.solIds) {
        lineOrder.push(lineId);
        if (p.no != null) noByLine.set(lineId, p.no);
      }
    }
  }
  return { numbered, lineOrder, noByLine, lines };
}

// What the files show, from the numbered products: a line held at 0 is
// nothing to price or pick, and a tab or PO left empty goes. Its product
// keeps its #.
export function foldSheetLines(rows: readonly SheetLineRow[]) {
  const { numbered, lines } = numberSheetLines(rows);
  const live = (p: SheetProduct): SheetProduct[] => {
    const poSources = p.poSources.filter((x) => x.qty > 0);
    return poSources.length ? [{ ...p, poSources }] : [];
  };
  const warehouses = numbered
    .map(({ warehouse, products }) => ({ warehouse, products: products.flatMap(live) }))
    .filter((w) => w.products.length > 0);

  // The by-PO tabs cut each numbered product by the PO its live lines came
  // from. A cut keeps the product's #, place and group, and shows its own
  // lots' details — the PO-2 tab doesn't print PO-1's health.
  const poWarehouses = numbered
    .map(({ warehouse, products, lines: whLines }) => {
      const byPo = new Map<string, SheetProduct[]>();
      const liveById = new Map<string, FoldLine[]>();
      for (const l of whLines) {
        if (l.qty === 0) continue;
        const id = productIdOf(l);
        if (!liveById.has(id)) liveById.set(id, []);
        liveById.get(id)!.push(l);
      }
      for (const p of products) {
        const cuts = new Map<string, FoldLine[]>();
        for (const l of liveById.get(p.id) ?? []) {
          const po = l.po ?? '';
          if (!cuts.has(po)) cuts.set(po, []);
          cuts.get(po)!.push(l);
        }
        for (const [po, cut] of cuts) {
          const own = foldProduct(p.id, cut);
          const placing = Object.fromEntries(PLACING_SPECS.map((k) => [k, p.specs[k] ?? '']));
          if (!byPo.has(po)) byPo.set(po, []);
          byPo.get(po)!.push({
            ...own, category: p.category, label: p.label, no: p.no,
            specs: Object.keys(p.specs).length ? { ...own.specs, ...placing } : own.specs,
          });
        }
      }
      const pos = [...byPo.entries()]
        .sort(([a], [b]) => {
          // Hand-typed lines came from no PO and go last.
          if (!a) return 1;
          if (!b) return -1;
          return comparePoIds(a, b);
        })
        .map(([po, cutProducts]) => ({ po: po || null, products: cutProducts }));
      return { warehouse, pos };
    })
    .filter((w) => w.pos.length > 0);

  return { products: foldProducts(lines, byKey).flatMap(live), warehouses, poWarehouses };
}

// An order's lines as the fold reads them. Read under the order's lock by the
// writers below, and by the packing-list and bid-sheet downloads.
export async function sheetRows(sql: SqlLike, id: string): Promise<SheetLineRow[]> {
  return sql<SheetLineRow[]>`
    SELECT
      sol.id AS sol_id, sol.qty AS sell_qty,
      sol.label AS sol_label, sol.sub_label AS sol_sub, sol.part_number AS sol_part,
      sol.category AS sol_category, sol.condition AS sol_condition,
      sol.product_no, sol.append_batch,
      w.short AS pack_warehouse,
      l.id AS inv_id, l.order_id AS source_order_id, ${poLineNo(sql, 'l')} AS po_line_no,
      l.category, l.brand, l.capacity, l.generation, l.type,
      l.classification, l.rank, l.speed, l.interface, l.form_factor, l.description,
      l.part_number, l.chip_number, l.condition, l.health::float AS health,
      l.rpm,
      img.delivery_url AS image_url
    FROM sell_order_lines sol
    LEFT JOIN order_lines l ON l.id = sol.inventory_id
    LEFT JOIN orders src ON src.id = l.order_id
    -- The lot's current warehouse, not the one saved on the line: a transfer
    -- of committed stock moves the lot, and the pick happens where it is.
    LEFT JOIN warehouses w ON w.id = COALESCE(l.warehouse_id, src.warehouse_id, sol.warehouse_id)
    LEFT JOIN LATERAL (
      SELECT ls.delivery_url
      FROM label_scans ls
      WHERE ls.cf_image_id = l.scan_image_id
      ORDER BY ls.created_at ASC
      LIMIT 1
    ) img ON TRUE
    WHERE sol.sell_order_id = ${id}
    ORDER BY ${sellLineOrder(sql, 'sol')}
  ` as Promise<SheetLineRow[]>;
}

async function writeNumbers(
  tx: SqlLike, soId: string, noByLine: ReadonlyMap<string, number>, next: number,
): Promise<void> {
  if (noByLine.size) {
    const ids = [...noByLine.keys()];
    const nos = ids.map((id) => noByLine.get(id)!);
    await tx`
      UPDATE sell_order_lines sol SET product_no = v.no
      FROM unnest(${ids}::uuid[], ${nos}::int[]) AS v(id, no)
      WHERE sol.id = v.id AND sol.sell_order_id = ${soId}`;
  }
  await tx`UPDATE sell_orders SET next_product_no = GREATEST(next_product_no, ${next}) WHERE id = ${soId}`;
}

// Numbers every line of the order that has no # yet. The caller holds the
// order's row lock (sell_orders FOR UPDATE) or has just created it.
//
// A lot of a product already on the order — same warehouse tab, same
// part|label|condition — joins its #. The rest are new products: folded among
// themselves, they take the next #s in packing-list order, so a new order
// reads 1..N down its sheet and a later save's products follow every other.
export async function assignSellProductNos(tx: SqlLike, soId: string): Promise<void> {
  const lines = (await sheetRows(tx, soId)).map(foldLine);
  const fresh = lines.filter((l) => l.row.product_no == null);
  if (!fresh.length) return;

  const slot = (l: FoldLine) => `${warehouseOf(l)}\u0000${l.key}`;
  const existing = new Map<string, number>();
  for (const l of lines) {
    const no = l.row.product_no;
    if (no == null) continue;
    const had = existing.get(slot(l));
    if (had == null || no < had) existing.set(slot(l), no);
  }

  const [{ next_product_no: start }] = await tx<{ next_product_no: number }[]>`
    SELECT next_product_no FROM sell_orders WHERE id = ${soId}`;
  let next = start;
  const assigned = new Map<string, number>();
  const newcomers: FoldLine[] = [];
  for (const l of fresh) {
    const joins = existing.get(slot(l));
    if (joins != null) assigned.set(l.row.sol_id, joins);
    else newcomers.push(l);
  }
  for (const [, whLines] of byWarehouseTab(newcomers)) {
    for (const p of packSections(foldProducts(whLines, byKey)).flatMap((s) => s.rows)) {
      const no = next++;
      for (const src of p.poSources) for (const lineId of src.solIds) assigned.set(lineId, no);
    }
  }
  await writeNumbers(tx, soId, assigned, next);
}

// ── Before 0170 ─────────────────────────────────────────────────────────────
// The # every order showed until it was stored: derived on each read from the
// packing-list sort, one per (warehouse tab, part|label|condition), in tiers of
// append_batch (RS-206) so a product added past Draft went after the rest.
// Kept only to freeze those numbers once (freezeLegacySellNumbers); delete it
// with append_batch once prod holds no unnumbered line.
export function legacyNumbers(rows: readonly SheetLineRow[]): Map<string, number> {
  const lines = rows.map(foldLine);
  const numbered = byWarehouseTab(lines).map(([, whLines]) =>
    packSections(foldProducts(whLines, byKey)).flatMap((s) => s.rows));

  const batchByLine = new Map(lines.map((l) => [l.row.sol_id, l.row.append_batch]));
  const tierOf = (p: SheetProduct): number => {
    let tier = Infinity;
    for (const src of p.poSources) {
      for (const lineId of src.solIds) tier = Math.min(tier, batchByLine.get(lineId) ?? 0);
    }
    return tier;
  };
  const tiers = numbered.map((products) => products.map(tierOf));
  const tierOrder = [...new Set(tiers.flat())].sort((a, b) => a - b);

  let n = 0;
  const noByLine = new Map<string, number>();
  for (const tier of tierOrder) {
    numbered.forEach((products, w) => {
      products.forEach((p, i) => {
        if (tiers[w]![i] !== tier) return;
        n += 1;
        for (const src of p.poSources) for (const lineId of src.solIds) noByLine.set(lineId, n);
      });
    });
  }
  return noByLine;
}

// Freezes the # every order showed before 0170 stored it — the numbers already
// on labels — and numbers any line an older instance wrote since. Runs at boot
// before the server takes requests; idempotent, and a failure stops the boot
// rather than serve half-numbered orders.
export async function freezeLegacySellNumbers(sql: postgres.Sql): Promise<number> {
  const orders = await sql<{ sell_order_id: string }[]>`
    SELECT DISTINCT sell_order_id FROM sell_order_lines WHERE product_no IS NULL ORDER BY sell_order_id`;
  for (const { sell_order_id: id } of orders) {
    await sql.begin(async (tx) => {
      await tx`SELECT 1 FROM sell_orders WHERE id = ${id} FOR UPDATE`;
      const rows = await sheetRows(tx, id);
      if (rows.length === 0 || rows.some((r) => r.product_no != null)) {
        await assignSellProductNos(tx, id);
        return;
      }
      const noByLine = legacyNumbers(rows);
      const top = Math.max(0, ...noByLine.values());
      await writeNumbers(tx, id, noByLine, top + 1);
    });
  }
  return orders.length;
}
