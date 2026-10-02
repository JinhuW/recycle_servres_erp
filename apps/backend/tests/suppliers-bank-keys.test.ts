import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { NOW, DAY, fakeProvider } from './helpers/bankProvider';
import { syncBankTransactions } from '../src/banktx/sync';

const idOf = async (externalId: string) =>
  (await getTestDb()<{ id: string }[]>`SELECT id FROM bank_transactions WHERE external_id = ${externalId}`)[0].id;

async function createPO(token: string): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token, body: { category: 'RAM', lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

describe('supplier name keys', () => {
  beforeEach(async () => { await resetDb(); });

  // Every non-Latin name compressed to '' and collided with every other one.
  it('keeps names in other scripts apart, and still catches a real duplicate', async () => {
    const { token } = await loginAs(MARCUS);
    const make = (name: string) => api('POST', '/api/suppliers', { token, body: { name, zip: '80216' } });
    expect((await make('王记电子')).status).toBe(201);
    expect((await make('李氏回收')).status).toBe(201);
    expect((await make(' 王记电子 ')).status).toBe(409);
    expect((await make('Acme Recycling')).status).toBe(201);
    expect((await make('ACME-recycling')).status).toBe(409);
    const keys = await getTestDb()<{ match_key: string }[]>`
      SELECT match_key FROM suppliers WHERE name IN ('王记电子', '李氏回收', 'Acme Recycling') ORDER BY match_key`;
    expect(keys.map((k) => k.match_key)).toEqual(['ACMERECYCLING|80216', 'U:李氏回收|80216', 'U:王记电子|80216']);
  });
});

describe('ungrouping a pair', () => {
  beforeEach(async () => { await resetDb(); });

  it('leaves the PO link on the PayPal leg only', async () => {
    const { token } = await loginAs(ALEX);
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [{ externalId: '9ZY87654WV321012K', amount: -310, postedAt: new Date(NOW - 2 * DAY) }]),
      fakeProvider('mercury', [{ externalId: 'm-ug', amount: -310, postedAt: new Date(NOW - DAY), description: 'PAYPAL *SELLER' }]),
    ]);
    const p = await idOf('9ZY87654WV321012K');
    const m = await idOf('m-ug');
    const po = await createPO(token);
    expect((await api('POST', `/api/bank-transactions/${p}/link`, { token, body: { orderId: po } })).status).toBe(200);
    const linked = await getTestDb()<{ id: string; order_id: string | null }[]>`
      SELECT id, order_id FROM bank_transactions WHERE id IN (${p}, ${m})`;
    expect(linked.every((r) => r.order_id === po)).toBe(true);

    expect((await api('POST', `/api/bank-transactions/${p}/unpair`, { token })).status).toBe(200);
    const after = new Map((await getTestDb()<{ id: string; order_id: string | null; pair_id: string | null }[]>`
      SELECT id, order_id, pair_id FROM bank_transactions WHERE id IN (${p}, ${m})`).map((r) => [r.id, r]));
    expect(after.get(p)).toMatchObject({ order_id: po, pair_id: null });
    expect(after.get(m)).toMatchObject({ order_id: null, pair_id: null });
  });
});

describe('a payment in another currency', () => {
  beforeEach(async () => { await resetDb(); });

  it('is not paired, not linkable, and says so in the feed', async () => {
    const { token } = await loginAs(ALEX);
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [{ externalId: '8XK42345CD678901F', amount: -50, currency: 'EUR', postedAt: new Date(NOW - 2 * DAY) }]),
      fakeProvider('mercury', [{ externalId: 'm-eur', amount: -50, postedAt: new Date(NOW - DAY), description: 'PAYPAL *EUSELLER' }]),
    ]);
    const p = await idOf('8XK42345CD678901F');
    const rows = await getTestDb()<{ pair_id: string | null; currency: string }[]>`
      SELECT pair_id, currency FROM bank_transactions WHERE id = ${p}`;
    expect(rows[0]).toEqual({ pair_id: null, currency: 'EUR' });
    const po = await createPO(token);
    expect((await api('POST', `/api/bank-transactions/${p}/link`, { token, body: { orderId: po } })).status).toBe(400);
    expect((await api('POST', `/api/bank-transactions/${p}/pair`, { token, body: { otherId: await idOf('m-eur') } })).status).toBe(400);
    const feed = await api<{ rows: { id: string; currency?: string }[] }>('GET', '/api/bank-transactions', { token });
    expect(feed.body.rows.find((r) => r.id === p)?.currency).toBe('EUR');
  });
});

describe('0152: PO-1383 legs', () => {
  beforeEach(async () => { await resetDb(); });

  it('groups exactly those two legs, once', async () => {
    const db = getTestDb();
    const [acct] = await db<{ id: string }[]>`
      INSERT INTO bank_accounts (source, external_id, name) VALUES ('mercury', 'mig-acct', 'x') RETURNING id`;
    await db`
      INSERT INTO orders (id, user_id, category, lifecycle)
      SELECT 'PO-1383', id, 'RAM', 'done' FROM users WHERE role = 'manager' LIMIT 1
      ON CONFLICT (id) DO NOTHING`;
    for (const [id, source] of [['851ce964-46da-48d0-9ccd-ada3e41f2ed0', 'mercury'], ['9f565f0e-3330-495d-a44e-545890d3f51e', 'paypal']]) {
      await db`
        INSERT INTO bank_transactions (id, source, external_id, account_id, posted_at, amount, raw, order_id, link_kind, linked_at)
        VALUES (${id}, ${source}, ${'mig-' + source}, ${acct.id}, NOW(), -2800, '{}'::jsonb, 'PO-1383', 'payment', NOW())`;
    }
    const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../migrations/0152_pair_po_1383_legs.sql'), 'utf8');
    await db.unsafe(sql);
    const legs = await db<{ pair_id: string | null }[]>`
      SELECT pair_id FROM bank_transactions WHERE order_id = 'PO-1383' AND external_id LIKE 'mig-%'`;
    expect(legs).toHaveLength(2);
    expect(legs[0].pair_id).toBeTruthy();
    expect(legs[0].pair_id).toBe(legs[1].pair_id);
    await db.unsafe(sql);
    const again = await db<{ pair_id: string }[]>`
      SELECT DISTINCT pair_id FROM bank_transactions WHERE order_id = 'PO-1383' AND external_id LIKE 'mig-%'`;
    expect(again).toHaveLength(1);
  });
});
