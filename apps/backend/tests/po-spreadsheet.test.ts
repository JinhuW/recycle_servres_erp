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
      'Projected sell value', 'Projected profit', 'Commission amount',
    ]) {
      expect(fields.has(expected)).toBe(true);
    }
  });

  it('includes sell price, sell total and profit per line item', async () => {
    const { token } = await loginAs(ALEX);
    // Seed lines carry a sell_price above unit_cost, so a non-draft PO yields a
    // positive projected profit and a non-null commission amount.
    const ids = await listOrderIds(token);

    const { default: ExcelJS } = await import('exceljs');
    // Find a PO whose line items have priced (non-empty) sell columns.
    let checked = false;
    for (const id of ids) {
      const res = await getRaw(`/api/orders/${id}/spreadsheet`, token);
      expect(res.status).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await res.arrayBuffer());

      const ws = wb.getWorksheet('Line items')!;
      const headers = ws.getRow(1).values as unknown[];
      for (const h of ['Sell price', 'Sell total', 'Profit']) {
        expect(headers).toContain(h);
      }

      const col = (name: string) => headers.indexOf(name);
      const qtyC = col('Qty'), costC = col('Unit cost');
      const sellC = col('Sell price'), sellTotC = col('Sell total'), profitC = col('Profit');

      const dataRow = ws.getRow(2);
      const sell = dataRow.getCell(sellC).value;
      if (typeof sell !== 'number') continue; // unpriced line — try another PO

      const qty = Number(dataRow.getCell(qtyC).value);
      const cost = Number(dataRow.getCell(costC).value);
      expect(Number(dataRow.getCell(sellTotC).value)).toBeCloseTo(qty * sell, 2);
      expect(Number(dataRow.getCell(profitC).value)).toBeCloseTo(qty * (sell - cost), 2);
      checked = true;
      break;
    }
    expect(checked).toBe(true);
  });

  it('carries the line chip number in a Chip # column', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM',
        warehouseId: 'WH-LA1',
        payment: 'company',
        lines: [{
          category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
          partNumber: 'M393A4K40DB3-CWE', chipNumber: 'K4A8G085WC-BCTD',
          condition: 'Pulled — Tested', qty: 2, unitCost: 60,
        }],
      },
    });
    expect(created.status).toBe(201);

    const res = await getRaw(`/api/orders/${created.body.id}/spreadsheet`, token);
    expect(res.status).toBe(200);

    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const ws = wb.getWorksheet('Line items')!;
    const headers = ws.getRow(1).values as unknown[];
    const chipC = headers.indexOf('Chip #');
    expect(chipC).toBeGreaterThan(0);
    expect(String(ws.getRow(2).getCell(chipC).value)).toBe('K4A8G085WC-BCTD');
  });

  it('splits a RAM PO into the full RAM spec columns', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM',
        warehouseId: 'WH-LA1',
        payment: 'company',
        lines: [{
          category: 'RAM', brand: 'Samsung', capacity: '32GB', generation: 'DDR4',
          type: 'Server', classification: 'RDIMM', rank: '2Rx4', speed: '3200',
          partNumber: 'M393A4K40DB3-CWE', chipNumber: 'K4A8G085WC-BCTD',
          serialNumber: 'SN-001, SN-002',
          condition: 'Pulled — Tested', qty: 4, unitCost: 60,
        }],
      },
    });
    expect(created.status).toBe(201);

    const res = await getRaw(`/api/orders/${created.body.id}/spreadsheet`, token);
    expect(res.status).toBe(200);

    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const ws = wb.getWorksheet('Line items')!;
    const headers = ws.getRow(1).values as unknown[];

    // Every RAM spec is its own column.
    for (const h of [
      'Part #', 'Chip #', 'Brand', 'Capacity', 'Gen', 'Type', 'Class',
      'Rank', 'Speed', 'Condition', 'Serial #', 'Qty', 'Unit cost',
    ]) {
      expect(headers, `missing column ${h}`).toContain(h);
    }
    // No composed label column — the attributes above replaced it outright.
    expect(headers).not.toContain('Item');
    // SSD/HDD-only columns must not leak onto a RAM sheet.
    for (const h of ['Interface', 'Form factor', 'Health %', 'RPM']) {
      expect(headers).not.toContain(h);
    }

    const row = ws.getRow(2);
    const cell = (name: string) => String(row.getCell(headers.indexOf(name)).value ?? '');
    expect(cell('Brand')).toBe('Samsung');
    expect(cell('Capacity')).toBe('32GB');
    expect(cell('Gen')).toBe('DDR4');
    expect(cell('Type')).toBe('Server');
    expect(cell('Class')).toBe('RDIMM');
    expect(cell('Rank')).toBe('2Rx4');
    expect(cell('Speed')).toBe('3200');
    expect(cell('Chip #')).toBe('K4A8G085WC-BCTD');
    expect(cell('Serial #')).toBe('SN-001, SN-002');
    expect(cell('Condition')).toBe('Pulled — Tested');
  });

  it("uses the SSD spec columns for an SSD PO", async () => {
    const { token } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'SSD',
        warehouseId: 'WH-LA1',
        payment: 'company',
        lines: [{
          category: 'SSD', brand: 'Intel', capacity: '1.92TB', interface: 'SATA',
          formFactor: '2.5"', health: 97, partNumber: 'SSDSC2KB019T8',
          condition: 'Pulled — Tested', qty: 3, unitCost: 85,
        }],
      },
    });
    expect(created.status).toBe(201);

    const res = await getRaw(`/api/orders/${created.body.id}/spreadsheet`, token);
    expect(res.status).toBe(200);

    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const ws = wb.getWorksheet('Line items')!;
    const headers = ws.getRow(1).values as unknown[];

    for (const h of ['Interface', 'Form factor', 'Health %']) {
      expect(headers, `missing column ${h}`).toContain(h);
    }
    for (const h of ['Chip #', 'Rank', 'Gen', 'RPM']) {
      expect(headers).not.toContain(h);
    }

    const row = ws.getRow(2);
    const cell = (name: string) => row.getCell(headers.indexOf(name)).value;
    expect(String(cell('Interface'))).toBe('SATA');
    expect(String(cell('Form factor'))).toBe('2.5"');
    expect(Number(cell('Health %'))).toBe(97);
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
