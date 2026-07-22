import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import app from '../src/index';
import { resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import {
  buildPriceTemplateWorkbook, makePriceTemplateThumbnail, fetchScanBytes,
} from '../src/lib/sellOrderPriceTemplate';
import type { Env } from '../src/types';

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

  it('degrades to no images when R2 is unconfigured (stub scans)', async () => {
    // Test env has no R2 creds, and seeded scan keys are stubs — the template
    // must still download, just without embedded photos.
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);
    const res = await getRaw(`/api/sell-orders/${id}/price-template`, token);
    expect(res.status).toBe(200);
    const ws = (await loadWorkbook(res)).worksheets[0];
    expect(ws.getImages()).toHaveLength(0);
  });

  it('embeds a thumbnail and sizes the row for it', async () => {
    // 800×600 source → thumbnail capped at 96 px on the long edge.
    const photo = await sharp({
      create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 30, b: 30 } },
    }).jpeg().toBuffer();
    const thumb = await makePriceTemplateThumbnail(photo);
    expect(thumb).not.toBeNull();
    expect(Math.max(thumb!.width, thumb!.height)).toBeLessThanOrEqual(96);

    const buf = await buildPriceTemplateWorkbook(
      { id: 'SL-IMG', customerName: 'Acme', currencyCode: 'USD' },
      [{ label: 'DIMM A', subLabel: null, partNumber: 'TPL-A1', condition: null, qty: 2, thumbnail: thumb }],
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect(ws.getImages()).toHaveLength(1);
    const { row: headerRow } = findHeaderRow(ws);
    expect(ws.getRow(headerRow + 1).height).toBeGreaterThan(20);
  });

  it('makePriceTemplateThumbnail returns null for corrupt bytes', async () => {
    expect(await makePriceTemplateThumbnail(Buffer.from('not an image'))).toBeNull();
  });
});

// Dev databases are nightly copies of prod, so stored R2 keys point at the
// PROD bucket — unreadable with this environment's credentials. The stored
// absolute delivery_url still resolves publicly, so it is the fallback.
describe('fetchScanBytes', () => {
  const noR2: Env = { JWT_SECRET: 'x' } as Env;
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to fetching the public delivery URL when the key misses', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200 })));
    const buf = await fetchScanBytes(noR2, 'label-scans/prod-only.jpg', 'https://cdn.example.com/prod-only.jpg');
    expect(buf).toEqual(Buffer.from(bytes));
    expect(fetch).toHaveBeenCalledWith('https://cdn.example.com/prod-only.jpg', expect.anything());
  });

  it('never fetches stub data: URLs', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await fetchScanBytes(noR2, 'stub-123', 'data:image/placeholder;x')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns null on HTTP errors and network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    expect(await fetchScanBytes(noR2, 'label-scans/x.jpg', 'https://cdn.example.com/x.jpg')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await fetchScanBytes(noR2, 'label-scans/x.jpg', 'https://cdn.example.com/x.jpg')).toBeNull();
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
