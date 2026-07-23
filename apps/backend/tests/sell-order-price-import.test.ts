import { describe, it, expect, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import {
  parsePriceWorkbook,
  PriceColumnsNotFoundError,
  type OrderProduct,
  type PriceImportPreview,
} from '../src/services/sellOrderPriceImport';
import app from '../src/index';
import { resetDb } from './helpers/db';
import { api, multipart, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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
    condition: null,
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
    const ssd = res.rows.find(r => r.canonPart === 'XYZ-9');
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
    expect(res.rows.find(r => r.canonPart === 'XYZ-9')).toMatchObject({ sheet: 'SSD', price: 55.5 });
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
    expect(res.rows[0]).toMatchObject({ status: 'matched', canonPart: 'C-ABC123', price: 75 });
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

  it('disambiguates same part with two conditions via the Condition column', () => {
    const wb = wbWith([
      ['Part Number', 'Condition', 'Unit Price (USD)'],
      ['ABC123', 'New', 100],
      ['ABC123', 'Used', 60],
    ]);
    const products = [
      product({ condition: 'New', oldPrice: 90 }),
      product({ condition: 'Used', oldPrice: 50 }),
    ];
    const res = parsePriceWorkbook(wb, products);
    expect(res.rows[0]).toMatchObject({ status: 'matched', condition: 'New', price: 100, oldPrice: 90 });
    expect(res.rows[1]).toMatchObject({ status: 'matched', condition: 'Used', price: 60, oldPrice: 50 });
  });

  it('marks ambiguous when conditions collide and the column is gone', () => {
    const wb = wbWith([
      ['Part Number', 'Unit Price (USD)'],
      ['ABC123', 100],
    ]);
    const products = [product({ condition: 'New' }), product({ condition: 'Used' })];
    const res = parsePriceWorkbook(wb, products);
    expect(res.rows[0].status).toBe('ambiguous');
    expect(res.summary.ambiguous).toBe(1);
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

  it('reads rich-text part numbers', () => {
    const wb = wbWith([
      ['Part Number', 'Unit Price (USD)'],
      [{ richText: [{ text: 'ABC' }, { text: '123' }] }, 100],
    ]);
    const res = parsePriceWorkbook(wb, [product({})]);
    expect(res.rows[0]).toMatchObject({ status: 'matched', canonPart: 'ABC123' });
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
    const first = body.rows.find(r => r.canonPart === 'IMP-A1');
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
    // Category bid tabs first, then the warehouse packing-checklist tab.
    expect(wb.worksheets.map(w => w.name)).toEqual(['RAM', 'SSD', 'LA1']);

    // ...fill the Unit Price cell of every product row, vendor-style. The
    // packing tab has no Unit Price column, so it is naturally skipped.
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

    // ...and every bid tab's price lands in the preview — while the parser
    // never reads the packing tab even though it repeats the part numbers
    // (it has "Part #" but no price header, so findHeaders skips it; a
    // parsed LA1 row would demote the bid rows to duplicates here).
    const res = await multipart(`/api/sell-orders/${id}/price-import/preview`, { file: filled }, { token });
    expect(res.status).toBe(200);
    const body = res.body as PriceImportPreview;
    expect(body.summary.matched).toBe(2);
    expect(body.summary.duplicate).toBe(0);
    expect(body.rows.find(r => r.canonPart === 'IMP-A1')).toMatchObject({ sheet: 'RAM', price: 45 });
    expect(body.rows.find(r => r.canonPart === 'IMP-B2')).toMatchObject({ sheet: 'SSD', price: 111 });
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
