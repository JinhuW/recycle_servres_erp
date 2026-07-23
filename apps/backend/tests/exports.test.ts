import { describe, it, expect, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import app from '../src/index';
import { resetDb } from './helpers/db';
import { testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// The api() helper consumes the body as text, which mangles a binary xlsx — so
// hit app.fetch directly and keep the raw Response.
function getRaw(path: string, token: string): Promise<Response> {
  return app.fetch(
    new Request('http://test' + path, {
      headers: { cookie: `at=${token}`, 'X-Requested-By': 'recycle-erp' },
    }),
    testEnv,
  );
}

async function loadWorkbook(res: Response): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  return wb;
}

async function loadSheet(res: Response) {
  const wb = await loadWorkbook(res);
  const ws = wb.worksheets[0];
  const cells: string[] = [];
  ws.eachRow((row) => {
    (row.values as unknown[]).forEach((v) => {
      if (v != null) cells.push(String(v));
    });
  });
  return { ws, cells };
}

// The flattened cells can't tell a header from a data cell (the string 'RAM'
// appears in both), so column assertions must target row 1 specifically.
function headerRow(ws: ExcelJS.Worksheet): string[] {
  return (ws.getRow(1).values as unknown[]).filter((v) => v != null).map(String);
}

describe('GET /api/inventory/export', () => {
  beforeEach(async () => { await resetDb(); });

  it('streams one tab per category with granular columns (same format as the sell-order download)', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/inventory/export', token);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain(XLSX_MIME);
    expect(res.headers.get('content-disposition')).toContain('.xlsx');

    const wb = await loadWorkbook(res);
    const names = wb.worksheets.map(w => w.name);
    // Tab order is fixed; the seed populates every category.
    const orderRef = ['RAM', 'SSD', 'HDD', 'Other'].filter(n => names.includes(n));
    expect(names).toEqual(orderRef);
    expect(names).toContain('RAM');
    expect(names).toContain('SSD');

    const ram = wb.worksheets.find(w => w.name === 'RAM')!;
    const ramHeaders = headerRow(ram);
    for (const h of ['ID', 'Date', 'Item', 'Part #', 'Chip #', 'Brand', 'Capacity', 'Gen', 'Type', 'Class', 'Rank', 'Speed', 'Condition', 'Warehouse', 'Qty', 'Unit cost', 'Sell price', 'Profit', 'Margin %', 'Submitted by', 'Status', 'Image URL']) {
      expect(ramHeaders).toContain(h);
    }
    expect(ram.rowCount).toBeGreaterThan(1); // header + seeded lines

    const ssd = wb.worksheets.find(w => w.name === 'SSD')!;
    const ssdHeaders = headerRow(ssd);
    for (const h of ['Interface', 'Form factor', 'Health %']) expect(ssdHeaders).toContain(h);
    for (const h of ['Gen', 'Chip #', 'RPM']) expect(ssdHeaders).not.toContain(h);

    // The composed Spec string and the Category column are gone everywhere —
    // the tab name carries the category, attributes are one column each.
    for (const ws of wb.worksheets) {
      const headers = headerRow(ws);
      expect(headers).not.toContain('Spec');
      expect(headers).not.toContain('Category');
    }
  });

  it('forbids purchasers (the workbook carries cost columns)', async () => {
    const { token } = await loginAs(MARCUS);
    const res = await getRaw('/api/inventory/export', token);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/inventory/export?view=grouped', () => {
  beforeEach(async () => { await resetDb(); });

  it('splits into per-category tabs with granular columns when no category is filtered', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/inventory/export?view=grouped', token);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('inventory-grouped');

    const wb = await loadWorkbook(res);
    const names = wb.worksheets.map(w => w.name);
    expect(names).toEqual(['RAM', 'SSD', 'HDD', 'Other'].filter(n => names.includes(n)));
    expect(names).toContain('RAM');

    for (const ws of wb.worksheets) {
      const headers = headerRow(ws);
      // Every tab is granular now — no shared Category/Item fallback set.
      expect(headers).not.toContain('Category');
      expect(headers).not.toContain('Item');
      expect(headers).not.toContain('Spec');
      for (const h of ['Part #', 'Condition', 'Warehouses', 'Qty', 'Cost avg', 'Submitted by']) {
        expect(headers).toContain(h);
      }
    }
    expect(headerRow(wb.worksheets.find(w => w.name === 'RAM')!)).toContain('Gen');
  });

  it('narrows to a single granular RAM tab when category=RAM', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/inventory/export?view=grouped&category=RAM', token);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('inventory-ram');

    const wb = await loadWorkbook(res);
    expect(wb.worksheets.map(w => w.name)).toEqual(['RAM']);
    const ws = wb.worksheets[0];
    const headers = headerRow(ws);
    for (const h of ['Part #', 'Chip #', 'Brand', 'Capacity', 'Gen', 'Type', 'Class', 'Rank', 'Speed', 'Condition', 'Cost avg', 'Submitted by']) {
      expect(headers).toContain(h);
    }
    for (const h of ['Item', 'Spec', 'Category', 'Interface']) {
      expect(headers).not.toContain(h);
    }

    // Data-level check that the attribute keys are wired: the seeded RAM
    // lines always carry a brand.
    expect(ws.rowCount).toBeGreaterThan(1);
    const brandCol = ws.getRow(1).values as unknown[];
    const brandIdx = brandCol.findIndex((v) => v === 'Brand');
    expect(String(ws.getRow(2).getCell(brandIdx).value ?? '')).not.toBe('');
  });

  it('uses granular SSD columns when category=SSD', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/inventory/export?view=grouped&category=SSD', token);

    const wb = await loadWorkbook(res);
    expect(wb.worksheets.map(w => w.name)).toEqual(['SSD']);
    const headers = headerRow(wb.worksheets[0]);
    for (const h of ['Interface', 'Form factor', 'Health %']) expect(headers).toContain(h);
    for (const h of ['Chip #', 'Rank', 'RPM']) expect(headers).not.toContain(h);
  });

  it('uses granular HDD columns when category=HDD', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/inventory/export?view=grouped&category=HDD', token);

    const wb = await loadWorkbook(res);
    expect(wb.worksheets.map(w => w.name)).toEqual(['HDD']);
    const headers = headerRow(wb.worksheets[0]);
    for (const h of ['RPM', 'Health %']) expect(headers).toContain(h);
  });

  it('uses description columns when category=Other', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/inventory/export?view=grouped&category=Other', token);

    const wb = await loadWorkbook(res);
    expect(wb.worksheets.map(w => w.name)).toEqual(['Other']);
    const headers = headerRow(wb.worksheets[0]);
    for (const h of ['Description', 'Condition']) expect(headers).toContain(h);
    expect(headers).not.toContain('Brand');
  });

  it('produces a header-only sheet for an unknown category', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/inventory/export?view=grouped&category=CPU', token);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('inventory-grouped');

    // Nothing is seeded under CPU — the WHERE filters everything out and the
    // empty-workbook guard emits a single header-only sheet.
    const wb = await loadWorkbook(res);
    expect(wb.worksheets.map(w => w.name)).toEqual(['Inventory']);
    expect(wb.worksheets[0].rowCount).toBe(1);
  });
});

describe('GET /api/sell-orders/export', () => {
  beforeEach(async () => { await resetDb(); });

  it('streams a populated xlsx for a manager', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/sell-orders/export', token);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain(XLSX_MIME);

    const { ws, cells } = await loadSheet(res);
    expect(cells).toContain('Order ID');
    expect(cells).toContain('Total');
    expect(ws.rowCount).toBeGreaterThan(1); // header + seeded sell orders
  });

  it('forbids purchasers (every sell-order route is manager-only)', async () => {
    const { token } = await loginAs(MARCUS);
    const res = await getRaw('/api/sell-orders/export', token);
    expect(res.status).toBe(403);
  });
});
