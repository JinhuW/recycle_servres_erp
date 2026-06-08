import { describe, it, expect, beforeEach, vi } from 'vitest';
import app from '../src/index';
import { resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

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

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  expect(r.status).toBe(200);
  expect(r.body.items.length).toBeGreaterThan(0);
  return r.body.items[0].id;
}

async function firstCustomerName(token: string): Promise<string> {
  const r = await api<{ items: { name: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].name;
}

async function createSellOrder(token: string): Promise<string> {
  const line = await freeSellableLine(token);
  const customerId = await firstCustomerId(token);
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: {
      customerId,
      lines: [{
        inventoryId: line.id, category: 'RAM', label: 'Sample DIMM',
        partNumber: 'PN-XLSX-1', qty: 2, unitPrice: line.sell_price,
        warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
      }],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

describe('GET /api/sell-orders/:id/spreadsheet', () => {
  beforeEach(async () => { await resetDb(); });

  it('streams an xlsx workbook for a manager', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createSellOrder(token);

    const res = await getRaw(`/api/sell-orders/${id}/spreadsheet`, token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain(XLSX_MIME);
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('.xlsx');
    // Filename carries the customer name so downloads are scannable by who.
    const customerName = await firstCustomerName(token);
    expect(disposition).toContain(customerName.replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '-'));

    const buf = Buffer.from(await res.arrayBuffer());
    // XLSX is a zip container — the magic bytes are 'PK'.
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(buf.length).toBeGreaterThan(500);
  });

  it('keeps a non-ASCII (Chinese) customer name in the download filename', async () => {
    const { token } = await loginAs(ALEX);
    const cnName = '深圳启航科技';
    const cust = await api<{ id: string }>('POST', '/api/customers', {
      token, body: { name: cnName },
    });
    expect(cust.status).toBe(201);

    const line = await freeSellableLine(token);
    const order = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId: cust.body.id,
        lines: [{
          inventoryId: line.id, category: 'RAM', label: 'Sample DIMM',
          partNumber: 'PN-CN-1', qty: 1, unitPrice: line.sell_price,
          warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
        }],
      },
    });
    expect(order.status).toBe(201);

    const res = await getRaw(`/api/sell-orders/${order.body.id}/spreadsheet`, token);
    expect(res.status).toBe(200);
    const disposition = res.headers.get('content-disposition') ?? '';
    // The \w-based slug used to strip every CJK character, dropping the customer
    // from the name entirely. The name now rides in the RFC 5987 filename*.
    expect(disposition).toContain(`filename*=UTF-8''`);
    expect(disposition).toContain(encodeURIComponent(cnName));
  });

  it('renders Price in native RMB for a CNY order', async () => {
    // Frankfurter is stubbed so the snapshot rate is deterministic.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ amount: 1, base: 'USD', date: '2026-06-07', rates: { CNY: 7.2154 } }),
      { status: 200 },
    )));
    try {
      const { token } = await loginAs(ALEX);
      const line = await freeSellableLine(token);
      const customerId = await firstCustomerId(token);
      const create = await api<{ id: string }>('POST', '/api/sell-orders', {
        token,
        body: {
          customerId,
          currency: 'CNY',
          lines: [{
            inventoryId: line.id, category: 'RAM', label: 'RMB DIMM',
            partNumber: 'PN-RMB-1', qty: 3, unitPrice: 78, warehouseId: 'WH-LA1',
          }],
        },
      });
      expect(create.status).toBe(201);

      const res = await getRaw(`/api/sell-orders/${create.body.id}/spreadsheet`, token);
      expect(res.status).toBe(200);

      const { default: ExcelJS } = await import('exceljs');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await res.arrayBuffer());
      const ws = wb.getWorksheet('Summary')!;
      const headers = (ws.getRow(1).values as unknown[]).map((v) => String(v ?? ''));
      const priceCol = headers.indexOf('Price');
      const currencyCol = headers.indexOf('Currency');
      const totalCol = headers.indexOf('Line total');
      expect(priceCol).toBeGreaterThan(0);

      const row = ws.getRow(2);
      // Native RMB price, not the ~10.81 USD conversion.
      expect(Number(row.getCell(priceCol).value)).toBe(78);
      expect(String(row.getCell(currencyCol).value)).toBe('CNY');
      expect(Number(row.getCell(totalCol).value)).toBe(234); // 3 × 78 RMB
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('404s an unknown sell order', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/sell-orders/SO-does-not-exist/spreadsheet', token);
    expect(res.status).toBe(404);
  });

  it('forbids a non-manager', async () => {
    const mgr = await loginAs(ALEX);
    const id = await createSellOrder(mgr.token);

    const pur = await loginAs(MARCUS);
    const res = await getRaw(`/api/sell-orders/${id}/spreadsheet`, pur.token);
    expect(res.status).toBe(403);
  });
});
