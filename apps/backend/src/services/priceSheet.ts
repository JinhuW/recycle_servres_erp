// Reads a price spreadsheet's Part Number and Unit Price columns, wherever
// they sit. The file is untrusted: columns may be reordered, rows added or
// deleted, prices typed as strings with currency symbols. Nothing here relies
// on cell positions — columns are located by header text. The Market page's
// price import reads its lists through this.

import type ExcelJS from 'exceljs';
import { canonPartNumberJs } from '../lib/part-number';

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
};

type HeaderHit = Header & { ws: ExcelJS.Worksheet; headerRow: number };

// Every sheet with a recognizable header participates — our own bid sheet
// ships one tab per category, and a supplier's list may span several.
// Columns are located per sheet, so tabs with different spec-column counts
// (and therefore different price-column positions) all parse correctly.

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
  return { partCol: part.col, priceCol: price.col, priceHeader: price.text };
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
// the marks without a trace. The Market import reads dollars and yuan and
// refuses the rest.
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
};

export function readPriceSheetRows(wb: ExcelJS.Workbook): SheetPriceRow[] {
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
      });
    });
  }
  return rows;
}
