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

// Vendor bid tabs only — warehouse packing tabs (Pack - LA1…) have their own
// layout ('Part #', no Unit Price) and are asserted separately.
const CATEGORY_TABS = new Set(['RAM', 'SSD', 'HDD', 'Other']);
const categoryTabs = (wb: ExcelJS.Workbook): ExcelJS.Worksheet[] =>
  wb.worksheets.filter(w => CATEGORY_TABS.has(w.name));

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

  it('streams one tab per category with all parts and an instruction block per tab', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);

    const res = await getRaw(`/api/sell-orders/${id}/price-template`, token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain(XLSX_MIME);
    expect(res.headers.get('content-disposition')).toContain('price-template');

    const wb = await loadWorkbook(res);
    // RAM line + SSD line → a dedicated sub-sheet each, in fixed order, then
    // the packing-checklist tab of the one warehouse on the order.
    expect(wb.worksheets.map(w => w.name)).toEqual(['RAM', 'SSD', 'Pack - LA1']);

    const parts: string[] = [];
    for (const ws of categoryTabs(wb)) {
      const { row: headerRow, cols } = findHeaderRow(ws);
      expect(headerRow).toBeGreaterThan(1);
      // Every tab is self-contained: instruction block names the order and
      // the fill-in currency.
      const preamble = [1, 2, 3].map(r =>
        (ws.getRow(r).values as unknown[]).map(v => String(v ?? '')).join(' ')).join(' ');
      expect(preamble).toContain(id);
      expect(preamble).toContain('USD');
      const partCol = cols.get('Part Number')!;
      for (let r = headerRow + 1; r <= ws.rowCount; r++) {
        const v = ws.getRow(r).getCell(partCol).value;
        if (v) parts.push(String(v));
      }
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

  it('leaves Unit Price blank and unlocked, locks every sheet, formulas Line Total', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);
    const res = await getRaw(`/api/sell-orders/${id}/price-template`, token);
    const wb = await loadWorkbook(res);
    expect(categoryTabs(wb).length).toBeGreaterThan(1);
    for (const ws of categoryTabs(wb)) {
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

  it('includes lines that have no part number on their category tab', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, {
      lines: [
        { category: 'Other', label: 'Mystery caddy', qty: 1, unitPrice: 5, warehouseId: 'WH-LA1' },
        { category: 'RAM', label: 'DIMM A', partNumber: 'TPL-A1', qty: 2, unitPrice: 40, warehouseId: 'WH-LA1' },
      ],
    });
    const wb = await loadWorkbook(await getRaw(`/api/sell-orders/${id}/price-template`, token));
    expect(wb.worksheets.map(w => w.name)).toEqual(['RAM', 'Other', 'Pack - LA1']);
    const other = wb.worksheets.find(w => w.name === 'Other')!;
    const { row: headerRow, cols } = findHeaderRow(other);
    const itemCol = cols.get('Item')!;
    const items: string[] = [];
    for (let r = headerRow + 1; r <= other.rowCount; r++) {
      const v = other.getRow(r).getCell(itemCol).value;
      if (v) items.push(String(v));
    }
    expect(items).toContain('Mystery caddy');
  });

  it('each category tab carries only its own spec columns', async () => {
    const { token } = await loginAs(ALEX);
    const mixed = await createOrder(token);
    const wb = await loadWorkbook(
      await getRaw(`/api/sell-orders/${mixed}/price-template`, token),
    );
    expect(categoryTabs(wb).map(w => w.name)).toEqual(['RAM', 'SSD']);

    const { cols: ramCols } = findHeaderRow(wb.worksheets.find(w => w.name === 'RAM')!);
    for (const h of ['Brand', 'Capacity', 'Gen', 'Type', 'Class', 'Rank', 'Speed', 'Chip #']) {
      expect(ramCols.get(h)).toBeGreaterThan(0);
    }
    for (const h of ['Interface', 'Form factor', 'Health %', 'RPM', 'Detail']) {
      expect(ramCols.has(h)).toBe(false);
    }

    const { cols: ssdCols } = findHeaderRow(wb.worksheets.find(w => w.name === 'SSD')!);
    for (const h of ['Brand', 'Capacity', 'Interface', 'Form factor', 'Health %']) {
      expect(ssdCols.get(h)).toBeGreaterThan(0);
    }
    for (const h of ['Gen', 'Class', 'Rank', 'Speed', 'Chip #', 'RPM']) {
      expect(ssdCols.has(h)).toBe(false);
    }
  });

  it('every tab carries a blank, unlocked Note column for vendor remarks', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);
    const wb = await loadWorkbook(
      await getRaw(`/api/sell-orders/${id}/price-template`, token),
    );
    for (const ws of categoryTabs(wb)) {
      const { row: headerRow, cols } = findHeaderRow(ws);
      const noteCol = cols.get('Note / 备注')!;
      // Last column, after Line Total.
      expect(noteCol).toBeGreaterThan(cols.get('Line Total (USD)')!);
      // The instruction block invites remarks there.
      const preamble = [1, 2, 3].map(r =>
        (ws.getRow(r).values as unknown[]).map(v => String(v ?? '')).join(' ')).join(' ');
      expect(preamble).toContain('Note / 备注');

      for (let r = headerRow + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        if (!row.getCell(cols.get('Qty')!).value) continue;
        const noteCell = row.getCell(noteCol);
        // Nothing pre-filled from the DB — the vendor/manager types remarks.
        expect(noteCell.value).toBeNull();
        expect(noteCell.protection?.locked).toBe(false);
      }
    }
  });

  it('never embeds images and links the photo as an Image URL hyperlink', async () => {
    // Route path: seeded scans carry stub data: URLs, which must not reach the
    // sheet — cells stay blank and nothing is embedded.
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);
    const res = await getRaw(`/api/sell-orders/${id}/price-template`, token);
    expect(res.status).toBe(200);
    const dl = await loadWorkbook(res);
    for (const ws of dl.worksheets) expect(ws.getImages()).toHaveLength(0);
    for (const ws of categoryTabs(dl)) {
      expect(findHeaderRow(ws).cols.get('Image URL')).toBe(2);
    }

    // Builder path: a real https URL renders as a clickable hyperlink cell.
    const buf = await buildPriceTemplateWorkbook(
      { id: 'SL-IMG', customerName: 'Acme', currencyCode: 'USD' },
      [{
        category: 'RAM', label: 'DIMM A', partNumber: 'TPL-A1', condition: null,
        qty: 2, imageUrl: 'https://static.recycleservers.com/label-scans/x.jpg',
        specs: { brand: 'Samsung', speed: 3200, chip: 'K4A8G085WB-BCTD' },
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
    expect(String(built.getRow(headerRow + 1).getCell(cols.get('Chip #')!).value)).toBe('K4A8G085WB-BCTD');
  });

  it('appends price-free packing-checklist tabs, one per warehouse', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, {
      lines: [
        { category: 'RAM', label: 'DIMM A', partNumber: 'WH-R1', qty: 2, unitPrice: 40, warehouseId: 'WH-LA1' },
        { category: 'RAM', label: 'DIMM A', partNumber: 'WH-R1', qty: 3, unitPrice: 40, warehouseId: 'WH-NJ2' },
        { category: 'SSD', label: 'Drive B', partNumber: 'WH-S1', qty: 1, unitPrice: 90, warehouseId: 'WH-LA1' },
      ],
    });
    const wb = await loadWorkbook(await getRaw(`/api/sell-orders/${id}/price-template`, token));
    expect(wb.worksheets.map(w => w.name)).toEqual(['RAM', 'SSD', 'Pack - LA1', 'Pack - NJ2']);

    const cellStrings = (ws: ExcelJS.Worksheet): string[] => {
      const out: string[] = [];
      ws.eachRow(row => row.eachCell({ includeEmpty: false }, cell => {
        out.push(String(cell.value ?? ''));
      }));
      return out;
    };

    // LA1 holds both categories as stacked sections with qty subtotals and a
    // warehouse total; the NJ2 split stays on its own tab.
    const la1 = wb.worksheets.find(w => w.name === 'Pack - LA1')!;
    const la1Cells = cellStrings(la1);
    expect(la1Cells).toContain('RAM');
    expect(la1Cells).toContain('SSD');
    expect(la1Cells.filter(v => v === 'Packed ✓')).toHaveLength(2);
    expect(la1Cells.filter(v => v === 'Subtotal')).toHaveLength(2);
    expect(la1Cells).toContain('Warehouse total');
    expect(la1Cells).toContain('WH-R1');
    expect(la1Cells).toContain('WH-S1');
    // Price-free by design: nothing on a packing tab may look like a price —
    // that's also what keeps the import parser away from these tabs.
    expect(la1Cells.some(v => /price|单价|价格/i.test(v))).toBe(false);
    expect(la1.sheetProtection).toBeTruthy();

    const rowQty = (ws: ExcelJS.Worksheet, firstCell: string): number[] => {
      const out: number[] = [];
      ws.eachRow(row => {
        if (String(row.getCell(1).value ?? '') === firstCell) {
          row.eachCell({ includeEmpty: false }, cell => {
            if (typeof cell.value === 'number') out.push(cell.value);
          });
        }
      });
      return out;
    };
    // LA1: RAM qty 2 + SSD qty 1 → subtotals [2, 1], total 3. NJ2: RAM 3.
    expect(rowQty(la1, 'Subtotal')).toEqual([2, 1]);
    expect(rowQty(la1, 'Warehouse total')).toEqual([3]);

    const nj2 = wb.worksheets.find(w => w.name === 'Pack - NJ2')!;
    const nj2Cells = cellStrings(nj2);
    expect(nj2Cells).toContain('WH-R1');
    expect(nj2Cells).not.toContain('WH-S1');
    expect(rowQty(nj2, 'Warehouse total')).toEqual([3]);
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
