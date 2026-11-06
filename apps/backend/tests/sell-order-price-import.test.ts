import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import ExcelJS from 'exceljs';
import {
  groupOrderProducts,
  matchPriceRows,
  type OrderProduct,
  type PriceImportPreview,
} from '../src/services/sellOrderPriceImport';
import { readPriceSheetRows, PriceColumnsNotFoundError } from '../src/services/priceSheet';
import app from '../src/index';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { signOffAll } from './helpers/fixtures';
import { canonPartNumberJs } from '../src/lib/part-number';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// What the preview route does with a sheet: read it, then match it.
const parsePriceWorkbook = (wb: ExcelJS.Workbook, products: OrderProduct[]): PriceImportPreview =>
  matchPriceRows(readPriceSheetRows(wb, { condition: true }), products);

// ---------------------------------------------------------------------------
// parsePriceWorkbook — pure parse + match, no DB / HTTP. The vendor file is
// hostile territory: columns move, rows get added, prices arrive as strings
// with currency symbols. Matching is by canonical part number, never by cell
// position.
// ---------------------------------------------------------------------------

const TEMPLATE_HEADERS = [
  '#', 'Photo', 'Item', 'Detail', 'Part Number', 'Condition', 'Qty',
  'Unit Price (USD)', 'Line Total (USD)',
];

function wbWith(rows: unknown[][], sheetName = 'Price Sheet'): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  for (const r of rows) ws.addRow(r);
  return wb;
}

function product(over: Partial<OrderProduct>): OrderProduct {
  return {
    partNumber: 'ABC123',
    label: 'RAM 16GB',
    qty: 4,
    lineCount: 1,
    oldPrice: null,
    ...over,
  };
}

describe('header detection', () => {
  it('reads the template layout: matches all rows, reports summary', () => {
    const wb = wbWith([
      ['Recycle Servers · Sell Order SL-1 — Acme'],
      ['Fill the Unit Price column.'],
      [],
      TEMPLATE_HEADERS,
      [1, null, 'RAM 16GB', null, 'ABC123', null, 4, 100, null],
      [2, null, 'SSD 1TB', null, 'XYZ-9', null, 2, 55.5, null],
    ]);
    const products = [
      product({ partNumber: 'ABC123', label: 'RAM 16GB', qty: 4, oldPrice: 90 }),
      product({ partNumber: 'XYZ-9', label: 'SSD 1TB', qty: 2, lineCount: 2 }),
    ];
    const res = parsePriceWorkbook(wb, products);
    expect(res.summary).toMatchObject({ matched: 2, notInOrder: 0, noPrice: 0 });
    const ram = res.rows.find(r => r.canonPart === 'ABC123');
    expect(ram).toMatchObject({ status: 'matched', price: 100, oldPrice: 90, label: 'RAM 16GB', qty: 4 });
    const ssd = res.rows.find(r => r.canonPart === 'XYZ9');
    expect(ssd).toMatchObject({ status: 'matched', price: 55.5, lineCount: 2 });
    expect(res.unmatchedProducts).toEqual([]);
    expect(res.manualProducts).toEqual([]);
  });

  it('survives shuffled columns and junk rows above the header', () => {
    const wb = wbWith([
      ['Quote from Vendor Co.'],
      ['prepared by Bob', null, 'call me'],
      ['Unit Price (USD)', 'Notes', 'Part Number', 'Qty'],
      [100, 'good stock', 'ABC123', 4],
    ]);
    const res = parsePriceWorkbook(wb, [product({})]);
    expect(res.rows[0]).toMatchObject({ status: 'matched', canonPart: 'ABC123', price: 100 });
  });

  it('skips header-less sheets and parses the ones with recognizable headers', () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Cover').addRow(['Hello']);
    const ws = wb.addWorksheet('Prices');
    ws.addRow(['Part Number', 'Unit Price (USD)']);
    ws.addRow(['ABC123', 42]);
    const res = parsePriceWorkbook(wb, [product({})]);
    expect(res.rows[0]).toMatchObject({ status: 'matched', price: 42, sheet: 'Prices' });
  });

  it('reads prices from every tab — the template ships one sheet per category', () => {
    const wb = new ExcelJS.Workbook();
    // Mimic the per-category template: different spec columns per tab, so the
    // price column sits at a different index on each sheet.
    const ram = wb.addWorksheet('RAM');
    ram.addRow(['Part Number', 'Speed', 'Chip #', 'Unit Price (USD)']);
    ram.addRow(['ABC123', 3200, 'K4A8G', 100]);
    const ssd = wb.addWorksheet('SSD');
    ssd.addRow(['Part Number', 'Interface', 'Unit Price (USD)']);
    ssd.addRow(['XYZ-9', 'SATA', 55.5]);
    const products = [
      product({ partNumber: 'ABC123', label: 'RAM 16GB' }),
      product({ partNumber: 'XYZ-9', label: 'SSD 1TB' }),
    ];
    const res = parsePriceWorkbook(wb, products);
    expect(res.summary.matched).toBe(2);
    expect(res.rows.find(r => r.canonPart === 'ABC123')).toMatchObject({ sheet: 'RAM', price: 100 });
    expect(res.rows.find(r => r.canonPart === 'XYZ9')).toMatchObject({ sheet: 'SSD', price: 55.5 });
    expect(res.unmatchedProducts).toEqual([]);
  });

  it('re-pricing a part on a later tab demotes the earlier tab row to duplicate', () => {
    const wb = new ExcelJS.Workbook();
    const a = wb.addWorksheet('RAM');
    a.addRow(['Part Number', 'Unit Price (USD)']);
    a.addRow(['ABC123', 10]);
    const b = wb.addWorksheet('Other');
    b.addRow(['Part Number', 'Unit Price (USD)']);
    b.addRow(['ABC123', 20]);
    const res = parsePriceWorkbook(wb, [product({})]);
    expect(res.rows.map(r => [r.sheet, r.status])).toEqual([['RAM', 'duplicate'], ['Other', 'matched']]);
    expect(res.rows[1].price).toBe(20);
  });

  it('accepts Chinese headers', () => {
    const wb = wbWith([
      ['型号', '数量', '单价'],
      ['ABC123', 4, 100],
    ]);
    const res = parsePriceWorkbook(wb, [product({})]);
    expect(res.rows[0]).toMatchObject({ status: 'matched', price: 100 });
  });

  it('never mistakes Line Total for the price column', () => {
    const wb = wbWith([
      ['Part Number', 'Line Total (USD)', 'Unit Price (USD)'],
      ['ABC123', 400, 100],
    ]);
    const res = parsePriceWorkbook(wb, [product({})]);
    expect(res.rows[0].price).toBe(100);
  });

  it('prefers Unit Price over another price column, and 型号 over a row-number 编号', () => {
    const list = parsePriceWorkbook(wbWith([
      ['Part Number', 'List Price', 'Ext. Price', 'Unit Price'],
      ['ABC123', 100, 400, 50],
    ]), [product({})]);
    expect(list.rows[0]).toMatchObject({ status: 'matched', price: 50 });
    const zh = parsePriceWorkbook(wbWith([
      ['编号', '品名', '型号', '数量', '单价'],
      [1, '内存', 'ABC123', 4, 40],
    ]), [product({})]);
    expect(zh.rows[0]).toMatchObject({ rawPart: 'ABC123', status: 'matched', price: 40 });
  });

  it('reads past a merged title that names both columns', () => {
    const wb = wbWith([
      ['Part Number Price List', null, null],
      ['Item', 'Part Number', 'Unit Price'],
      ['ram', 'ABC123', 10],
    ]);
    wb.worksheets[0]!.mergeCells('A1:C1');
    expect(parsePriceWorkbook(wb, [product({})]).rows).toMatchObject([{ rawPart: 'ABC123', price: 10 }]);
  });

  it('leaves out a hidden tab', () => {
    const wb = wbWith([['Part Number', 'Unit Price'], ['ABC123', 40]], 'Current');
    const old = wb.addWorksheet('old', { state: 'hidden' });
    old.addRow(['Part Number', 'Unit Price']);
    old.addRow(['ABC123', 95]);
    const res = parsePriceWorkbook(wb, [product({})]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ sheet: 'Current', price: 40, status: 'matched' });
  });

  it('reads only the rows a sheet has, however far down a stray cell sits', () => {
    const wb = wbWith([['Part Number', 'Unit Price'], ['ABC123', 40]]);
    wb.worksheets[0]!.getCell('C1048576').value = 'x';
    expect(parsePriceWorkbook(wb, [product({})]).rows).toHaveLength(1);
  });

  it('throws PriceColumnsNotFoundError when no header row exists', () => {
    const wb = wbWith([
      ['just', 'some', 'cells'],
      [1, 2, 3],
    ]);
    expect(() => parsePriceWorkbook(wb, [product({})])).toThrow(PriceColumnsNotFoundError);
  });
});

describe('part-number matching', () => {
  it('matches through P/N prefixes, whitespace, and case', () => {
    const wb = wbWith([
      ['Part Number', 'Unit Price (USD)'],
      ['P/N c-abc 123', 75],
    ]);
    const res = parsePriceWorkbook(wb, [product({ partNumber: 'C-ABC123' })]);
    expect(res.rows[0]).toMatchObject({ status: 'matched', canonPart: 'CABC123', price: 75 });
  });

  it('reads a cell listing several part numbers as one price for each', () => {
    const products = [product({ partNumber: 'D5-A', label: 'Samsung 32GB DDR5', qty: 3 }),
      product({ partNumber: 'D5-B', label: 'Samsung 32GB DDR5', qty: 2 }),
      product({ partNumber: 'D5-C', label: 'Samsung 32GB DDR5', qty: 1 })];
    const wb = wbWith([['Part Number', 'Unit Price (USD)'], ['D5-A, D5-B', 42], ['D5-C', 7]]);
    const r = parsePriceWorkbook(wb, products);
    expect(r.rows.map(x => [x.rowNumber, x.rawPart, x.status, x.price])).toEqual([
      [2, 'D5-A', 'matched', 42], [2, 'D5-B', 'matched', 42], [3, 'D5-C', 'matched', 7],
    ]);
    expect(r.summary.matched).toBe(3);
    expect(r.unmatchedProducts).toEqual([]);
  });

  it('flags parts that are not in the order', () => {
    const wb = wbWith([
      ['Part Number', 'Unit Price (USD)'],
      ['NOPE-1', 10],
    ]);
    const res = parsePriceWorkbook(wb, [product({})]);
    expect(res.rows[0].status).toBe('not-in-order');
    expect(res.summary.notInOrder).toBe(1);
  });

  it('last duplicate with a price wins; earlier occurrence flagged', () => {
    const wb = wbWith([
      ['Part Number', 'Unit Price (USD)'],
      ['ABC123', 10],
      ['ABC123', 20],
    ]);
    const res = parsePriceWorkbook(wb, [product({})]);
    expect(res.rows.map(r => r.status)).toEqual(['duplicate', 'matched']);
    expect(res.rows[1].price).toBe(20);
    expect(res.summary).toMatchObject({ matched: 1, duplicate: 1 });
  });

  it('prices a part once: an older sheet\'s Condition rows at one price read as one', () => {
    const wb = wbWith([
      ['Part Number', 'Condition', 'Unit Price (USD)'],
      ['ABC123', 'New', 100],
      ['ABC123', 'Used', 100],
    ]);
    const res = parsePriceWorkbook(wb, [product({ oldPrice: 90 })]);
    expect(res.rows.map(r => r.status)).toEqual(['duplicate', 'matched']);
    expect(res.rows[1]).toMatchObject({ price: 100, oldPrice: 90 });
    expect(res.rows[1]).not.toHaveProperty('condition');
  });

  it('leaves to the manager a part an older sheet priced apart per condition', () => {
    // Sent before v1.242.0 and returned after it: New and Used priced apart.
    const wb = wbWith([
      ['Part Number', 'Condition', 'Unit Price (USD)'],
      ['ABC123', 'New', 100],
      ['ABC123', 'Used', 60],
    ]);
    const res = parsePriceWorkbook(wb, [product({ oldPrice: 90 })]);
    expect(res.rows.map(r => r.status)).toEqual(['per-condition', 'per-condition']);
    expect(res.summary).toMatchObject({ matched: 0, ambiguous: 2 });
    expect(res.unmatchedProducts).toHaveLength(1);
  });

  it('reads a second section of a sheet by its own header', () => {
    const res = parsePriceWorkbook(wbWith([
      ['Part Number', 'Description', 'Unit Price'],
      ['ABC123', 'RAM', 40],
      [],
      ['Part Number', 'Unit Price', 'Qty Avail'],
      ['XYZ-9', 140, 250],
    ]), [product({}), product({ partNumber: 'XYZ-9', label: 'SSD' })]);
    expect(res.rows.map(r => [r.rawPart, r.price])).toEqual([['ABC123', 40], ['XYZ-9', 140]]);
  });

  it('folds one part in two conditions into one product', () => {
    const products = groupOrderProducts([
      { label: 'RAM 16GB', part_number: 'ABC-123', qty: 10, unit_price: 40, source_unit_price: null },
      { label: 'RAM 16GB', part_number: 'abc123', qty: 5, unit_price: 40, source_unit_price: null },
    ], false);
    expect(products).toEqual([
      { partNumber: 'ABC-123', label: 'RAM 16GB', qty: 15, lineCount: 2, oldPrice: 40 },
    ]);
  });

  it('folds one part under two line labels into one product, so its one sheet row prices both', () => {
    const products = groupOrderProducts([
      { label: 'a1b2c3d4', part_number: 'SR3B9', qty: 2, unit_price: 50, source_unit_price: null },
      { label: 'e5f6a7b8', part_number: 'SR3B9', qty: 3, unit_price: 45, source_unit_price: null },
      { label: 'Loose cable', part_number: null, qty: 1, unit_price: 5, source_unit_price: null },
    ], false);
    expect(products).toEqual([
      { partNumber: 'SR3B9', label: 'a1b2c3d4', qty: 5, lineCount: 2, oldPrice: null },
      { partNumber: null, label: 'Loose cable', qty: 1, lineCount: 1, oldPrice: 5 },
    ]);
    const res = parsePriceWorkbook(wbWith([['Part Number', 'Unit Price'], ['SR3B9', 60]]), products);
    expect(res.rows[0]).toMatchObject({ status: 'matched', price: 60, qty: 5, lineCount: 2 });
  });

  it('reports order products the file never priced', () => {
    const wb = wbWith([
      ['Part Number', 'Unit Price (USD)'],
      ['ABC123', 100],
    ]);
    const products = [
      product({}),
      product({ partNumber: 'MISSING-1', label: 'HDD 4TB' }),
      product({ partNumber: null, label: 'Mystery caddy' }),
    ];
    const res = parsePriceWorkbook(wb, products);
    expect(res.unmatchedProducts.map(p => p.partNumber)).toEqual(['MISSING-1']);
    expect(res.manualProducts.map(p => p.label)).toEqual(['Mystery caddy']);
  });
});

describe('cell reading', () => {
  it('parses currency strings, formula cells, and fullwidth digits', () => {
    const wb = wbWith([
      ['Part Number', 'Unit Price (USD)'],
      ['A1', '¥1,234.50'],
      ['A2', '$12'],
      ['A3', { formula: 'G2*2', result: 55 }],
      ['A4', '１２３４'],
    ]);
    const products = ['A1', 'A2', 'A3', 'A4'].map(pn => product({ partNumber: pn }));
    const res = parsePriceWorkbook(wb, products);
    expect(res.rows.map(r => r.price)).toEqual([1234.5, 12, 55, 1234]);
    expect(res.rows.every(r => r.status === 'matched')).toBe(true);
  });

  it('reads a decimal comma as the decimal point, and refuses a malformed grouping', () => {
    const res = parsePriceWorkbook(wbWith([
      ['Part Number', 'Unit Price'],
      ['A-1', '12,50'], ['A-2', '1.234,50'], ['A-3', '1,234'], ['A-4', '1,234.50'], ['A-5', '1,2345'],
    ]), ['A-1', 'A-2', 'A-3', 'A-4', 'A-5'].map(pn => product({ partNumber: pn, label: pn })));
    expect(res.rows.map(r => r.price)).toEqual([12.5, 1234.5, 1234, 1234.5, null]);
    expect(res.rows[4]).toMatchObject({ status: 'invalid-price' });
  });

  it('reads rich-text part numbers', () => {
    const wb = wbWith([
      ['Part Number', 'Unit Price (USD)'],
      [{ richText: [{ text: 'ABC' }, { text: '123' }] }, 100],
    ]);
    const res = parsePriceWorkbook(wb, [product({})]);
    expect(res.rows[0]).toMatchObject({ status: 'matched', canonPart: 'ABC123' });
  });

  it('reads a 0 as no bid, not as a price', () => {
    const res = parsePriceWorkbook(wbWith([['Part Number', 'Unit Price'], ['ABC123', 0], ['XYZ-9', '0']]),
      [product({}), product({ partNumber: 'XYZ-9', label: 'SSD' })]);
    expect(res.rows.map(r => r.status)).toEqual(['no-price', 'no-price']);
    expect(res.summary.matched).toBe(0);
  });

  it('flags empty and invalid prices without dropping the row', () => {
    const wb = wbWith([
      ['Part Number', 'Unit Price (USD)'],
      ['A1', null],
      ['A2', 'call me'],
      ['A3', -5],
    ]);
    const products = ['A1', 'A2', 'A3'].map(pn => product({ partNumber: pn }));
    const res = parsePriceWorkbook(wb, products);
    expect(res.rows.map(r => r.status)).toEqual(['no-price', 'invalid-price', 'invalid-price']);
    expect(res.summary).toMatchObject({ noPrice: 1, invalid: 2 });
  });

  it('skips spacer rows and vendor-added total rows with no part number', () => {
    const wb = wbWith([
      ['Part Number', 'Item', 'Unit Price (USD)'],
      ['ABC123', 'RAM', 100],
      [],
      [null, 'TOTAL', 100],
    ]);
    const res = parsePriceWorkbook(wb, [product({})]);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].status).toBe('matched');
  });
});

// ---------------------------------------------------------------------------
// POST /api/sell-orders/:id/price-import/preview — HTTP layer. Parses the
// uploaded workbook against the order's lines and returns a report. Never
// writes: the manager applies the preview through the normal edit-form save.
// ---------------------------------------------------------------------------

async function xlsxBlob(rows: unknown[][]): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Prices');
  for (const r of rows) ws.addRow(r);
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: XLSX_MIME });
}

async function createOrder(token: string, lines?: object[]): Promise<string> {
  const cust = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: {
      customerId: cust.body.items[0].id,
      lines: lines ?? [
        { category: 'RAM', label: 'DIMM A', partNumber: 'IMP-A1', qty: 2, unitPrice: 40, warehouseId: 'WH-LA1' },
        { category: 'SSD', label: 'Drive B', partNumber: 'IMP-B2', qty: 1, unitPrice: 90, warehouseId: 'WH-LA1' },
      ],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

describe('POST /api/sell-orders/:id/price-import/preview', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns a match report and leaves the order untouched', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);
    const file = await xlsxBlob([
      ['Part Number', 'Unit Price (USD)'],
      ['imp-a1', 55],
      ['IMP - B2', '$120'],
    ]);
    const res = await multipart(`/api/sell-orders/${id}/price-import/preview`, { file }, { token });
    expect(res.status).toBe(200);
    const body = res.body as PriceImportPreview & { currency: string };
    expect(body.currency).toBe('USD');
    expect(body.summary.matched).toBe(2);
    const first = body.rows.find(r => r.canonPart === 'IMPA1');
    expect(first).toMatchObject({ status: 'matched', price: 55, oldPrice: 40, qty: 2 });

    const detail = await api<{ order: { lines: { unitPrice: number }[] } }>(
      'GET', `/api/sell-orders/${id}`, { token });
    expect(detail.body.order.lines.map(l => l.unitPrice).sort()).toEqual([40, 90]);
  });

  it('round-trips the downloaded per-category template with prices filled on every tab', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);

    // Download the real bid template (one tab per category)...
    const dl = await app.fetch(
      new Request(`http://test/api/sell-orders/${id}/price-template`, {
        headers: { cookie: `at=${token}`, 'X-Requested-By': 'recycle-erp' },
      }),
      testEnv,
    );
    expect(dl.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await dl.arrayBuffer());
    // One tab per category, and nothing else — the packing checklist is its
    // own download now (GET /:id/packing-list).
    expect(wb.worksheets.map(w => w.name)).toEqual(['RAM', 'SSD']);

    // ...fill the Unit Price cell of every product row, vendor-style.
    for (const ws of wb.worksheets) {
      let headerRow = 0, partCol = 0, priceCol = 0;
      for (let r = 1; r <= ws.rowCount && !headerRow; r++) {
        ws.getRow(r).eachCell((cell, col) => {
          const v = String(cell.value ?? '');
          if (v === 'Part Number') { headerRow = r; partCol = col; }
          if (v.startsWith('Unit Price')) priceCol = col;
        });
      }
      if (!headerRow || !priceCol) continue;
      for (let r = headerRow + 1; r <= ws.rowCount; r++) {
        if (ws.getRow(r).getCell(partCol).value) {
          ws.getRow(r).getCell(priceCol).value = ws.name === 'RAM' ? 45 : 111;
        }
      }
    }
    const filled = new Blob([await wb.xlsx.writeBuffer()], { type: XLSX_MIME });

    // ...and every bid tab's price lands in the preview.
    const res = await multipart(`/api/sell-orders/${id}/price-import/preview`, { file: filled }, { token });
    expect(res.status).toBe(200);
    const body = res.body as PriceImportPreview;
    expect(body.summary.matched).toBe(2);
    expect(body.summary.duplicate).toBe(0);
    expect(body.rows.find(r => r.canonPart === 'IMPA1')).toMatchObject({ sheet: 'RAM', price: 45 });
    expect(body.rows.find(r => r.canonPart === 'IMPB2')).toMatchObject({ sheet: 'SSD', price: 111 });
    expect(body.rows.every(r => ['RAM', 'SSD'].includes(r.sheet))).toBe(true);
    expect(body.unmatchedProducts).toEqual([]);
  });

  it('groups multi-warehouse lines into one product with summed qty', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, [
      { category: 'RAM', label: 'DIMM A', partNumber: 'PN-DUP', qty: 2, unitPrice: 10, warehouseId: 'WH-LA1' },
      { category: 'RAM', label: 'DIMM A', partNumber: 'PN-DUP', qty: 3, unitPrice: 10, warehouseId: 'WH-NJ2' },
    ]);
    const file = await xlsxBlob([
      ['Part Number', 'Unit Price (USD)'],
      ['PN-DUP', 12],
    ]);
    const res = await multipart(`/api/sell-orders/${id}/price-import/preview`, { file }, { token });
    expect(res.status).toBe(200);
    const body = res.body as PriceImportPreview;
    expect(body.summary.matched).toBe(1);
    expect(body.rows[0]).toMatchObject({ qty: 5, lineCount: 2, price: 12 });
  });

  it('400s when the file is missing or not an xlsx', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);
    const none = await multipart(`/api/sell-orders/${id}/price-import/preview`, {}, { token });
    expect(none.status).toBe(400);
    const txt = await multipart(`/api/sell-orders/${id}/price-import/preview`, {
      file: new Blob(['not a spreadsheet'], { type: 'text/plain' }),
    }, { token });
    expect(txt.status).toBe(400);
  });

  it('400s with columns-not-found when headers are unrecognizable', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);
    const file = await xlsxBlob([['just', 'cells'], [1, 2]]);
    const res = await multipart(`/api/sell-orders/${id}/price-import/preview`, { file }, { token });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('columns-not-found');
  });

  it('413s an oversized upload', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);
    const big = new Blob([new Uint8Array(9 * 1024 * 1024)], { type: XLSX_MIME });
    const res = await multipart(`/api/sell-orders/${id}/price-import/preview`, { file: big }, { token });
    expect(res.status).toBe(413);
  });

  it('409s when the order is Done', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);
    await signOffAll(id);
    const done = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Done', note: 'paid' },
    });
    expect(done.status).toBe(200);
    const file = await xlsxBlob([['Part Number', 'Unit Price (USD)'], ['IMP-A1', 55]]);
    const res = await multipart(`/api/sell-orders/${id}/price-import/preview`, { file }, { token });
    expect(res.status).toBe(409);
  });

  it('403s a non-manager and 404s an unknown order', async () => {
    const mgr = await loginAs(ALEX);
    const id = await createOrder(mgr.token);
    const file = await xlsxBlob([['Part Number', 'Unit Price (USD)'], ['IMP-A1', 55]]);

    const pur = await loginAs(MARCUS);
    const forbidden = await multipart(`/api/sell-orders/${id}/price-import/preview`, { file }, { token: pur.token });
    expect(forbidden.status).toBe(403);

    const missing = await multipart('/api/sell-orders/SO-nope/price-import/preview', { file }, { token: mgr.token });
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/sell-orders/:id/market-sync — the manager's Sync to Market records
// the order's saved prices, at a chosen percent, on the Market page (ref_prices)
// as `bid:<order>` data points, USD at the rate the lines were saved at.
// ---------------------------------------------------------------------------

type RefPriceRow = {
  id: string; last_price: number | null; last_price_source: string | null;
  samples: number; label: string;
};

async function refPrice(pn: string): Promise<RefPriceRow | undefined> {
  const sql = getTestDb();
  return (await sql<RefPriceRow[]>`
    SELECT id, last_price::float AS last_price, last_price_source, samples, label
    FROM ref_prices WHERE part_number = ${pn} LIMIT 1
  `)[0];
}

async function eventsFor(refPriceId: string) {
  const sql = getTestDb();
  return sql<{ price: number; source: string }[]>`
    SELECT price::float AS price, source FROM ref_price_events WHERE ref_price_id = ${refPriceId}
  `;
}

const BID_LINES = [
  { category: 'RAM', label: 'DIMM A', partNumber: 'BID-A1', qty: 2, unitPrice: 40, warehouseId: 'WH-LA1' },
  { category: 'SSD', label: 'Drive B', partNumber: 'BID-B2', qty: 1, unitPrice: 90, warehouseId: 'WH-LA1' },
];
const repriced = (a: number, b: number) => [
  { ...BID_LINES[0], unitPrice: a }, { ...BID_LINES[1], unitPrice: b },
];
// The same part in two conditions — the import prices them as one.
const COND_LINES = [
  { category: 'RAM', label: 'DIMM C', partNumber: 'BID-C3', qty: 10, unitPrice: 40, warehouseId: 'WH-LA1', condition: 'New' },
  { category: 'RAM', label: 'DIMM C', partNumber: 'BID-C3', qty: 5, unitPrice: 40, warehouseId: 'WH-LA1', condition: 'Used' },
];

async function saveAt(token: string, id: string, a: number, b: number) {
  const res = await api('PATCH', `/api/sell-orders/${id}`, { token, body: { lines: repriced(a, b) } });
  expect(res.status).toBe(200);
}
const sync = (token: string, id: string, percent: unknown, parts: unknown) =>
  api<{ recorded: number; marketSyncedParts: string[]; error?: string }>('POST', `/api/sell-orders/${id}/market-sync`, {
    token, body: { percent, parts },
  });

describe('POST /api/sell-orders/:id/market-sync', () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('a save alone writes nothing to the Market page, even with a legacy bidParts', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, BID_LINES);
    const res = await api('PATCH', `/api/sell-orders/${id}`, {
      token, body: { lines: repriced(55, 120), bidParts: [{ partNumber: 'BID-A1' }] },
    });
    expect(res.status).toBe(200);
    expect((await refPrice('BID-A1'))?.last_price ?? null).toBeNull();
    expect((await refPrice('BID-B2'))?.last_price ?? null).toBeNull();
  });

  it('records the percent of the saved price, plainly, and leaves the order alone', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, BID_LINES);
    await saveAt(token, id, 200, 120);
    const before = await api<{ order: { lines: { unitPrice: number }[]; linesVersion?: string } }>(
      'GET', `/api/sell-orders/${id}`, { token });

    const res = await sync(token, id, 90, ['BID-A1', 'BID-B2']);
    expect(res.status).toBe(200);
    expect(res.body.recorded).toBe(2);

    const a = await refPrice('BID-A1');
    expect(a).toMatchObject({ last_price: 180, last_price_source: `bid:${id}`, label: 'DIMM A', samples: 0 });
    expect((await refPrice('BID-B2'))?.last_price).toBe(108);
    expect(await eventsFor(a!.id)).toEqual([{ price: 180, source: `bid:${id}` }]);
    const notes = await getTestDb()<{ note: string | null }[]>`
      SELECT note FROM ref_price_events WHERE ref_price_id = ${a!.id}`;
    expect(notes).toEqual([{ note: null }]);

    const after = await api<typeof before.body>('GET', `/api/sell-orders/${id}`, { token });
    expect(after.body.order.lines).toEqual(before.body.order.lines);
  });

  it('records only the parts the manager kept, and ignores one not on the order', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, BID_LINES);
    const res = await sync(token, id, 100, ['bid-a1', 'NOPE-9']);
    expect(res.body.recorded).toBe(1);
    expect((await refPrice('BID-A1'))?.last_price).toBe(40);
    expect(await refPrice('BID-B2')).toBeUndefined();
    expect(await refPrice('NOPE-9')).toBeUndefined();
  });

  it('a second sync of a part replaces the order\'s earlier reading, not adds to it', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, BID_LINES);
    await sync(token, id, 90, ['BID-A1']);
    await sync(token, id, 50, ['BID-A1']);
    const a = await refPrice('BID-A1');
    expect(a?.last_price).toBe(20);
    expect(await eventsFor(a!.id)).toEqual([{ price: 20, source: `bid:${id}` }]);
  });

  it('closing the order withdraws its readings, and the part falls back to its previous one', async () => {
    const { token } = await loginAs(ALEX);
    const earlier = await createOrder(token, BID_LINES);
    await saveAt(token, earlier, 30, 90);
    await sync(token, earlier, 100, ['BID-A1']);
    const id = await createOrder(token, BID_LINES);
    await saveAt(token, id, 100, 90);
    await sync(token, id, 55, ['BID-A1']);
    expect((await refPrice('BID-A1'))?.last_price).toBe(55);

    expect((await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'other' },
    })).status).toBe(200);
    const a = await refPrice('BID-A1');
    expect(a).toMatchObject({ last_price: 30, last_price_source: `bid:${earlier}` });
    const [ev] = await getTestDb()<{ detail: { withdrawnPrices?: unknown } }[]>`
      SELECT detail FROM sell_order_events WHERE sell_order_id = ${id} AND kind = 'closed'`;
    expect(ev?.detail.withdrawnPrices).toEqual([{ partNumber: 'BID-A1', price: 55 }]);
  });

  it('Done keeps a synced price and records the full sale price for the rest', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, BID_LINES);
    await saveAt(token, id, 200, 120);
    const synced = await sync(token, id, 90, ['BID-A1']);
    expect(synced.body.marketSyncedParts).toEqual([canonPartNumberJs('BID-A1')]);

    const detail = await api<{ order: { marketSyncedParts: string[] } }>('GET', `/api/sell-orders/${id}`, { token });
    expect(detail.body.order.marketSyncedParts).toEqual([canonPartNumberJs('BID-A1')]);

    await signOffAll(id);
    expect((await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Done', note: 'paid' },
    })).status).toBe(200);

    const a = await refPrice('BID-A1');
    expect(a).toMatchObject({ last_price: 180, last_price_source: `bid:${id}` });
    expect(await eventsFor(a!.id)).toEqual([{ price: 180, source: `bid:${id}` }]);
    expect(await refPrice('BID-B2')).toMatchObject({ last_price: 120, last_price_source: `sale:${id}` });
  });

  it('a reopened sale gives back only its sale readings, and Done again keeps the synced price', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, BID_LINES);
    await saveAt(token, id, 200, 120);
    await sync(token, id, 90, ['BID-A1']);
    await signOffAll(id);
    await api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Done', note: 'paid' } });

    const reopened = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Awaiting payment', from: 'Done', note: 'customer short-paid' },
    });
    expect(reopened.status).toBe(200);
    expect(await refPrice('BID-A1')).toMatchObject({ last_price: 180, last_price_source: `bid:${id}` });
    expect((await refPrice('BID-B2'))?.last_price_source).not.toBe(`sale:${id}`);

    await signOffAll(id);
    await api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Done', note: 'paid' } });
    expect(await refPrice('BID-A1')).toMatchObject({ last_price: 180, last_price_source: `bid:${id}` });
    expect(await refPrice('BID-B2')).toMatchObject({ last_price: 120, last_price_source: `sale:${id}` });
  });

  it('applies the percent to one qty-weighted point across a part\'s lines', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, BID_LINES);
    expect((await api('PATCH', `/api/sell-orders/${id}`, {
      token,
      body: { lines: [{ ...BID_LINES[0], qty: 2, unitPrice: 100 }, { ...BID_LINES[0], qty: 3, unitPrice: 50 }] },
    })).status).toBe(200);
    await sync(token, id, 90, ['BID-A1']);
    const a = await refPrice('BID-A1');
    // (2·100 + 3·50) / 5 = 70, at 90% = 63
    expect(a?.last_price).toBe(63);
    expect(await eventsFor(a!.id)).toHaveLength(1);
  });

  it('a part with no price is not recorded', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, BID_LINES);
    await saveAt(token, id, 0, 120);
    const res = await sync(token, id, 90, ['BID-A1']);
    expect(res.body.recorded).toBe(0);
    expect(await refPrice('BID-A1')).toBeUndefined();
  });

  it('leaves a lot priced at 0 out of the average', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, BID_LINES);
    expect((await api('PATCH', `/api/sell-orders/${id}`, {
      token,
      body: { lines: [{ ...BID_LINES[0], qty: 10, unitPrice: 100 }, { ...BID_LINES[0], qty: 5, unitPrice: 0 }] },
    })).status).toBe(200);
    await sync(token, id, 90, ['BID-A1']);
    expect((await refPrice('BID-A1'))?.last_price).toBe(90);
  });

  it('refuses prices that changed after the dialog showed them, and writes nothing', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, BID_LINES);
    await saveAt(token, id, 200, 120);
    const read = async () => (await api<{ order: { linesVersion: string } }>(
      'GET', `/api/sell-orders/${id}`, { token })).body.order.linesVersion;
    const seen = await read();
    await saveAt(token, id, 120, 120);
    const stale = await api<{ code?: string }>('POST', `/api/sell-orders/${id}/market-sync`, {
      token, body: { percent: 90, parts: ['BID-A1'], linesVersion: seen },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('lines_changed');
    expect(await refPrice('BID-A1')).toBeUndefined();

    const fresh = await api<{ recorded: number }>('POST', `/api/sell-orders/${id}/market-sync`, {
      token, body: { percent: 90, parts: ['BID-A1'], linesVersion: await read() },
    });
    expect(fresh.status).toBe(200);
    expect((await refPrice('BID-A1'))?.last_price).toBe(108);
    expect((await api('POST', `/api/sell-orders/${id}/market-sync`, {
      token, body: { percent: 90, parts: ['BID-A1'], linesVersion: 7 },
    })).status).toBe(400);
  });

  it('a save that stops pricing a part withdraws its reading', async () => {
    const { token } = await loginAs(ALEX);
    const earlier = await createOrder(token, BID_LINES);
    await saveAt(token, earlier, 30, 90);
    await sync(token, earlier, 100, ['BID-A1']);
    const id = await createOrder(token, BID_LINES);
    await saveAt(token, id, 200, 120);
    await sync(token, id, 90, ['BID-A1', 'BID-B2']);
    expect((await refPrice('BID-A1'))?.last_price).toBe(180);

    await saveAt(token, id, 0, 150);
    expect(await refPrice('BID-A1')).toMatchObject({ last_price: 30, last_price_source: `bid:${earlier}` });
    // A part still priced keeps its reading: a save alone doesn't sync.
    expect((await refPrice('BID-B2'))?.last_price).toBe(108);

    expect((await api('PATCH', `/api/sell-orders/${id}`, {
      token, body: { lines: [{ ...BID_LINES[0], unitPrice: 200 }] },
    })).status).toBe(200);
    // Dropped from the order, and nothing else ever quoted it.
    expect((await refPrice('BID-B2'))?.last_price ?? null).toBeNull();
  });

  it('a sync whose price rounds to nothing still takes back the earlier reading', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, BID_LINES);
    await saveAt(token, id, 0.05, 120);
    await sync(token, id, 100, ['BID-A1']);
    expect((await refPrice('BID-A1'))?.last_price).toBe(0.05);
    const res = await sync(token, id, 5, ['BID-A1']);
    expect(res.body.recorded).toBe(0);
    const a = await refPrice('BID-A1');
    expect(a?.last_price ?? null).toBeNull();
    expect(await eventsFor(a!.id)).toEqual([]);
  });

  it('Done takes back the reading of a part held at 0 that never sold', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, BID_LINES);
    await saveAt(token, id, 200, 120);
    await sync(token, id, 90, ['BID-A1', 'BID-B2']);
    // Pack mode can do this without a line save.
    await getTestDb()`UPDATE sell_order_lines SET qty = 0 WHERE sell_order_id = ${id} AND part_number = 'BID-A1'`;
    await signOffAll(id);
    expect((await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Done', note: 'paid' },
    })).status).toBe(200);
    const a = await refPrice('BID-A1');
    expect(a?.last_price ?? null).toBeNull();
    expect(await eventsFor(a!.id)).toEqual([]);
    expect(await refPrice('BID-B2')).toMatchObject({ last_price: 108, last_price_source: `bid:${id}` });
  });

  it('works from the USD a CNY order saved', async () => {
    // 1 USD = 7.2 CNY, so ¥720 → $100, at 90% = $90.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ amount: 1, base: 'USD', date: '2026-09-12', rates: { CNY: 7.2 } }),
      { status: 200 },
    )));
    const { token } = await loginAs(ALEX);
    const cust = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token, body: { customerId: cust.body.items[0].id, currency: 'CNY', lines: BID_LINES },
    });
    expect(create.status).toBe(201);
    await saveAt(token, create.body.id, 720, 1440);
    await sync(token, create.body.id, 90, ['BID-A1']);
    expect((await refPrice('BID-A1'))?.last_price).toBe(90);
  });

  it('refuses a bad percent or part list', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, BID_LINES);
    for (const percent of [0, -5, 100.5, '90', null, Number.NaN]) {
      expect((await sync(token, id, percent, ['BID-A1'])).status).toBe(400);
    }
    for (const parts of [[], 'BID-A1', [{ partNumber: 'BID-A1' }], ['  '], null]) {
      expect((await sync(token, id, 90, parts)).status).toBe(400);
    }
    expect(await refPrice('BID-A1')).toBeUndefined();
  });

  it('is a manager\'s, on an order that still exists and is open', async () => {
    const mgr = await loginAs(ALEX);
    const pur = await loginAs(MARCUS);
    const id = await createOrder(mgr.token, BID_LINES);
    expect((await sync(pur.token, id, 90, ['BID-A1'])).status).toBe(403);
    expect((await sync(mgr.token, 'SO-nope', 90, ['BID-A1'])).status).toBe(404);
    expect((await api('POST', `/api/sell-orders/${id}/status`, {
      token: mgr.token, body: { to: 'Closed', closeReasonId: 'other' },
    })).status).toBe(200);
    expect((await sync(mgr.token, id, 90, ['BID-A1'])).status).toBe(409);
  });
});
