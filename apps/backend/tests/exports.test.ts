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
    expect(ws.rowCount).toBeGreaterThan(1); // header + seeded lines
  });

  it('forbids purchasers (the workbook carries cost columns)', async () => {
    const { token } = await loginAs(MARCUS);
    const res = await getRaw('/api/inventory/export', token);
    expect(res.status).toBe(403);
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
