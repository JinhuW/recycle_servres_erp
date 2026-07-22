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
  condition: string | null;
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
  rowNumber: number;
  rawPart: string;
  canonPart: string;
  condition: string | null;
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

const COND_EXACT = new Set(['成色', '新旧']);
const isConditionHeader = (h: string) => COND_EXACT.has(h) || h.includes('condition');

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
  condCol: number | null;
};

function findHeader(wb: ExcelJS.Workbook): HeaderHit | null {
  for (const ws of wb.worksheets) {
    const last = Math.min(ws.rowCount, HEADER_SCAN_ROWS);
    for (let r = 1; r <= last; r++) {
      const row = ws.getRow(r);
      let partCol: number | null = null;
      let priceCol: number | null = null;
      let condCol: number | null = null;
      for (let c = 1; c <= row.cellCount; c++) {
        const h = normHeader(cellText(row.getCell(c).value));
        if (h === '') continue;
        if (partCol === null && isPartHeader(h)) partCol = c;
        else if (priceCol === null && isPriceHeader(h)) priceCol = c;
        else if (condCol === null && isConditionHeader(h)) condCol = c;
      }
      if (partCol !== null && priceCol !== null) {
        return { ws, headerRow: r, partCol, priceCol, condCol };
      }
    }
  }
  return null;
}

const normCondition = (s: string | null) =>
  (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export type SellOrderLineRow = {
  label: string;
  part_number: string | null;
  condition: string | null;
  qty: number;
  unit_price: number | null;
  source_unit_price: number | null;
};

// Same product key the edit form's setPrice uses (part|label|condition):
// one price covers every line of a product across warehouses, so the vendor
// prices each product once. oldPrice is native — what the vendor's new price
// will be compared against.
export function groupOrderProducts(rows: SellOrderLineRow[], isCny: boolean): OrderProduct[] {
  const byKey = new Map<string, OrderProduct>();
  for (const row of rows) {
    const canon = row.part_number ? canonPartNumberJs(row.part_number) : '';
    const key = `${canon}|${row.label}|${row.condition ?? ''}`;
    const native = isCny ? (row.source_unit_price ?? row.unit_price) : row.unit_price;
    const existing = byKey.get(key);
    if (existing) {
      existing.qty += row.qty;
      existing.lineCount++;
    } else {
      byKey.set(key, {
        partNumber: row.part_number,
        label: row.label,
        condition: row.condition,
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
  const hit = findHeader(wb);
  if (!hit) throw new PriceColumnsNotFoundError();
  const { ws, headerRow, partCol, priceCol, condCol } = hit;

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
  // the bottom of the sheet).
  const winnerByProduct = new Map<number, ParsedPriceRow>();

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const rawPart = cellText(row.getCell(partCol).value).trim();
    if (rawPart === '') continue;

    const priceValue = row.getCell(priceCol).value;
    const price = parsePrice(priceValue);
    const fileCondition = condCol ? cellText(row.getCell(condCol).value).trim() || null : null;
    const parsed: ParsedPriceRow = {
      rowNumber: r,
      rawPart,
      canonPart: canonPartNumberJs(rawPart),
      condition: fileCondition,
      price: price.kind === 'ok' ? price.value : null,
      rawPrice: cellText(priceValue),
      status: 'no-price',
    };

    const candidates = byCanon.get(parsed.canonPart);
    if (!candidates) {
      parsed.status = 'not-in-order';
    } else {
      let target: { product: OrderProduct; index: number } | null = null;
      if (candidates.length === 1) {
        target = candidates[0];
      } else {
        const matches = candidates.filter(
          c => normCondition(c.product.condition) === normCondition(fileCondition),
        );
        target = matches.length === 1 ? matches[0] : null;
      }
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
        parsed.condition = target.product.condition;
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
