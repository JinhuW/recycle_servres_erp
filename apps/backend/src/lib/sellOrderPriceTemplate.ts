// Vendor bid sheet for one sell order: a styled workbook the manager emails
// out and the vendor fills in. Built directly with exceljs rather than
// lib/xlsx.ts — the flat sheet builder there has no notion of merged
// instruction rows, per-cell styling, or formulas.
//
// One worksheet per category present (RAM / SSD / HDD / Other, user-requested
// 2026-07-22: "the SSD should be in a dedicated sub sheet"), each carrying
// only that category's spec columns. The import parser reads prices from
// EVERY sheet, so a vendor filling several tabs round-trips fine.
//
// Photos ship as clickable Image URL cells, not embedded thumbnails
// (user-requested 2026-07-22): links keep the file small and always show the
// full-size scan. Spec attributes get individual columns (same request as the
// order spreadsheet — never re-merge them into one composed field).
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
// After the category tabs come per-warehouse PACKING-CHECKLIST tabs (one per
// warehouse on the order, named by its short code): stacked per-category
// sections with a tickable "Packed ✓" column, quantities and subtotals but
// deliberately NO prices — the same file goes to the vendor with blank bids.
// Parser safety: these tabs carry "Part #" but no price-matching header, and
// findHeaders() requires BOTH, so the import skips them. Never add a header
// containing price/unitprice/单价/价格 here.

export type PriceTemplateProduct = {
  category: string;
  label: string;
  partNumber: string | null;
  condition: string | null;
  qty: number;
  imageUrl: string | null;
  // Keyed by SPEC_COLS_BY_CATEGORY keys; absent/blank for manual lines.
  specs: Record<string, string | number>;
};

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

const CATEGORY_ORDER = ['RAM', 'SSD', 'HDD', 'Other'] as const;

// Rows ship pre-sorted the way the desk reads a bid sheet (user-decided
// 2026-08-06): capacity, then rank, speed, brand. Categories without those
// specs just fall through to the label tie-break.
const DEFAULT_SORT_KEYS = ['capacity', 'rank', 'speed', 'brand'] as const;

// Numeric collation, same rule as the vendor catalog chips: it keeps 8GB below
// 16GB and 3200 below 12800, which a plain lexical sort gets backwards. Blanks
// sink so manual lines (no specs at all) never head the tab.
function compareSpec(a: string, b: string): number {
  if (!a) return b ? 1 : 0;
  if (!b) return -1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// Label breaks ties so the same order always exports byte-identically.
function sortForSheet(products: PriceTemplateProduct[]): PriceTemplateProduct[] {
  return [...products].sort((x, y) => {
    for (const key of DEFAULT_SORT_KEYS) {
      const d = compareSpec(String(x.specs[key] ?? ''), String(y.specs[key] ?? ''));
      if (d !== 0) return d;
    }
    return compareSpec(x.label, y.label);
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
  warehouses: PriceTemplateWarehouse[] = [],
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

  for (const wh of warehouses) {
    renderWarehouseSheet(wb, head, wh);
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
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

  // The spec block sits between Item and Part Number, so every later column
  // index depends on the category's spec-column count.
  const specCols = SPEC_COLS_BY_CATEGORY[category] ?? [];
  const IDX = {
    index: 1,
    image: 2,
    item: 3,
    specStart: 4,
    part: 4 + specCols.length,
    condition: 5 + specCols.length,
    qty: 6 + specCols.length,
    price: 7 + specCols.length,
    total: 8 + specCols.length,
    note: 9 + specCols.length,
  };

  ws.columns = [
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

  const sorted = sortForSheet(products);
  sorted.forEach((p, i) => {
    const r = HEADER_ROW + 1 + i;
    const row = ws.getRow(r);
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

  // Header-row filter dropdowns, spanning the header down to the last data row
  // so sorting from a dropdown carries every row with it.
  ws.autoFilter = {
    from: { row: HEADER_ROW, column: 1 },
    to: { row: HEADER_ROW + sorted.length, column: IDX.note },
  };
}

// ── Warehouse packing-checklist tabs ─────────────────────────────────────────

type WhCol = { header: string; key: string; width: number; numFmt?: string };

// Specs a picker doesn't read off a shelf: they identify a part on a bid
// sheet, not in a box (user-decided 2026-08-09, same pass that dropped Item /
// Condition / Image URL here). The bid tabs still carry all of them.
const PACK_OMITTED_SPECS = new Set(['classification', 'chip']);

// Section layout: Packed ✓ | Part # | <category specs> | Qty. No prices by
// design (user-decided): the file doubles as the vendor bid sheet. "Part #"
// (not "Part Number") plus the absence of any price header keeps
// findHeaders() from ever parsing these tabs.
function whSectionCols(category: string): WhCol[] {
  return [
    { header: 'Packed ✓',  key: 'packed',    width: 9 },
    { header: 'Part #',    key: 'part',      width: 24 },
    ...(SPEC_COLS_BY_CATEGORY[category] ?? []).filter((c) => !PACK_OMITTED_SPECS.has(c.key)),
    { header: 'Qty',       key: 'qty',       width: 8, numFmt: '#,##0' },
  ];
}

function renderWarehouseSheet(
  wb: import('exceljs').Workbook,
  head: PriceTemplateHead,
  wh: PriceTemplateWarehouse,
): void {
  // "Pack - DEN" style: the prefix separates packing tabs from the category
  // bid tabs at a glance and can never collide with RAM/SSD/HDD/Other.
  const ws = wb.addWorksheet(`Pack - ${wh.warehouse}`);

  const byCategory = groupByCategory(wh.products);
  const sections = CATEGORY_ORDER.filter((cat) => byCategory.has(cat));

  // Shared per-index widths: the widest column wins across sections.
  const widths: number[] = [];
  for (const cat of sections) {
    whSectionCols(cat).forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, c.width);
    });
  }
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
  const bannerSpan = Math.max(widths.length, 6);

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
  instr.value =
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
    const cols = whSectionCols(cat);
    const qtyIdx = cols.findIndex((c) => c.key === 'qty') + 1;

    const title = ws.getRow(r++);
    title.getCell(1).value = cat;
    title.font = { bold: true };

    const header = ws.getRow(r++);
    cols.forEach((c, i) => {
      const cell = header.getCell(i + 1);
      cell.value = c.header;
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
      cell.border = { bottom: { style: 'medium' } };
    });

    let sectionQty = 0;
    // Same order as the bid tabs, so a picker walking the shelf and a manager
    // reading the bid see a product in the same place.
    for (const p of sortForSheet(byCategory.get(cat)!)) {
      const row = ws.getRow(r++);
      cols.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        switch (c.key) {
          case 'packed':
            // Blank bordered tick box — pen after printing, or type x in Excel.
            cell.border = box;
            break;
          case 'part': cell.value = p.partNumber ?? ''; break;
          case 'qty':
            cell.value = p.qty;
            cell.numFmt = c.numFmt!;
            break;
          default: cell.value = p.specs[c.key] ?? '';
        }
      });
      sectionQty += p.qty;
    }
    totalQty += sectionQty;

    const subtotal = ws.getRow(r++);
    subtotal.getCell(1).value = 'Subtotal';
    subtotal.getCell(qtyIdx).value = sectionQty;
    subtotal.getCell(qtyIdx).numFmt = '#,##0';
    subtotal.font = { bold: true };

    r++; // blank spacer between sections
  }

  const total = ws.getRow(r);
  total.getCell(1).value = 'Warehouse total';
  total.getCell(2).value = totalQty;
  total.getCell(2).numFmt = '#,##0';
  total.font = { bold: true };
}
