import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

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

describe('GET /api/orders/:id/invoice', () => {
  beforeEach(async () => { await resetDb(); });

  it('streams a PDF document for a manager', async () => {
    const { token } = await loginAs(ALEX);
    const ids = await listOrderIds(token);
    expect(ids.length).toBeGreaterThan(0);

    const res = await getRaw(`/api/orders/${ids[0]}/invoice`, token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('.pdf');

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-'); // valid PDF
    expect(buf.length).toBeGreaterThan(500);
  });

  it('lets a purchaser download their OWN PO', async () => {
    const { token } = await loginAs(MARCUS);
    const ids = await listOrderIds(token); // purchaser list is already own-scoped
    expect(ids.length).toBeGreaterThan(0);

    const res = await getRaw(`/api/orders/${ids[0]}/invoice`, token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
  });

  it("forbids a purchaser from downloading someone else's PO", async () => {
    const mgr = await loginAs(ALEX);
    const pur = await loginAs(MARCUS);
    const allIds = await listOrderIds(mgr.token);
    const ownIds = new Set(await listOrderIds(pur.token));
    const foreign = allIds.find((id) => !ownIds.has(id));
    expect(foreign).toBeTruthy(); // seed has POs owned by other users

    const res = await getRaw(`/api/orders/${foreign}/invoice`, pur.token);
    expect(res.status).toBe(403);
  });

  it('404s an unknown PO', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/orders/PO-does-not-exist/invoice', token);
    expect(res.status).toBe(404);
  });
});
