import { describe, it, expect, beforeEach, vi } from 'vitest';
import ExcelJS from 'exceljs';
import app from '../src/index';
import { resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { buildPriceTemplateWorkbook } from '../src/lib/sellOrderPriceTemplate';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function getRaw(path: string, token: string): Promise<Response> {
  return app.fetch(
    new Request('http://test' + path, {
      headers: { cookie: `at=${token}`, 'X-Requested-By': 'recycle-erp' },
    }),
    testEnv,
  );
}

async function createOrder(token: string, opts: { currency?: string; lines?: object[] } = {}): Promise<string> {
  const cust = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: {
      customerId: cust.body.items[0].id,
      ...(opts.currency ? { currency: opts.currency } : {}),
      lines: opts.lines ?? [
        { category: 'RAM', label: 'DIMM A', partNumber: 'TPL-A1', qty: 2, unitPrice: 40, warehouseId: 'WH-LA1' },
        { category: 'SSD', label: 'Drive B', partNumber: 'TPL-B2', qty: 1, unitPrice: 90, warehouseId: 'WH-LA1' },
      ],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

async function loadWorkbook(res: Response): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  return wb;
}

// Header row is not at a fixed position (an instruction block sits above it) —
// locate it the same way the import parser does: by its text.
function findHeaderRow(ws: ExcelJS.Worksheet): { row: number; cols: Map<string, number> } {
  for (let r = 1; r <= 15; r++) {
    const cols = new Map<string, number>();
    const row = ws.getRow(r);
    for (let c = 1; c <= row.cellCount; c++) {
      const v = row.getCell(c).value;
      if (typeof v === 'string' && v.trim()) cols.set(v.trim(), c);
    }
    if ([...cols.keys()].some(h => h === 'Part Number')) return { row: r, cols };
  }
  throw new Error('header row not found');
}

describe('GET /api/sell-orders/:id/price-template', () => {
  beforeEach(async () => { await resetDb(); });

  it('streams a bid sheet with all parts and an instruction block above the table', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);

    const res = await getRaw(`/api/sell-orders/${id}/price-template`, token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain(XLSX_MIME);
    expect(res.headers.get('content-disposition')).toContain('price-template');

    const wb = await loadWorkbook(res);
    const ws = wb.worksheets[0];
    const { row: headerRow, cols } = findHeaderRow(ws);
    expect(headerRow).toBeGreaterThan(1);
    // The instruction block names the order and the fill-in currency.
    const preamble = [1, 2, 3].map(r =>
      (ws.getRow(r).values as unknown[]).map(v => String(v ?? '')).join(' ')).join(' ');
    expect(preamble).toContain(id);
    expect(preamble).toContain('USD');

    const partCol = cols.get('Part Number')!;
    const parts: string[] = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const v = ws.getRow(r).getCell(partCol).value;
      if (v) parts.push(String(v));
    }
    expect(parts.sort()).toEqual(['TPL-A1', 'TPL-B2']);
  });

  it('groups multi-warehouse lines into one row with summed qty', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, {
      lines: [
        { category: 'RAM', label: 'DIMM A', partNumber: 'TPL-DUP', qty: 2, unitPrice: 10, warehouseId: 'WH-LA1' },
        { category: 'RAM', label: 'DIMM A', partNumber: 'TPL-DUP', qty: 3, unitPrice: 10, warehouseId: 'WH-NJ2' },
      ],
    });
    const res = await getRaw(`/api/sell-orders/${id}/price-template`, token);
    const ws = (await loadWorkbook(res)).worksheets[0];
    const { row: headerRow, cols } = findHeaderRow(ws);
    const partCol = cols.get('Part Number')!;
    const qtyCol = cols.get('Qty')!;
    const dataRows = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      if (ws.getRow(r).getCell(partCol).value) dataRows.push(r);
    }
    expect(dataRows).toHaveLength(1);
    expect(Number(ws.getRow(dataRows[0]).getCell(qtyCol).value)).toBe(5);
  });

  it('leaves Unit Price blank and unlocked, locks the sheet, formulas Line Total', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);
    const res = await getRaw(`/api/sell-orders/${id}/price-template`, token);
    const ws = (await loadWorkbook(res)).worksheets[0];
    const { row: headerRow, cols } = findHeaderRow(ws);
    const priceCol = cols.get('Unit Price (USD)')!;
    const totalCol = cols.get('Line Total (USD)')!;
    expect(priceCol).toBeGreaterThan(0);
    expect(totalCol).toBeGreaterThan(0);
    expect(ws.sheetProtection).toBeTruthy();

    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (!row.getCell(cols.get('Part Number')!).value) continue;
      const priceCell = row.getCell(priceCol);
      // Blank bid sheet: existing order prices must not leak to the vendor.
      expect(priceCell.value).toBeNull();
      expect(priceCell.protection?.locked).toBe(false);
      const totalCell = row.getCell(totalCol);
      expect(totalCell.formula).toBeTruthy();
    }
  });

  it('labels the price columns CNY on a CNY order', async () => {
    // Frankfurter is stubbed so the CNY order's FX snapshot never hits the
    // network (same as sell-order-spreadsheet.test.ts).
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ amount: 1, base: 'USD', date: '2026-06-07', rates: { CNY: 7.2154 } }),
      { status: 200 },
    )));
    try {
      const { token } = await loginAs(ALEX);
      const id = await createOrder(token, { currency: 'CNY' });
      const res = await getRaw(`/api/sell-orders/${id}/price-template`, token);
      expect(res.status).toBe(200);
      const ws = (await loadWorkbook(res)).worksheets[0];
      const { cols } = findHeaderRow(ws);
      expect(cols.get('Unit Price (CNY)')).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('includes lines that have no part number', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, {
      lines: [
        { category: 'Other', label: 'Mystery caddy', qty: 1, unitPrice: 5, warehouseId: 'WH-LA1' },
        { category: 'RAM', label: 'DIMM A', partNumber: 'TPL-A1', qty: 2, unitPrice: 40, warehouseId: 'WH-LA1' },
      ],
    });
    const res = await getRaw(`/api/sell-orders/${id}/price-template`, token);
    const ws = (await loadWorkbook(res)).worksheets[0];
    const { row: headerRow, cols } = findHeaderRow(ws);
    const itemCol = cols.get('Item')!;
    const items: string[] = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const v = ws.getRow(r).getCell(itemCol).value;
      if (v) items.push(String(v));
    }
    expect(items).toContain('Mystery caddy');
  });

  it('shows spec columns for the categories on the order only', async () => {
    const { token } = await loginAs(ALEX);
    // RAM + SSD mix: union of both spec sets, no HDD-only RPM column.
    const mixed = await createOrder(token);
    const mixedWs = (await loadWorkbook(
      await getRaw(`/api/sell-orders/${mixed}/price-template`, token),
    )).worksheets[0];
    const { cols: mixedCols } = findHeaderRow(mixedWs);
    for (const h of ['Brand', 'Capacity', 'Gen', 'Type', 'Class', 'Rank', 'Speed', 'Interface', 'Form factor', 'Health %']) {
      expect(mixedCols.get(h)).toBeGreaterThan(0);
    }
    expect(mixedCols.has('RPM')).toBe(false);
    expect(mixedCols.has('Detail')).toBe(false);

    const ramOnly = await createOrder(token, {
      lines: [{ category: 'RAM', label: 'DIMM A', partNumber: 'TPL-R1', qty: 1, unitPrice: 10, warehouseId: 'WH-LA1' }],
    });
    const ramWs = (await loadWorkbook(
      await getRaw(`/api/sell-orders/${ramOnly}/price-template`, token),
    )).worksheets[0];
    const { cols: ramCols } = findHeaderRow(ramWs);
    expect(ramCols.get('Speed')).toBeGreaterThan(0);
    expect(ramCols.has('Interface')).toBe(false);
  });

  it('never embeds images and links the photo as an Image URL hyperlink', async () => {
    // Route path: seeded scans carry stub data: URLs, which must not reach the
    // sheet — cells stay blank and nothing is embedded.
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);
    const res = await getRaw(`/api/sell-orders/${id}/price-template`, token);
    expect(res.status).toBe(200);
    const ws = (await loadWorkbook(res)).worksheets[0];
    expect(ws.getImages()).toHaveLength(0);
    expect(findHeaderRow(ws).cols.get('Image URL')).toBe(2);

    // Builder path: a real https URL renders as a clickable hyperlink cell.
    const buf = await buildPriceTemplateWorkbook(
      { id: 'SL-IMG', customerName: 'Acme', currencyCode: 'USD' },
      [{
        category: 'RAM', label: 'DIMM A', partNumber: 'TPL-A1', condition: null,
        qty: 2, imageUrl: 'https://static.recycleservers.com/label-scans/x.jpg',
        specs: { brand: 'Samsung', speed: 3200 },
      }],
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const built = wb.worksheets[0];
    expect(built.getImages()).toHaveLength(0);
    const { row: headerRow, cols } = findHeaderRow(built);
    const cell = built.getRow(headerRow + 1).getCell(cols.get('Image URL')!);
    const v = cell.value as { text?: string; hyperlink?: string };
    expect(v?.hyperlink).toBe('https://static.recycleservers.com/label-scans/x.jpg');
    expect(v?.text).toBe('https://static.recycleservers.com/label-scans/x.jpg');
    expect(String(built.getRow(headerRow + 1).getCell(cols.get('Brand')!).value)).toBe('Samsung');
  });

  it('404s unknown orders and 403s non-managers', async () => {
    const mgr = await loginAs(ALEX);
    const missing = await getRaw('/api/sell-orders/SO-nope/price-template', mgr.token);
    expect(missing.status).toBe(404);

    const id = await createOrder(mgr.token);
    const pur = await loginAs(MARCUS);
    const forbidden = await getRaw(`/api/sell-orders/${id}/price-template`, pur.token);
    expect(forbidden.status).toBe(403);
  });
});
