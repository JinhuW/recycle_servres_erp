// Parses a vendor-filled price spreadsheet and matches its rows to a sell
// order's products by canonical part number. The file is untrusted: columns
// may be reordered, rows added or deleted, prices typed as strings with
// currency symbols. Nothing here relies on cell positions — columns are
// located by header text, rows are matched by part number. The Market page's
// price import reads its sheets through the same readPriceSheetRows.

import type ExcelJS from 'exceljs';
import { canonPartNumberJs } from '../lib/part-number';

export type OrderProduct = {
  partNumber: string | null;
  label: string;
  qty: number;
  lineCount: number;
  oldPrice: number | null;
};

export type ParsedRowStatus =
  | 'matched'
  | 'not-in-order'
  | 'no-price'
  | 'invalid-price'
  | 'duplicate'
  | 'ambiguous'
  // A sheet from before v1.242.0 priced the part apart per condition.
  | 'per-condition';

export type ParsedPriceRow = {
  // Worksheet the row came from — the template ships one tab per category, so
  // (sheet, rowNumber) is a row's identity; rowNumber alone repeats per tab.
  sheet: string;
  rowNumber: number;
  rawPart: string;
  canonPart: string;
  price: number | null;
  rawPrice: string;
  status: ParsedRowStatus;
  partNumber?: string | null;
  label?: string;
  oldPrice?: number | null;
  qty?: number;
  lineCount?: number;
};

export type PriceImportPreview = {
  rows: ParsedPriceRow[];
  unmatchedProducts: OrderProduct[];
  manualProducts: OrderProduct[];
  summary: {
    matched: number;
    notInOrder: number;
    noPrice: number;
    invalid: number;
    duplicate: number;
    ambiguous: number;
  };
};

export class PriceColumnsNotFoundError extends Error {
  constructor() {
    super('could not locate Part Number and Unit Price columns');
    this.name = 'PriceColumnsNotFoundError';
  }
}

const HEADER_SCAN_ROWS = 15;
const MAX_PRICE = 10_000_000;

// Header text normalized to [a-z0-9一-鿿#] so "Unit Price (USD)",
// "unit_price" and "UnitPrice" all read the same.
const normHeader = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9一-鿿#]/g, '');

// How plainly a header names the column: 2 for the precise names, 1 for the
// loose ones, which only stand in when the row has nothing precise — "编号"
// is often just the row number beside a real "型号", and "List Price" or
// "Last Price" sits beside a real "Unit Price".
const PART_EXACT = new Set(['partno', 'pn', 'part#']);
const PART_CONTAINS = ['partnumber', '型号', '零件号', '料号'];
const partScore = (h: string) =>
  PART_EXACT.has(h) || PART_CONTAINS.some(k => h.includes(k)) ? 2
    : h === 'part' || h === '编号' ? 1
      : 0;

// "price" alone is not enough — "Line Total (USD)" or an extended "Ext.
// Price" (qty × unit) must never win, so those are excluded first.
const priceScore = (h: string) => {
  if (h.includes('total') || h.includes('总') || h.startsWith('ext')) return 0;
  if (h.includes('unitprice') || h.includes('单价')) return 2;
  return h.includes('price') || h.includes('价格') ? 1 : 0;
};

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map(rt => rt.text).join('');
    if ('formula' in v || 'sharedFormula' in v) {
      return cellText((v as { result?: ExcelJS.CellValue }).result ?? null);
    }
    if ('text' in v) return typeof v.text === 'string' ? v.text : cellText(v.text as ExcelJS.CellValue);
  }
  return '';
}

type ParsedPrice = { kind: 'empty' } | { kind: 'invalid' } | { kind: 'ok'; value: number };

// Fullwidth digits/punctuation → ASCII, so prices typed with a CJK IME parse.
const toAscii = (s: string) =>
  s
    .replace(/[０-９]/g, d => String(d.charCodeAt(0) - 0xff10))
    .replace(/．/g, '.')
    .replace(/，/g, ',');

// A comma groups thousands in "1,234.50" and is the decimal point in "12,50"
// or "1.234,50": whichever separator comes last, with one or two digits
// after it, is the decimal one. Anything else ("1,2345") is not a price.
function decimalPoint(s: string): string | null {
  const comma = s.lastIndexOf(',');
  if (comma === -1) return s;
  const dot = s.lastIndexOf('.');
  if (dot > comma) return s.replace(/,/g, '');
  const tail = s.slice(comma + 1);
  if (/^\d{1,2}$/.test(tail)) return `${s.slice(0, comma).replace(/[.,]/g, '')}.${tail}`;
  if (dot === -1 && /^\d{3}$/.test(tail)) return s.replace(/,/g, '');
  return null;
}

function parsePrice(v: ExcelJS.CellValue): ParsedPrice {
  if (v === null || v === undefined) return { kind: 'empty' };
  if (typeof v === 'object' && !(v instanceof Date) && ('formula' in v || 'sharedFormula' in v)) {
    return parsePrice((v as { result?: ExcelJS.CellValue }).result ?? null);
  }
  let n: number;
  if (typeof v === 'number') {
    n = v;
  } else {
    const raw = cellText(v);
    const stripped = toAscii(raw)
      .replace(/usd|cny|rmb/gi, '')
      .replace(/[$¥￥元\s]/g, '');
    if (stripped === '') return { kind: 'empty' };
    const cleaned = decimalPoint(stripped);
    if (cleaned === null || !/^-?\d+(\.\d+)?$/.test(cleaned)) return { kind: 'invalid' };
    n = Number.parseFloat(cleaned);
  }
  if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) return { kind: 'invalid' };
  return { kind: 'ok', value: Math.round(n * 100) / 100 };
}

type Header = {
  partCol: number;
  priceCol: number;
  priceHeader: string;
  // A pre-v1.242.0 bid sheet's Condition column, if the sheet has one.
  conditionCol: number | null;
};

type HeaderHit = Header & { ws: ExcelJS.Worksheet; headerRow: number };

// Every sheet with a recognizable header participates — the bid template
// ships one tab per category, and a vendor may fill prices on several tabs.
// Columns are located per sheet, so tabs with different spec-column counts
// (and therefore different price-column positions) all parse correctly.
const isConditionHeader = (h: string) => h === 'condition' || h.includes('成色');

/** The columns a row names when it is a header row; null for any other row. */
function headerIn(row: ExcelJS.Row): Header | null {
  const cells: { col: number; text: string; h: string }[] = [];
  row.eachCell((cell, col) => {
    // A merged title ("Part Number Price List") reads the same text in
    // every cell it spans; only its first cell is a header.
    if (cell.isMerged && cell.master !== cell) return;
    const text = cellText(cell.value);
    const h = normHeader(text);
    if (h !== '') cells.push({ col, text, h });
  });
  const best = (score: (h: string) => number, skip?: number) => {
    let pick: (typeof cells)[number] | null = null;
    let top = 0;
    for (const cell of cells) {
      const sc = cell.col === skip ? 0 : score(cell.h);
      if (sc > top) { pick = cell; top = sc; }
    }
    return pick;
  };
  const part = best(partScore);
  const price = part && best(priceScore, part.col);
  if (!part || !price) return null;
  const condition = cells.find(c => c.col !== part.col && c.col !== price.col && isConditionHeader(c.h));
  return { partCol: part.col, priceCol: price.col, priceHeader: price.text, conditionCol: condition?.col ?? null };
}

function findHeaders(wb: ExcelJS.Workbook): HeaderHit[] {
  const hits: HeaderHit[] = [];
  for (const ws of wb.worksheets) {
    // A hidden tab is the sender's scratch (old prices, a lookup list); it
    // must not outbid the visible one.
    if (ws.state !== 'visible') continue;
    const last = Math.min(ws.rowCount, HEADER_SCAN_ROWS);
    for (let r = 1; r <= last; r++) {
      const header = headerIn(ws.getRow(r));
      if (header) {
        hits.push({ ws, headerRow: r, ...header });
        break;
      }
    }
  }
  return hits;
}

// A currency a header, cell, number format or tab names — parsePrice strips
// the marks without a trace. Harmless on a bid sheet, whose order names the
// currency; the Market import reads dollars and yuan and refuses the rest.
// Dollars named outright win, or 美元 (US dollar) would read as its 元. A bare
// $ is dollars unless a letter (HK$, C$) or a [ — Excel's [$€-407] locale
// syntax in a number format — sits before it.
const USD_MARK = /(?<![a-z])usd(?![a-z])|us\$|美元|美金|(?<![a-z[])\$/i;
const CURRENCY_MARKS: readonly (readonly [RegExp, string])[] = [
  [/(?<![a-z])hkd(?![a-z])|hk\$|港元|港币/i, 'HKD'],
  [/(?<![a-z])eur(?![a-z])|€|欧元/i, 'EUR'],
  [/(?<![a-z])gbp(?![a-z])|£|英镑/i, 'GBP'],
  [/(?<![a-z])jpy(?![a-z])|日元/i, 'JPY'],
  // 元 is yuan on its own (单价（元）, 300元) but not inside a word: a parts
  // supplier's dollar sheet is as likely as not on a tab named 电子元器件.
  [/[¥￥]|(?<!单)元(?![一-鿿])|(?<![a-z])(?:cny|rmb)(?![a-z])|人民币/i, 'CNY'],
];

function currencyIn(text: string): string | null {
  if (!text) return null;
  if (USD_MARK.test(text)) return 'USD';
  for (const [mark, code] of CURRENCY_MARKS) if (mark.test(text)) return code;
  return null;
}

// One price-sheet row as read, before it is matched to anything: what its Part
// Number and Unit Price cells held, wherever those columns sit.
export type SheetPriceRow = {
  sheet: string;
  rowNumber: number;
  rawPart: string;
  canonPart: string;
  price: number | null;
  priceKind: ParsedPrice['kind'];
  rawPrice: string;
  /** The currency the row is marked in, or null when nothing names one. */
  currency: string | null;
  /** The row's Condition cell, read only when asked for and present. */
  condition?: string | null;
};

export function readPriceSheetRows(
  wb: ExcelJS.Workbook, opts: { condition?: boolean } = {},
): SheetPriceRow[] {
  const hits = findHeaders(wb);
  if (hits.length === 0) throw new PriceColumnsNotFoundError();

  const rows: SheetPriceRow[] = [];
  for (const { ws, headerRow, ...first } of hits) {
    let cols: Header = first;
    let listed = currencyIn(cols.priceHeader) ?? currencyIn(ws.name);
    // eachRow visits only rows that exist: walking 1..rowCount would build a
    // row object for every hole up to a stray cell at row 1,048,576.
    ws.eachRow((row, r) => {
      if (r <= headerRow) return;
      // A header further down starts a section laid out its own way.
      const again = headerIn(row);
      if (again) {
        cols = again;
        listed = currencyIn(cols.priceHeader) ?? currencyIn(ws.name);
        return;
      }
      const rawPart = cellText(row.getCell(cols.partCol).value).trim();
      if (rawPart === '') return;

      const cell = row.getCell(cols.priceCol);
      const price = parsePrice(cell.value);
      const rawPrice = cellText(cell.value);
      // The cell's own mark first, then its number format (a typed number
      // carries its currency only there), then the column's and the tab's.
      const currency = currencyIn(rawPrice) ?? currencyIn(cell.numFmt ?? '') ?? listed;
      rows.push({
        sheet: ws.name,
        rowNumber: r,
        rawPart,
        canonPart: canonPartNumberJs(rawPart),
        price: price.kind === 'ok' ? price.value : null,
        priceKind: price.kind,
        rawPrice,
        currency,
        ...(opts.condition
          ? { condition: cols.conditionCol ? cellText(row.getCell(cols.conditionCol).value).trim() || null : null }
          : {}),
      });
    });
  }
  return rows;
}

export type SellOrderLineRow = {
  label: string;
  part_number: string | null;
  qty: number;
  unit_price: number | null;
  source_unit_price: number | null;
};

// The bid sheet's product: one price covers every line of a part across
// warehouses, conditions and the labels its lines were added under, since the
// sheet prices a part once and the import applies a part's price to all of
// its lines. A line with no part number is its own product by label. oldPrice
// is native — what the vendor's new price will be compared against — and
// none when the part's lines were priced differently.
export function groupOrderProducts(rows: SellOrderLineRow[], isCny: boolean): OrderProduct[] {
  const byKey = new Map<string, OrderProduct>();
  for (const row of rows) {
    const canon = row.part_number ? canonPartNumberJs(row.part_number) : '';
    const key = canon ? `pn:${canon}` : `label:${row.label}`;
    const native = isCny ? (row.source_unit_price ?? row.unit_price) : row.unit_price;
    const existing = byKey.get(key);
    if (existing) {
      existing.qty += row.qty;
      existing.lineCount++;
      if (existing.oldPrice !== native) existing.oldPrice = null;
    } else {
      byKey.set(key, {
        partNumber: row.part_number,
        label: row.label,
        qty: row.qty,
        lineCount: 1,
        oldPrice: native,
      });
    }
  }
  return [...byKey.values()];
}

export function parsePriceWorkbook(
  wb: ExcelJS.Workbook,
  orderProducts: OrderProduct[],
): PriceImportPreview {
  const sheetRows = readPriceSheetRows(wb, { condition: true });

  const manualProducts: OrderProduct[] = [];
  const byCanon = new Map<string, { product: OrderProduct; index: number }[]>();
  orderProducts.forEach((product, index) => {
    const canon = product.partNumber ? canonPartNumberJs(product.partNumber) : '';
    if (canon === '') {
      manualProducts.push(product);
      return;
    }
    const list = byCanon.get(canon) ?? [];
    list.push({ product, index });
    byCanon.set(canon, list);
  });

  const rows: ParsedPriceRow[] = [];
  // One winner per product: a later valid price for the same product demotes
  // the earlier row to 'duplicate' (vendors often re-list corrected prices at
  // the bottom of the sheet). The map spans sheets, so re-pricing a part on
  // another tab demotes the first occurrence the same way.
  const winnerByProduct = new Map<number, ParsedPriceRow>();
  // A sheet made before v1.242.0 has a row per condition. Two of a part's
  // conditions at two prices are not a correction further down: one price
  // can't stand for both, so the part is left for the manager to price.
  const winnerCondition = new Map<number, string>();
  const perCondition = new Set<number>();
  const condKey = (c: string | null | undefined) => (c ?? '').trim().toLowerCase();

  // A bid row that folds several part numbers (a DDR5 spec row) lists them
  // comma-separated in one cell; its one price is each part's price, so the
  // cell reads as one row per part, all at the row's number.
  const partCells = sheetRows.flatMap((sheetRow) => {
    const parts = sheetRow.rawPart.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
    return parts.length > 1
      ? parts.map((rawPart) => ({ ...sheetRow, rawPart, canonPart: canonPartNumberJs(rawPart) }))
      : [sheetRow];
  });

  for (const sheetRow of partCells) {
    const parsed: ParsedPriceRow = {
      sheet: sheetRow.sheet,
      rowNumber: sheetRow.rowNumber,
      rawPart: sheetRow.rawPart,
      canonPart: sheetRow.canonPart,
      price: sheetRow.price,
      rawPrice: sheetRow.rawPrice,
      status: 'no-price',
    };

    const candidates = byCanon.get(parsed.canonPart);
    if (!candidates) {
      parsed.status = 'not-in-order';
    } else {
      // A part under two labels (a typed line re-worded) can't be told
      // apart by part number alone.
      const target = candidates.length === 1 ? candidates[0] : null;
      if (!target) {
        parsed.status = 'ambiguous';
      } else if (sheetRow.priceKind === 'empty' || sheetRow.price === 0) {
        // A 0 on a bid is "not bidding"; as a price it would also be recorded
        // as the part's market bid and zero its max buy.
        parsed.status = 'no-price';
      } else if (sheetRow.priceKind === 'invalid') {
        parsed.status = 'invalid-price';
      } else if (perCondition.has(target.index)) {
        parsed.status = 'per-condition';
      } else {
        const prior = winnerByProduct.get(target.index);
        const cond = condKey(sheetRow.condition);
        const priorCond = winnerCondition.get(target.index) ?? '';
        if (prior && cond && priorCond && cond !== priorCond && prior.price !== sheetRow.price) {
          prior.status = 'per-condition';
          parsed.status = 'per-condition';
          perCondition.add(target.index);
          winnerByProduct.delete(target.index);
        } else {
          parsed.status = 'matched';
          parsed.partNumber = target.product.partNumber;
          parsed.label = target.product.label;
          parsed.oldPrice = target.product.oldPrice;
          parsed.qty = target.product.qty;
          parsed.lineCount = target.product.lineCount;
          if (prior) prior.status = 'duplicate';
          winnerByProduct.set(target.index, parsed);
          winnerCondition.set(target.index, cond);
        }
      }
    }
    rows.push(parsed);
  }

  const unmatchedProducts = orderProducts.filter(
    (p, i) => !winnerByProduct.has(i) && !manualProducts.includes(p),
  );

  const summary = { matched: 0, notInOrder: 0, noPrice: 0, invalid: 0, duplicate: 0, ambiguous: 0 };
  for (const row of rows) {
    if (row.status === 'matched') summary.matched++;
    else if (row.status === 'not-in-order') summary.notInOrder++;
    else if (row.status === 'no-price') summary.noPrice++;
    else if (row.status === 'invalid-price') summary.invalid++;
    else if (row.status === 'duplicate') summary.duplicate++;
    // A part this file can't price on its own, like an ambiguous one.
    else summary.ambiguous++;
  }

  return { rows, unmatchedProducts, manualProducts, summary };
}
