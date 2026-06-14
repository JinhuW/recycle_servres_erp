import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

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

const listOrderIds = async (token: string): Promise<string[]> => {
  const r = await api<{ orders: { id: string }[] }>('GET', '/api/orders', { token });
  expect(r.status).toBe(200);
  return r.body.orders.map((o) => o.id);
};

describe('GET /api/orders/:id/spreadsheet', () => {
  beforeEach(async () => { await resetDb(); });

  it('streams an xlsx workbook with Payment and Line items tabs', async () => {
    const { token } = await loginAs(ALEX);
    const ids = await listOrderIds(token);
    expect(ids.length).toBeGreaterThan(0);

    const res = await getRaw(`/api/orders/${ids[0]}/spreadsheet`, token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain(XLSX_MIME);
    expect(res.headers.get('content-disposition')).toContain('.xlsx');

    const buf = Buffer.from(await res.arrayBuffer());
    // XLSX is a zip container — the magic bytes are 'PK'.
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');

    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.getWorksheet('Payment')).toBeTruthy();
    expect(wb.getWorksheet('Line items')).toBeTruthy();
  });

  it('includes the payment summary fields', async () => {
    const { token } = await loginAs(ALEX);
    const ids = await listOrderIds(token);

    const res = await getRaw(`/api/orders/${ids[0]}/spreadsheet`, token);
    expect(res.status).toBe(200);

    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const ws = wb.getWorksheet('Payment')!;
    const fields = new Set<string>();
    ws.eachRow((row) => fields.add(String(row.getCell(1).value ?? '')));

    for (const expected of [
      'Payment method', 'Subtotal (line costs)', 'Total cost',
      'Commission rate', 'Total quantity',
    ]) {
      expect(fields.has(expected)).toBe(true);
    }
  });

  it('lets a purchaser download their OWN PO', async () => {
    const { token } = await loginAs(MARCUS);
    const ids = await listOrderIds(token); // purchaser list is already own-scoped
    expect(ids.length).toBeGreaterThan(0);

    const res = await getRaw(`/api/orders/${ids[0]}/spreadsheet`, token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain(XLSX_MIME);
  });

  it("forbids a purchaser from downloading someone else's PO", async () => {
    const mgr = await loginAs(ALEX);
    const pur = await loginAs(MARCUS);
    const allIds = await listOrderIds(mgr.token);
    const ownIds = new Set(await listOrderIds(pur.token));
    const foreign = allIds.find((id) => !ownIds.has(id));
    expect(foreign).toBeTruthy();

    const res = await getRaw(`/api/orders/${foreign}/spreadsheet`, pur.token);
    expect(res.status).toBe(403);
  });

  it('404s an unknown PO', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/orders/PO-does-not-exist/spreadsheet', token);
    expect(res.status).toBe(404);
  });
});
