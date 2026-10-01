import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';
import { syncBankTransactions } from '../src/banktx/sync';
import { stubPaypalProvider } from '../src/banktx/stub';

const LINE = {
  category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
  classification: 'RDIMM', speed: '3200', partNumber: 'PAY-1',
  condition: 'Pulled — Tested', qty: 1, unitCost: 50,
};

async function createOrder(token: string, body: Record<string, unknown> = {}) {
  return api<{ id: string; error?: string }>('POST', '/api/orders', {
    token, body: { category: 'RAM', warehouseId: 'WH-LA1', lines: [LINE], ...body },
  });
}

// Every proof rule on the way out of Draft keys on 'company' or 'self'; a
// third value used to slip past all of them.
describe('orders.payment is company or self at every door', () => {
  beforeEach(async () => { await resetDb(); });

  it('refuses another value on create, draft, PATCH and handoff', async () => {
    const { token } = await loginAs(MARCUS);
    expect((await createOrder(token, { payment: 'cash' })).status).toBe(400);
    expect((await api('POST', '/api/orders/draft', { token, body: { payment: 'cash' } })).status).toBe(400);

    const ok = await createOrder(token, { payment: 'company' });
    expect(ok.status).toBe(201);
    const id = ok.body.id;
    expect((await api('PATCH', `/api/orders/${id}`, { token, body: { payment: 'cash' } })).status).toBe(400);
    expect((await api('POST', `/api/orders/${id}/handoff`, { token, body: { payment: 'cash' } })).status).toBe(400);
  });

  it('is enforced by the database too', async () => {
    const { token } = await loginAs(MARCUS);
    const { body } = await createOrder(token, { payment: 'self' });
    await expect(
      getTestDb()`UPDATE orders SET payment = 'cash' WHERE id = ${body.id}`,
    ).rejects.toThrow(/orders_payment_ck/);
  });
});

// bank_transactions.order_id is ON DELETE SET NULL, but the paired link CHECKs
// then failed the whole DELETE — a draft with a linked payment 500'd forever.
describe('DELETE /api/orders/:id with a linked bank transaction', () => {
  beforeEach(async () => { await resetDb(); });

  it('deletes the draft and leaves the payment unlinked', async () => {
    await syncBankTransactions(testEnv, [stubPaypalProvider()]);
    const { token } = await loginAs(MARCUS);
    const { body } = await createOrder(token, { payment: 'company' });
    const txn = '7AB12345CD678901E';
    expect((await api('PATCH', `/api/orders/${body.id}`, { token, body: { paypalTxnId: txn } })).status).toBe(200);

    const sql = getTestDb();
    const [linked] = await sql<{ order_id: string | null }[]>`
      SELECT order_id FROM bank_transactions WHERE source = 'paypal' AND paypal_txn_id = ${txn}
    `;
    expect(linked.order_id).toBe(body.id);

    const r = await api('DELETE', `/api/orders/${body.id}`, { token });
    expect(r.status).toBe(200);
    const [after] = await sql<{ order_id: string | null; linked_at: Date | null; link_kind: string | null }[]>`
      SELECT order_id, linked_at, link_kind FROM bank_transactions
      WHERE source = 'paypal' AND paypal_txn_id = ${txn}
    `;
    expect(after).toEqual({ order_id: null, linked_at: null, link_kind: null });
  });
});
