// The two spreadsheets a sell order produces, sharing one row order:
//
//   buildPriceTemplateWorkbook — the vendor BID SHEET, emailed out and filled
//     in by the vendor, one tab per category.
//   buildPackingListWorkbook  — the internal PACKING CHECKLIST, one tab per
//     warehouse, never sent to a vendor.
//   buildPackingListByPoWorkbook — the same checklist cut one tab per PO per
//     warehouse, for a picker who pulls stock by the PO it arrived on. Each
//     tab is a warehouse tab in miniature (user-requested 2026-09-30: "follow
//     the same pattern as the main page"), so it shares that renderer.
//
// They shipped as one file until 2026-09-07, which meant every bid request
// carried the warehouse's picking list with it. Splitting them is why the
// row order lives in one place: a picker and a bidder must still find a
// product in the same position on their own sheet.
//
// Built directly with exceljs rather than lib/xlsx.ts — the flat sheet builder
// there has no notion of merged instruction rows, per-cell styling, or
// formulas.
//
// One worksheet per category present (RAM / SSD / HDD / Other, user-requested
// 2026-07-22: "the SSD should be in a dedicated sub sheet"), each carrying
// only that category's spec columns. The import parser reads prices from
// EVERY sheet, so a vendor filling several tabs round-trips fine.
//
// Bid-sheet photos ship as clickable Image URL cells, not embedded thumbnails
// (user-requested 2026-07-22): links keep the file small and always show the
// full-size scan. The packing tabs carry no photo at all: an embedded
// thumbnail per row was tried and dropped (user-decided 2026-10-07, "not
// required in the spreadsheet") — Pack mode shows it on screen instead. Spec
// attributes get individual columns (same request as the order spreadsheet —
// never re-merge them into one composed field).
//
// The workbook ships completely unprotected (user-decided 2026-08-08): a
// manager reshaping a long bid sheet shouldn't have to lift a lock first, and
// the protection was never security anyway — it carried no password. Nothing
// downstream depends on the shape it used to hold: the import parser
// re-locates columns by header text and matches rows by part number, so a
// vendor who reorders, retypes or inserts still round-trips (see
// services/sellOrderPriceImport.ts; safe here because no spec header matches
// its part/price/condition heuristics: "chip#" and "note备注" contain none of
// partnumber/price/单价/condition/成色 etc.).
//
// The RAM sections read the way the desk's own sheet does (user-requested
// 2026-09-06, from a screenshot of that sheet): two merged label columns to
// the LEFT of the data group the rows by device — "Desktop & laptop" /
// "Server" — and then by DDR generation, and the rows are ordered that way
// before the usual brand/capacity/speed order kicks in. Each label column
// carries its own light palette and the rows a paler wash of their generation
// (user-requested 2026-09-07): the merges alone left the tab reading as one
// undifferentiated block. Two things follow from merged cells that a reader
// may trip on: the bid tab's autofilter starts at "#", not column A, because
// Excel refuses to sort a range holding unequal merges; and a dropdown sort
// reorders the data columns while the labels stay put. The Gen / Type spec
// columns therefore stay on the tab — they are what filtering actually works
// on.
//
// The PACKING-CHECKLIST tabs (one per warehouse on the order, named by its
// short code) are stacked per-category sections with a tickable "Packed ✓"
// column, quantities and subtotals but deliberately NO prices: a picker has no
// use for them, and their absence is also what keeps the import parser out.
// These tabs carry "Part #" but no price-matching header, and findHeaders()
// requires BOTH, so uploading this workbook to the price import is rejected
// outright rather than silently matching nothing. Never add a header
// containing price/unitprice/单价/价格 here.

import { compareSpecValue, sortSheetRows } from './categoryColumns';

export type PriceTemplateProduct = {
  category: string;
  label: string;
  partNumber: string | null;
  condition: string | null;
  qty: number;
  imageUrl: string | null;
  // Keyed by SPEC_COLS_BY_CATEGORY keys; absent/blank for manual lines.
  specs: Record<string, string | number>;
  // Where the row's units came from, one entry per PO line it folds. Only the
  // packing tabs read it, giving each entry a tickable row of its own.
  poSources?: PoSource[];
};

// One PO line's share of a row. `lineNo` is the line's # on its PO page
// (lib/poLineNo.ts); `po` and `lineNo` are both null for a line typed onto
// the order by hand. `soLineNos` are the sell-order lines it covers — the #
// the packer writes on each item's label.
export type PoSource = { po: string | null; lineNo: number | null; qty: number; soLineNos: number[] };

export type PriceTemplateHead = {
  id: string;
  customerName: string;
  currencyCode: string;
};

// One packing-checklist tab's worth of products, already aggregated per
// (part|label|condition) WITHIN this warehouse by the route.
export type PriceTemplateWarehouse = {
  warehouse: string;
  products: PriceTemplateProduct[];
};

// One warehouse's lines cut per source PO. `po` is null for lines typed onto
// the order by hand — they came from no PO.
export type PackingPoWarehouse = {
  warehouse: string;
  pos: { po: string | null; products: PriceTemplateProduct[] }[];
};

type SpecCol = { header: string; key: string; width: number };

// Same vocabulary as the order spreadsheet's category tabs. Shared columns
// (Brand, Capacity, Interface…) dedupe by key when categories mix.
const SPEC_COLS_BY_CATEGORY: Record<string, SpecCol[]> = {
  RAM: [
    { header: 'Brand',       key: 'brand',          width: 14 },
    { header: 'Capacity',    key: 'capacity',       width: 10 },
    { header: 'Gen',         key: 'generation',     width: 8 },
    { header: 'Type',        key: 'type',           width: 10 },
    { header: 'Class',       key: 'classification', width: 10 },
    { header: 'Rank',        key: 'rank',           width: 8 },
    { header: 'Speed',       key: 'speed',          width: 10 },
    { header: 'Chip #',      key: 'chip',           width: 16 },
  ],
  SSD: [
    { header: 'Brand',       key: 'brand',          width: 14 },
    { header: 'Capacity',    key: 'capacity',       width: 10 },
    { header: 'Interface',   key: 'interface',      width: 12 },
    { header: 'Form factor', key: 'formFactor',     width: 12 },
    { header: 'Health %',    key: 'health',         width: 10 },
  ],
  HDD: [
    { header: 'Brand',       key: 'brand',          width: 14 },
    { header: 'Capacity',    key: 'capacity',       width: 10 },
    { header: 'Interface',   key: 'interface',      width: 12 },
    { header: 'Form factor', key: 'formFactor',     width: 12 },
    { header: 'RPM',         key: 'rpm',            width: 8 },
    { header: 'Health %',    key: 'health',         width: 10 },
  ],
  Other: [],
};

const HEADER_ROW = 5;

const BAND_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } } as const;
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } } as const;
const PRICE_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7C2' } } as const;

const tintFill = (argb: string) =>
  ({ type: 'pattern', pattern: 'solid', fgColor: { argb } }) as const;

// Group tints. The two label columns get separate palettes so a reader tells
// the device split from the generation split without reading either; the rows
// take a much paler wash of their generation, which bands a group across the
// sheet while leaving its label cell darker than the rows it heads.
//
// Anything outside these tables — a generation string the desk invented, or
// the trailing "—" bucket — falls to the neutrals rather than going untinted,
// so an unrecognised value still reads as a group.
const DEVICE_TINTS: Record<string, string> = {
  'Desktop & laptop': 'FFD6E4F7',
  Server: 'FFD8ECD9',
};
const GEN_TINTS: Record<string, string> = {
  DDR2: 'FFF6DCE8',
  DDR3: 'FFFBE3C4',
  DDR4: 'FFCFE9EC',
  DDR5: 'FFE2D8F3',
};
const ROW_TINTS: Record<string, string> = {
  DDR2: 'FFFCF1F5',
  DDR3: 'FFFDF4E8',
  DDR4: 'FFEDF7F8',
  DDR5: 'FFF3EFFA',
};
const NEUTRAL_TINT = 'FFE6E7EA';
const NEUTRAL_ROW_TINT = 'FFF6F7F8';

const CATEGORY_ORDER = ['RAM', 'SSD', 'HDD', 'Other'] as const;

// Row order lives in lib/categoryColumns so the inventory export ships the same
// sequence — brand, then capacity, speed — and the two can't drift apart.
function sortForSheet(products: PriceTemplateProduct[]): PriceTemplateProduct[] {
  return sortSheetRows(products, (p) => ({ specs: p.specs, label: p.label }));
}

// ── RAM grouping ─────────────────────────────────────────────────────────────

// Outer group follows the desk's sheet, which lumps desktop and laptop
// modules. `order_lines.type` is free text, so anything that isn't one of
// these values lands in a trailing "—" bucket rather than vanishing.
const DEVICE_GROUPS: readonly { label: string; types: readonly string[] }[] = [
  { label: 'Desktop & laptop', types: ['Desktop', 'Laptop'] },
  { label: 'Server', types: ['Server'] },
];
const BLANK_LABEL = '—';

const deviceRank = (type: string): number => {
  const i = DEVICE_GROUPS.findIndex((g) => g.types.includes(type));
  return i === -1 ? DEVICE_GROUPS.length : i;
};
const deviceLabel = (type: string): string =>
  DEVICE_GROUPS[deviceRank(type)]?.label ?? BLANK_LABEL;
// Desktop ahead of laptop inside the shared group.
const typeRank = (type: string): number => {
  const i = DEVICE_GROUPS.flatMap((g) => g.types).indexOf(type);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
};

type GroupCol = {
  key: string;
  width: number;
  label: (v: string) => string;
  tint: (v: string) => string;
};

// Left-to-right: outer label, then generation. Header cells stay blank.
const RAM_GROUP_COLS: readonly GroupCol[] = [
  {
    key: 'type', width: 18, label: deviceLabel,
    tint: (v) => DEVICE_TINTS[deviceLabel(v)] ?? NEUTRAL_TINT,
  },
  {
    key: 'generation', width: 9, label: (v) => v || BLANK_LABEL,
    tint: (v) => GEN_TINTS[v] ?? NEUTRAL_TINT,
  },
];

// The wash a data row gets under the group it belongs to.
const rowTint = (p: PriceTemplateProduct): string =>
  ROW_TINTS[String(p.specs.generation ?? '')] ?? NEUTRAL_ROW_TINT;

const spec = (p: PriceTemplateProduct, key: string): string => String(p.specs[key] ?? '');

// Device group, DDR generation (numeric, blanks last — DDR3 < DDR4 < DDR5),
// desktop before laptop, then the shared brand/capacity/speed order. Bid tab
// and packing tabs both use this so a product sits in the same place on each.
function sortRamForSheet(products: PriceTemplateProduct[]): PriceTemplateProduct[] {
  return sortForSheet(products).sort((a, b) => {
    const d = deviceRank(spec(a, 'type')) - deviceRank(spec(b, 'type'));
    if (d !== 0) return d;
    const g = compareSpecValue(spec(a, 'generation'), spec(b, 'generation'));
    if (g !== 0) return g;
    return typeRank(spec(a, 'type')) - typeRank(spec(b, 'type'));
  });
}

function sortCategoryForSheet(category: string, products: PriceTemplateProduct[]): PriceTemplateProduct[] {
  return category === 'RAM' ? sortRamForSheet(products) : sortForSheet(products);
}

// Merge each run of rows that share a label into one centred cell, tinted from
// its own column's palette. A run is keyed on the label PREFIX (outer label +
// this column), so two DDR4 runs under different device groups stay two cells.
//
// Styling only the merge master is enough: exceljs hands every slave cell the
// master's style object by reference, and Excel renders a merged range from
// its top-left cell regardless.
function renderGroupLabels(
  ws: import('exceljs').Worksheet,
  groupCols: readonly GroupCol[],
  sorted: PriceTemplateProduct[],
  firstRow: number,
  // Rows each product takes: one on a bid tab; on a pack tab a product split
  // by PO line takes its own row plus one per line, all under its label.
  spans?: readonly number[],
): void {
  const thin = { style: 'thin' } as const;
  const starts: number[] = [];
  let at = firstRow;
  sorted.forEach((_, i) => {
    starts.push(at);
    at += spans?.[i] ?? 1;
  });
  groupCols.forEach((col, g) => {
    const prefix = (p: PriceTemplateProduct) =>
      groupCols.slice(0, g + 1).map((c) => c.label(spec(p, c.key))).join(' ');
    let start = 0;
    while (start < sorted.length) {
      let end = start;
      while (end + 1 < sorted.length && prefix(sorted[end + 1]) === prefix(sorted[start])) end++;
      const top = starts[start];
      const bottom = starts[end] + (spans?.[end] ?? 1) - 1;
      if (bottom > top) ws.mergeCells(top, g + 1, bottom, g + 1);
      const cell = ws.getCell(top, g + 1);
      cell.value = col.label(spec(sorted[start], col.key));
      cell.font = { bold: true };
      cell.fill = tintFill(col.tint(spec(sorted[start], col.key)));
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { top: thin, bottom: thin, left: thin, right: thin };
      start = end + 1;
    }
  });
}

// Fold products into CATEGORY_ORDER buckets; unknown categories go to Other
// so nothing can fall off the workbook.
function groupByCategory(products: PriceTemplateProduct[]): Map<string, PriceTemplateProduct[]> {
  const byCategory = new Map<string, PriceTemplateProduct[]>();
  for (const p of products) {
    const cat = (CATEGORY_ORDER as readonly string[]).includes(p.category) ? p.category : 'Other';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(p);
  }
  return byCategory;
}

export async function buildPriceTemplateWorkbook(
  head: PriceTemplateHead,
  products: PriceTemplateProduct[],
): Promise<Buffer> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();

  // One tab per category present, named after it.
  const byCategory = groupByCategory(products);
  for (const cat of CATEGORY_ORDER) {
    const catProducts = byCategory.get(cat);
    if (!catProducts) continue;
    renderCategorySheet(wb, cat, head, catProducts);
  }
  // A workbook needs at least one sheet to be a valid file.
  if (byCategory.size === 0) renderCategorySheet(wb, 'Other', head, []);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// The picking side of the same order, one tab per warehouse. Separate file, not
// a separate tab: this one never goes to a vendor.
export async function buildPackingListWorkbook(
  head: PriceTemplateHead,
  warehouses: PriceTemplateWarehouse[],
): Promise<Buffer> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();

  const used = new Set<string>();
  for (const wh of warehouses) {
    renderWarehouseSheet(wb, head, wh, { tabName: packTabName(`Pack - ${wh.warehouse}`, used) });
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function buildPackingListByPoWorkbook(
  head: PriceTemplateHead,
  warehouses: PackingPoWarehouse[],
): Promise<Buffer> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();

  const used = new Set<string>();
  for (const wh of warehouses) {
    for (const { po, products } of wh.pos) {
      const poName = po ?? 'No PO';
      renderWarehouseSheet(wb, head, { warehouse: wh.warehouse, products }, {
        tabName: packTabName(`${poName} - ${wh.warehouse}`, used),
        poCol: 'id',
        instruction:
          `Packing checklist — ${poName}, warehouse ${wh.warehouse}. Tick "Packed ✓" as you pack. ` +
          `/ ${poName}，仓库 ${wh.warehouse} 装箱清单：装箱后请在 "Packed ✓" 列打勾。`,
        totalLabel: 'PO total',
      });
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Excel caps a tab name at 31 characters, refuses * ? : \ / [ ], and refuses
// an apostrophe at either end; exceljs throws on a duplicate
// (case-insensitively). Warehouse shorts aren't unique in the schema, so two
// "Pack - DEN" tabs are possible — the second gets a counter.
export function packTabName(raw: string, used: Set<string>): string {
  const base = raw.replace(/[*?:\\/[\]]/g, '-').slice(0, 31).replace(/^'+|'+$/g, '') || 'Pack';
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

function renderCategorySheet(
  wb: import('exceljs').Workbook,
  category: string,
  head: PriceTemplateHead,
  products: PriceTemplateProduct[],
): void {
  const ws = wb.addWorksheet(category, {
    views: [{ state: 'frozen', ySplit: HEADER_ROW }],
  });

  const cur = head.currencyCode;
  const currencyLabel = cur === 'CNY' ? '人民币 CNY' : 'USD';

  // The group labels sit left of "#" and the spec block between Item and Part
  // Number, so every column index depends on both counts.
  const groupCols = category === 'RAM' ? RAM_GROUP_COLS : [];
  const specCols = SPEC_COLS_BY_CATEGORY[category] ?? [];
  const g = groupCols.length;
  const IDX = {
    index: 1 + g,
    image: 2 + g,
    item: 3 + g,
    specStart: 4 + g,
    part: 4 + g + specCols.length,
    condition: 5 + g + specCols.length,
    qty: 6 + g + specCols.length,
    price: 7 + g + specCols.length,
    total: 8 + g + specCols.length,
    note: 9 + g + specCols.length,
  };

  ws.columns = [
    ...groupCols.map((c) => ({ width: c.width })),
    { width: 5 }, { width: 40 }, { width: 34 },
    ...specCols.map((c) => ({ width: c.width })),
    { width: 24 }, { width: 18 }, { width: 8 }, { width: 16 }, { width: 14 },
    { width: 28 },
  ];

  ws.mergeCells(1, 1, 1, IDX.note);
  const band = ws.getCell(1, 1);
  band.value = `Recycle Servers · Sell Order ${head.id} — ${head.customerName}`;
  band.fill = BAND_FILL;
  band.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  band.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 30;

  ws.mergeCells(2, 1, 2, IDX.note);
  const instr = ws.getCell(2, 1);
  // Always bilingual: the backend has no per-user i18n and CNY-order vendors
  // are typically Chinese-speaking.
  instr.value =
    `Fill the highlighted "Unit Price (${cur})" column, in ${currencyLabel}; remarks may go in the "Note / 备注" column. ` +
    `Do not edit other cells. / 请在高亮的 "Unit Price (${cur})" 列填写单价（${currencyLabel}），如有备注请填写在 "Note / 备注" 列，请勿修改其他内容。`;
  instr.font = { size: 11 };
  instr.alignment = { vertical: 'middle', wrapText: true };
  ws.getRow(2).height = 32;

  ws.getCell(3, 1).value = `Generated ${new Date().toISOString().slice(0, 10)}`;
  ws.getCell(3, 1).font = { size: 10, color: { argb: 'FF6B7280' } };

  const headers: [number, string][] = [
    [IDX.index, '#'], [IDX.image, 'Image URL'], [IDX.item, 'Item'],
    ...specCols.map((c, i): [number, string] => [IDX.specStart + i, c.header]),
    [IDX.part, 'Part Number'], [IDX.condition, 'Condition'], [IDX.qty, 'Qty'],
    [IDX.price, `Unit Price (${cur})`], [IDX.total, `Line Total (${cur})`],
    [IDX.note, 'Note / 备注'],
  ];
  const headerRow = ws.getRow(HEADER_ROW);
  for (const [col, text] of headers) {
    const cell = headerRow.getCell(col);
    cell.value = text;
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    cell.border = { bottom: { style: 'medium' } };
  }
  // Group-label header cells: styled as part of the band, deliberately no
  // text — a header there would be one more thing for the parser to read.
  for (let col = 1; col <= g; col++) {
    const cell = headerRow.getCell(col);
    cell.fill = HEADER_FILL;
    cell.border = { bottom: { style: 'medium' } };
  }

  const sorted = sortCategoryForSheet(category, products);
  sorted.forEach((p, i) => {
    const r = HEADER_ROW + 1 + i;
    const row = ws.getRow(r);
    // Wash the row under its group, per cell — assigning to row.fill would
    // stamp row.style, which the label cells created after this loop would
    // then inherit. Runs before the price cell's own fill so the yellow bid
    // column still wins: that fill is what tells a vendor where to type.
    if (g > 0) {
      const wash = tintFill(rowTint(p));
      for (let col = IDX.index; col <= IDX.note; col++) row.getCell(col).fill = wash;
    }
    row.getCell(IDX.index).value = i + 1;
    row.getCell(IDX.item).value = p.label;
    specCols.forEach((c, j) => {
      row.getCell(IDX.specStart + j).value = p.specs[c.key] ?? '';
    });
    row.getCell(IDX.part).value = p.partNumber ?? '';
    row.getCell(IDX.condition).value = p.condition ?? '';
    const qtyCell = row.getCell(IDX.qty);
    qtyCell.value = p.qty;
    qtyCell.numFmt = '#,##0';

    // Blank bid cell: existing order prices must not leak to the vendor. The
    // fill is what tells the vendor where to type — nothing else on the sheet
    // marks the column out.
    const priceCell = row.getCell(IDX.price);
    priceCell.numFmt = '#,##0.00';
    priceCell.fill = PRICE_FILL;

    const totalCell = row.getCell(IDX.total);
    const qtyRef = `${ws.getColumn(IDX.qty).letter}${r}`;
    const priceRef = `${ws.getColumn(IDX.price).letter}${r}`;
    totalCell.value = { formula: `${qtyRef}*${priceRef}` };
    totalCell.numFmt = '#,##0.00';

    row.alignment = { vertical: 'middle' };
    if (p.imageUrl) {
      const imageCell = row.getCell(IDX.image);
      imageCell.value = { text: p.imageUrl, hyperlink: p.imageUrl };
      imageCell.font = { color: { argb: 'FF2563EB' }, underline: true };
    }
  });

  renderGroupLabels(ws, groupCols, sorted, HEADER_ROW + 1);

  // Header-row filter dropdowns, spanning the header down to the last data row
  // so sorting from a dropdown carries every row with it. Starts at "#": the
  // merged label columns to its left would make Excel refuse the sort.
  ws.autoFilter = {
    from: { row: HEADER_ROW, column: IDX.index },
    to: { row: HEADER_ROW + sorted.length, column: IDX.note },
  };
}

// ── Warehouse packing-checklist tabs ─────────────────────────────────────────

type WhCol = { header: string; key: string; width: number; numFmt?: string };

// Specs a picker doesn't read off a shelf: they identify a part on a bid
// sheet, not in a box (user-decided 2026-08-09, same pass that dropped Item /
// Condition / Image URL here). The bid tabs still carry all of them.
const PACK_OMITTED_SPECS = new Set(['classification', 'chip']);

// Section layout: # | Packed ✓ | Part # | From PO or ID in PO | <category
// specs> | Qty, shifted right by PACK_GROUP_OFFSET to leave room for the RAM
// group labels. No prices by design (user-decided): a picker has no use
// for them, and "Part #" (not "Part Number") plus the absence of any price
// header is also what keeps findHeaders() from ever parsing these tabs. The
// source column names where a row's units came from: "From PO" ("PO-1442 #3")
// on a warehouse tab, whose rows mix POs; "ID in PO" (just the #) on a by-PO
// tab, where the tab already names the PO.
type PoCol = 'source' | 'id';

function whSectionCols(category: string, poCol: PoCol): WhCol[] {
  return [
    // The line's # on the sell order, which the packer labels the item with.
    { header: '#',         key: 'soLine',    width: 8 },
    { header: 'Packed ✓',  key: 'packed',    width: 9 },
    { header: 'Part #',    key: 'part',      width: 24 },
    poCol === 'id'
      ? { header: 'ID in PO', key: 'poLine',   width: 12 }
      : { header: 'From PO',  key: 'poSource', width: 18 },
    ...(SPEC_COLS_BY_CATEGORY[category] ?? []).filter((c) => !PACK_OMITTED_SPECS.has(c.key)),
    { header: 'Qty',       key: 'qty',       width: 8, numFmt: '#,##0' },
  ];
}

// A product's PO lines in the order a picker walks them: POs in numeric order
// (PO-999 before PO-1442), then line #, a hand-typed share last.
function sortSources(sources: readonly PoSource[]): PoSource[] {
  return [...sources].sort((a, b) => {
    if (!a.po || !b.po) return a.po ? -1 : b.po ? 1 : 0;
    return a.po.localeCompare(b.po, undefined, { numeric: true }) || a.lineNo! - b.lineNo!;
  });
}

// What a split product's own row says it spans: "2 POs", "1 PO" for two lines
// of one PO, "+ No PO" when part of it was typed in by hand.
function posSpanned(sources: readonly PoSource[]): string {
  const n = new Set(sources.flatMap((x) => (x.po ? [x.po] : []))).size;
  const pos = `${n} PO${n === 1 ? '' : 's'}`;
  return sources.some((x) => !x.po) ? `${pos} + No PO` : pos;
}

const numList = (nos: readonly number[]): number | string => {
  const sorted = [...nos].sort((a, b) => a - b);
  return sorted.length === 1 ? sorted[0] : sorted.join(', ');
};

// Every pack tab reserves the group-label columns, whether or not it holds a
// RAM section: two tabs on the same order then have the same layout, so a
// picker moving between warehouses doesn't have to re-find the columns.
const PACK_GROUP_OFFSET = RAM_GROUP_COLS.length;

function renderWarehouseSheet(
  wb: import('exceljs').Workbook,
  head: PriceTemplateHead,
  wh: PriceTemplateWarehouse,
  // The by-PO workbook reuses this tab whole; only its name and wording move,
  // and its source column narrows to ID in PO.
  opts: { tabName?: string; instruction?: string; totalLabel?: string; poCol?: PoCol } = {},
): void {
  const poCol = opts.poCol ?? 'source';
  // "Pack - DEN" style: the prefix separates packing tabs from the category
  // bid tabs at a glance and can never collide with RAM/SSD/HDD/Other.
  const ws = wb.addWorksheet(opts.tabName ?? `Pack - ${wh.warehouse}`);

  const byCategory = groupByCategory(wh.products);
  const sections = CATEGORY_ORDER.filter((cat) => byCategory.has(cat));

  // Shared per-index widths: the widest column wins across sections.
  const widths: number[] = [];
  for (const cat of sections) {
    whSectionCols(cat, poCol).forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, c.width);
    });
  }
  RAM_GROUP_COLS.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width;
  });
  widths.forEach((w, i) => {
    ws.getColumn(i + 1 + PACK_GROUP_OFFSET).width = w;
  });
  const bannerSpan = PACK_GROUP_OFFSET + Math.max(widths.length, 6);

  ws.mergeCells(1, 1, 1, bannerSpan);
  const band = ws.getCell(1, 1);
  band.value = `Recycle Servers · Sell Order ${head.id} — ${head.customerName}`;
  band.fill = BAND_FILL;
  band.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  band.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 30;

  ws.mergeCells(2, 1, 2, bannerSpan);
  const instr = ws.getCell(2, 1);
  // Wording deliberately avoids price/价格 tokens: row 2 sits inside the
  // import parser's 15-row header scan, and this tab must never look like a
  // price sheet.
  instr.value = opts.instruction ??
    `Packing checklist — warehouse ${wh.warehouse}. Tick "Packed ✓" as you pack. ` +
    `/ 仓库 ${wh.warehouse} 装箱清单：装箱后请在 "Packed ✓" 列打勾。`;
  instr.font = { size: 11 };
  instr.alignment = { vertical: 'middle', wrapText: true };
  ws.getRow(2).height = 32;

  ws.getCell(3, 1).value = `Generated ${new Date().toISOString().slice(0, 10)}`;
  ws.getCell(3, 1).font = { size: 10, color: { argb: 'FF6B7280' } };

  const thin = { style: 'thin' } as const;
  const box = { top: thin, bottom: thin, left: thin, right: thin };
  let r = 5;
  let totalQty = 0;
  for (const cat of sections) {
    const cols = whSectionCols(cat, poCol);
    const qtyIdx = cols.findIndex((c) => c.key === 'qty') + 1 + PACK_GROUP_OFFSET;

    const title = ws.getRow(r++);
    title.getCell(1 + PACK_GROUP_OFFSET).value = cat;
    title.font = { bold: true };

    const header = ws.getRow(r++);
    cols.forEach((c, i) => {
      const cell = header.getCell(i + 1 + PACK_GROUP_OFFSET);
      cell.value = c.header;
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
      cell.border = { bottom: { style: 'medium' } };
    });

    let sectionQty = 0;
    // Same order as the bid tabs, so a picker walking the shelf and a manager
    // reading the bid see a product in the same place. Sorted once: the group
    // labels below merge runs of THIS array, so the two must not diverge.
    const sectionRows = sortCategoryForSheet(cat, byCategory.get(cat)!);
    const firstRow = r;
    const spans: number[] = [];
    for (const p of sectionRows) {
      // Wash under the group, tick box excluded — a tinted box reads as
      // already ticked once the sheet is printed.
      const wash = cat === 'RAM' ? tintFill(rowTint(p)) : null;
      const sources = sortSources(p.poSources ?? []);
      // From one PO line, a product is one row. From several, it is laid out
      // the way the inventory page lists a product's lots: the product on a
      // bold row of its own, then a row per PO line with its own #, tick box
      // and qty, so a picker pulling one part from three boxes ticks each box
      // (user-requested 2026-10-07).
      const block: { kind: 'single' | 'product' | 'line'; src: PoSource | null }[] = sources.length > 1
        ? [{ kind: 'product', src: null }, ...sources.map((src) => ({ kind: 'line' as const, src }))]
        : [{ kind: 'single', src: sources[0] ?? null }];
      for (const { kind, src } of block) {
        const row = ws.getRow(r++);
        const tickable = kind !== 'product';
        // Part # and the specs belong to the product; a line row only says
        // which PO line it is.
        const productCells = kind !== 'line';
        cols.forEach((c, i) => {
          const cell = row.getCell(i + 1 + PACK_GROUP_OFFSET);
          if (wash && c.key !== 'packed') cell.fill = wash;
          switch (c.key) {
            case 'soLine':
              // Centred, so a lone # and a folded "2, 5" line up.
              if (tickable) cell.value = numList(src?.soLineNos ?? []);
              cell.alignment = { horizontal: 'center' };
              break;
            case 'packed':
              // Blank bordered tick box — pen after printing, or type x in Excel.
              if (tickable) cell.border = box;
              break;
            case 'part': if (productCells) cell.value = p.partNumber ?? ''; break;
            case 'poLine':
              cell.value = kind === 'product' ? `${sources.length} lines` : src?.lineNo ?? '';
              cell.alignment = { horizontal: 'center' };
              break;
            case 'poSource':
              if (kind === 'product') cell.value = posSpanned(sources);
              else if (src?.po) cell.value = `${src.po} #${src.lineNo}`;
              else if (src) cell.value = kind === 'line' ? 'No PO' : '—';
              if (kind === 'line') cell.alignment = { indent: 1 };
              break;
            case 'qty':
              cell.value = kind === 'line' ? src!.qty : p.qty;
              cell.numFmt = c.numFmt!;
              break;
            default: if (productCells) cell.value = p.specs[c.key] ?? '';
          }
          if (kind === 'product' && (c.key === 'part' || c.key === 'qty')) cell.font = { bold: true };
        });
      }
      spans.push(block.length);
      sectionQty += p.qty;
    }
    // Spans are merged across sectionRows only, so they stop at the section's
    // last row and can never reach the subtotal below it.
    if (cat === 'RAM') renderGroupLabels(ws, RAM_GROUP_COLS, sectionRows, firstRow, spans);
    totalQty += sectionQty;

    const subtotal = ws.getRow(r++);
    subtotal.getCell(1 + PACK_GROUP_OFFSET).value = 'Subtotal';
    subtotal.getCell(qtyIdx).value = sectionQty;
    subtotal.getCell(qtyIdx).numFmt = '#,##0';
    subtotal.font = { bold: true };

    r++; // blank spacer between sections
  }

  const total = ws.getRow(r);
  // The figure sits two columns along, so the label can run across the empty
  // tick-box cell instead of being cut off at the narrow # column.
  total.getCell(1 + PACK_GROUP_OFFSET).value = opts.totalLabel ?? 'Warehouse total';
  total.getCell(3 + PACK_GROUP_OFFSET).value = totalQty;
  total.getCell(3 + PACK_GROUP_OFFSET).numFmt = '#,##0';
  total.font = { bold: true };
}
