// Parses a vendor-filled price spreadsheet and matches its rows to a sell
// order's products by canonical part number. The file is untrusted: columns
// may be reordered, rows added or deleted, prices typed as strings with
// currency symbols. Nothing here relies on cell positions — columns are
// located by header text, rows are matched by part number.

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
  | 'ambiguous';

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

const PART_EXACT = new Set(['part', 'partno', 'pn', 'part#', '编号']);
const PART_CONTAINS = ['partnumber', '型号', '零件号', '料号'];
const isPartHeader = (h: string) =>
  PART_EXACT.has(h) || PART_CONTAINS.some(k => h.includes(k));

// "price" alone is not enough — "Line Total (USD)" must never win, so any
// total-ish header is excluded before the generic price check.
const isPriceHeader = (h: string) => {
  if (h.includes('total') || h.includes('总')) return false;
  return h.includes('unitprice') || h.includes('单价') || h.includes('price') || h.includes('价格');
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
    const cleaned = toAscii(raw)
      .replace(/usd|cny|rmb/gi, '')
      .replace(/[$¥￥,元\s]/g, '');
    if (cleaned === '') return { kind: 'empty' };
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { kind: 'invalid' };
    n = Number.parseFloat(cleaned);
  }
  if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) return { kind: 'invalid' };
  return { kind: 'ok', value: Math.round(n * 100) / 100 };
}

type HeaderHit = {
  ws: ExcelJS.Worksheet;
  headerRow: number;
  partCol: number;
  priceCol: number;
};

// Every sheet with a recognizable header participates — the bid template
// ships one tab per category, and a vendor may fill prices on several tabs.
// Columns are located per sheet, so tabs with different spec-column counts
// (and therefore different price-column positions) all parse correctly.
function findHeaders(wb: ExcelJS.Workbook): HeaderHit[] {
  const hits: HeaderHit[] = [];
  for (const ws of wb.worksheets) {
    const last = Math.min(ws.rowCount, HEADER_SCAN_ROWS);
    for (let r = 1; r <= last; r++) {
      const row = ws.getRow(r);
      let partCol: number | null = null;
      let priceCol: number | null = null;
      for (let c = 1; c <= row.cellCount; c++) {
        const h = normHeader(cellText(row.getCell(c).value));
        if (h === '') continue;
        if (partCol === null && isPartHeader(h)) partCol = c;
        else if (priceCol === null && isPriceHeader(h)) priceCol = c;
      }
      if (partCol !== null && priceCol !== null) {
        hits.push({ ws, headerRow: r, partCol, priceCol });
        break;
      }
    }
  }
  return hits;
}

export type SellOrderLineRow = {
  label: string;
  part_number: string | null;
  qty: number;
  unit_price: number | null;
  source_unit_price: number | null;
};

// The bid sheet's product (part|label): one price covers every line of a
// product across warehouses and conditions, so the vendor prices each part
// once. oldPrice is native — what the vendor's new price
// will be compared against.
export function groupOrderProducts(rows: SellOrderLineRow[], isCny: boolean): OrderProduct[] {
  const byKey = new Map<string, OrderProduct>();
  for (const row of rows) {
    const canon = row.part_number ? canonPartNumberJs(row.part_number) : '';
    const key = `${canon}|${row.label}`;
    const native = isCny ? (row.source_unit_price ?? row.unit_price) : row.unit_price;
    const existing = byKey.get(key);
    if (existing) {
      existing.qty += row.qty;
      existing.lineCount++;
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
  const hits = findHeaders(wb);
  if (hits.length === 0) throw new PriceColumnsNotFoundError();

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

  for (const { ws, headerRow, partCol, priceCol } of hits) {
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const rawPart = cellText(row.getCell(partCol).value).trim();
      if (rawPart === '') continue;

      const priceValue = row.getCell(priceCol).value;
      const price = parsePrice(priceValue);
      const parsed: ParsedPriceRow = {
        sheet: ws.name,
        rowNumber: r,
        rawPart,
        canonPart: canonPartNumberJs(rawPart),
        price: price.kind === 'ok' ? price.value : null,
        rawPrice: cellText(priceValue),
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
        } else if (price.kind === 'empty') {
          parsed.status = 'no-price';
        } else if (price.kind === 'invalid') {
          parsed.status = 'invalid-price';
        } else {
          parsed.status = 'matched';
          parsed.partNumber = target.product.partNumber;
          parsed.label = target.product.label;
          parsed.oldPrice = target.product.oldPrice;
          parsed.qty = target.product.qty;
          parsed.lineCount = target.product.lineCount;
          const prior = winnerByProduct.get(target.index);
          if (prior) prior.status = 'duplicate';
          winnerByProduct.set(target.index, parsed);
        }
      }
      rows.push(parsed);
    }
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
    else summary.ambiguous++;
  }

  return { rows, unmatchedProducts, manualProducts, summary };
}
