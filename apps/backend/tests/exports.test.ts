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

async function loadSheet(res: Response) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
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

  it('streams a populated xlsx for a manager', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/inventory/export', token);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain(XLSX_MIME);
    expect(res.headers.get('content-disposition')).toContain('.xlsx');

    const { ws, cells } = await loadSheet(res);
    expect(cells).toContain('Item');       // header row present
    expect(cells).toContain('Unit cost');  // manager-only column present
    expect(cells).toContain('Rank');       // dedicated RAM attribute columns
    expect(cells).toContain('Speed');
    expect(cells).toContain('Image URL');  // label-scan delivery URL column
    expect(ws.rowCount).toBeGreaterThan(1); // header + seeded lines
  });

  it('forbids purchasers (the workbook carries cost columns)', async () => {
    const { token } = await loginAs(MARCUS);
    const res = await getRaw('/api/inventory/export', token);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/inventory/export?view=grouped', () => {
  beforeEach(async () => { await resetDb(); });

  it('uses the shared column set when no category is filtered', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/inventory/export?view=grouped', token);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('inventory-grouped');

    const { ws } = await loadSheet(res);
    const headers = headerRow(ws);
    for (const h of ['Part #', 'Category', 'Item', 'Condition', 'Warehouses', 'Qty', 'Cost avg', 'Submitted by']) {
      expect(headers).toContain(h);
    }
    for (const h of ['Brand', 'Spec', 'Gen', 'Interface', 'Chip #']) {
      expect(headers).not.toContain(h);
    }
    expect(ws.rowCount).toBeGreaterThan(1);
  });

  it('uses granular RAM columns when category=RAM', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/inventory/export?view=grouped&category=RAM', token);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('inventory-ram');

    const { ws } = await loadSheet(res);
    const headers = headerRow(ws);
    for (const h of ['Part #', 'Chip #', 'Brand', 'Capacity', 'Gen', 'Type', 'Class', 'Rank', 'Speed', 'Condition', 'Cost avg', 'Submitted by']) {
      expect(headers).toContain(h);
    }
    for (const h of ['Item', 'Spec', 'Category', 'Interface']) {
      expect(headers).not.toContain(h);
    }

    // Data-level check that the new attribute keys are wired: the seeded RAM
    // lines always carry a brand.
    expect(ws.rowCount).toBeGreaterThan(1);
    const brandCol = ws.getRow(1).values as unknown[];
    const brandIdx = brandCol.findIndex((v) => v === 'Brand');
    expect(String(ws.getRow(2).getCell(brandIdx).value ?? '')).not.toBe('');
  });

  it('uses granular SSD columns when category=SSD', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/inventory/export?view=grouped&category=SSD', token);

    const { ws } = await loadSheet(res);
    const headers = headerRow(ws);
    for (const h of ['Interface', 'Form factor', 'Health %']) expect(headers).toContain(h);
    for (const h of ['Chip #', 'Rank', 'RPM']) expect(headers).not.toContain(h);
  });

  it('uses granular HDD columns when category=HDD', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/inventory/export?view=grouped&category=HDD', token);

    const { ws } = await loadSheet(res);
    const headers = headerRow(ws);
    for (const h of ['RPM', 'Health %']) expect(headers).toContain(h);
  });

  it('uses description columns when category=Other', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/inventory/export?view=grouped&category=Other', token);

    const { ws } = await loadSheet(res);
    const headers = headerRow(ws);
    for (const h of ['Description', 'Condition']) expect(headers).toContain(h);
    expect(headers).not.toContain('Brand');
  });

  it('falls back to shared columns for an unknown category', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/inventory/export?view=grouped&category=CPU', token);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('inventory-grouped');

    const { ws } = await loadSheet(res);
    const headers = headerRow(ws);
    expect(headers).toContain('Item');
    expect(headers).not.toContain('Brand');
    // Nothing is seeded under CPU — the WHERE still filters, so header only.
    expect(ws.rowCount).toBe(1);
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
