import { describe, it, expect, beforeEach } from 'vitest';
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
    expect(res.headers.get('content-disposition')).toContain('.xlsx');

    const buf = Buffer.from(await res.arrayBuffer());
    // XLSX is a zip container — the magic bytes are 'PK'.
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(buf.length).toBeGreaterThan(500);
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
