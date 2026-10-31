import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('commission transaction search and receipt amounts', () => {
  let alex: Awaited<ReturnType<typeof loginAs>>;
  beforeEach(async () => { await resetDb(); alex = await loginAs(ALEX); });
  afterEach(() => vi.unstubAllGlobals());

  const po = async () => {
    const r = await api<{ id: string }>('POST', '/api/orders', { token: alex.token, body: {
      category: 'RAM', lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }],
    } });
    expect(r.status).toBe(201);
    return r.body.id;
  };
  const entry = async (over: Record<string, unknown> = {}) => {
    const r = await api<{ id: string }>('POST', '/api/accounting/entries', { token: alex.token, body: {
      direction: 'out', kind: 'other', amount: 1250, currency: 'CNY', method: 'alipay',
      occurredOn: '2026-10-05', managerId: alex.user.id, counterparty: 'Commission receipt', ...over,
    } });
    expect(r.status).toBe(201);
    return r.body.id;
  };
  const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'receipt.png', { type: 'image/png' });
  const model = (data: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(data) } }],
  }), { status: 200 })));
  const scan = (token = alex.token) => multipart('/api/accounting/scan-receipt', { file: png() }, {
    token, env: { OPENROUTER_API_KEY: 'test-key' },
  });

  it('reads the amount and currency before an entry exists, without saving money or evidence', async () => {
    model({ method: 'alipay', amount: '￥１，２５０', currency: 'CNY' });
    const r = await scan();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      receipt: { method: 'alipay', amount: '1250.00', currency: 'CNY' },
      filename: expect.stringMatching(/^\d{4}-\d{2}-\d{2}-alipay-1250\.00\.png$/),
    });
    expect((await getTestDb()`SELECT COUNT(*)::int AS n FROM accounting_entries`)[0].n).toBe(0);
    model({ method: 'bank', amount: '100.50', currency: 'USD' });
    expect((await scan()).body).toMatchObject({ receipt: { amount: '100.50', currency: 'USD' } });
  });

  it('keeps unclear currencies and unreadable amounts from becoming trusted autofill values', async () => {
    model({ method: 'bank', amount: '1250.00', currency: 'EUR' });
    expect((await scan()).body).toMatchObject({ receipt: { currency: null } });
    model({ method: 'bank', amount: '1.2.3', currency: 'CNY' });
    expect((await scan()).body).toEqual({ receipt: null, filename: null });
    expect((await multipart('/api/accounting/scan-receipt', { file: png() }, { token: alex.token })).body)
      .toEqual({ receipt: null, filename: null });
  });

  it('gates receipt recognition on manager access and image upload limits', async () => {
    const purchaser = await loginAs(MARCUS);
    expect((await scan(purchaser.token)).status).toBe(403);
    expect((await multipart('/api/accounting/scan-receipt', { file: png() })).status).toBe(401);
    const pdf = new File(['%PDF'], 'receipt.pdf', { type: 'application/pdf' });
    expect((await multipart('/api/accounting/scan-receipt', { file: pdf }, { token: alex.token })).status).toBe(415);
    const large = new File([new Uint8Array(21 * 1024 * 1024)], 'large.png', { type: 'image/png' });
    expect((await multipart('/api/accounting/scan-receipt', { file: large }, { token: alex.token })).status).toBe(413);
  });

  it('finds an unlinked payment, links it to the commission, and refuses to take it for another PO', async () => {
    const orderId = await po();
    const id = await entry();
    const incoming = await entry({ direction: 'in' });
    const voided = await entry();
    await api('POST', `/api/accounting/entries/${voided}/void`, { token: alex.token, body: { reason: 'duplicate' } });
    const list = () => api<{ rows: { id: string }[] }>('GET', '/api/accounting/entries?unlinked=1&direction=out&q=Commission', { token: alex.token });
    expect((await list()).body.rows.map(e => e.id)).toEqual([id]);
    expect(incoming).not.toBe(id);
    const linked = await api('PATCH', `/api/accounting/entries/${id}`, { token: alex.token,
      body: { kind: 'commission', targetId: orderId, onlyUnlinked: true } });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ commissionPaidBy: { kind: 'manager', id: alex.user.id } });
    expect((await list()).body.rows).toEqual([]);
    const other = await po();
    const stale = await api('PATCH', `/api/accounting/entries/${id}`, { token: alex.token,
      body: { kind: 'commission', targetId: other, onlyUnlinked: true } });
    expect(stale.status).toBe(409);
    expect((await getTestDb()`SELECT order_id FROM accounting_entries WHERE id = ${id}`)[0].order_id).toBe(orderId);
  });

  it('refuses a receipt whose amount changed after the transaction search', async () => {
    const orderId = await po();
    const id = await entry();
    const before = await api<{ entry: { review: { version: string } } }>('GET', `/api/accounting/entries/${id}`, { token: alex.token });
    await api('PATCH', `/api/accounting/entries/${id}`, { token: alex.token, body: { amount: 999 } });
    const r = await api('PATCH', `/api/accounting/entries/${id}`, { token: alex.token, body: {
      kind: 'commission', targetId: orderId, onlyUnlinked: true, expectedVersion: before.body.entry.review.version,
    } });
    expect(r.status).toBe(409);
    expect((await getTestDb()`SELECT order_id FROM accounting_entries WHERE id = ${id}`)[0].order_id).toBeNull();
  });

  it('replaces a legacy company payer flag when a manager explicitly links an RMB payment', async () => {
    const orderId = await po();
    await api('PUT', `/api/orders/${orderId}/commission-paid-by`, { token: alex.token, body: { company: true } });
    const id = await entry();
    const r = await api('PATCH', `/api/accounting/entries/${id}`, { token: alex.token,
      body: { kind: 'commission', targetId: orderId, onlyUnlinked: true } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ commissionPaidBy: { kind: 'manager', id: alex.user.id } });
    const row = (await getTestDb()`SELECT commission_paid_by, commission_paid_by_company FROM orders WHERE id = ${orderId}`)[0];
    expect(row).toMatchObject({ commission_paid_by: alex.user.id, commission_paid_by_company: false });
  });
});
