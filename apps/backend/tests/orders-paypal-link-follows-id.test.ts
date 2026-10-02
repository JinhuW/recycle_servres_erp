import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { NOW, DAY, fakeProvider } from './helpers/bankProvider';
import { linkPaypalTxnToOrder, syncBankTransactions } from '../src/banktx/sync';

// A PO's PayPal transaction id is what links its payments. The link has to
// follow the id: a corrected or cleared id lets the old payments go, and an id
// only links onto a live company-card PO that is the one PO carrying it.

const TXN_A = '7AB12345CD678901E';
const TXN_B = '9ZZ00000AA111111B';

async function seed(): Promise<void> {
  await syncBankTransactions(testEnv, [
    fakeProvider('paypal', [
      { externalId: TXN_A, amount: -1240, postedAt: new Date(NOW - 3 * DAY) },
      { externalId: TXN_B, amount: -300, postedAt: new Date(NOW - 3 * DAY) },
    ]),
    fakeProvider('mercury', [
      { externalId: 'm-settle', amount: -1240, paypalTxnId: TXN_A, postedAt: new Date(NOW - 2 * DAY) },
    ]),
  ]);
}

async function createPO(token: string, payment: 'company' | 'self' = 'company'): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      category: 'RAM', warehouseId: 'WH-LA1', payment,
      lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

const patch = (token: string, id: string, body: Record<string, unknown>) =>
  api<{ error?: string }>('PATCH', `/api/orders/${id}`, { token, body });

async function linkedTo(id: string): Promise<string[]> {
  const rows = await getTestDb()`
    SELECT external_id FROM bank_transactions WHERE order_id = ${id} ORDER BY external_id`;
  return rows.map((r) => r.external_id as string);
}

describe('PayPal links follow the PO transaction id', () => {
  beforeEach(async () => { await resetDb(); });

  it('a corrected id lets the old payment go, pair included, and claims the new one', async () => {
    await seed();
    const { token } = await loginAs(MARCUS);
    const id = await createPO(token);
    expect((await patch(token, id, { paypalTxnId: TXN_A })).status).toBe(200);
    expect(await linkedTo(id)).toEqual([TXN_A, 'm-settle'].sort());

    expect((await patch(token, id, { paypalTxnId: TXN_B })).status).toBe(200);
    expect(await linkedTo(id)).toEqual([TXN_B]);
    // Freed, not tombstoned: the next PO to carry the id should still get it.
    const freed = await getTestDb()`
      SELECT order_id, link_kind, linked_by, linked_at, no_auto_link FROM bank_transactions
      WHERE external_id IN (${TXN_A}, 'm-settle')`;
    expect(freed.every((r) => r.order_id === null && r.link_kind === null
      && r.linked_by === null && r.linked_at === null && r.no_auto_link === false)).toBe(true);

    const other = await createPO(token);
    expect((await patch(token, other, { paypalTxnId: TXN_A })).status).toBe(200);
    expect(await linkedTo(other)).toEqual([TXN_A, 'm-settle'].sort());
  });

  it('clearing the id, or a flip to Self, unlinks it', async () => {
    await seed();
    const { token } = await loginAs(MARCUS);
    const cleared = await createPO(token);
    await patch(token, cleared, { paypalTxnId: TXN_A });
    expect((await patch(token, cleared, { paypalTxnId: null })).status).toBe(200);
    expect(await linkedTo(cleared)).toEqual([]);

    const flipped = await createPO(token);
    await patch(token, flipped, { paypalTxnId: TXN_B });
    expect(await linkedTo(flipped)).toEqual([TXN_B]);
    expect((await patch(token, flipped, { payment: 'self' })).status).toBe(200);
    expect(await linkedTo(flipped)).toEqual([]);
  });

  it("a manager's /link stays when the purchaser re-types the id", async () => {
    await seed();
    const { token: mgr } = await loginAs(ALEX);
    const { token } = await loginAs(MARCUS);
    const id = await createPO(token);
    const [settle] = await getTestDb()`SELECT id FROM bank_transactions WHERE external_id = 'm-settle'`;
    const link = await api('POST', `/api/bank-transactions/${settle.id}/link`, {
      token: mgr, body: { orderId: id },
    });
    expect(link.status).toBe(200);
    expect(await linkedTo(id)).toEqual([TXN_A, 'm-settle'].sort());

    expect((await patch(token, id, { paypalTxnId: TXN_B })).status).toBe(200);
    expect(await linkedTo(id)).toEqual([TXN_A, TXN_B, 'm-settle'].sort());
  });

  it('a hand-off with a different id unlinks the one the Draft had saved', async () => {
    await seed();
    const { token, user } = await loginAs(MARCUS);
    const id = await createPO(token);
    await patch(token, id, { paymentMethod: 'paypal', paypalTxnId: TXN_A });
    expect(await linkedTo(id)).toEqual([TXN_A, 'm-settle'].sort());

    const r = await api('POST', `/api/orders/${id}/handoff`, {
      token, body: {
        warehouseId: 'WH-LA1', source: 'other', handoff: { method: 'pickup', byUserId: user.id },
        payment: 'company', paymentMethod: 'paypal', paypalTxnId: TXN_B,
      },
    });
    expect(r.status).toBe(200);
    expect(await linkedTo(id)).toEqual([TXN_B]);
  });

  it('a hand-off as cash unlinks the saved id', async () => {
    await seed();
    const { token, user } = await loginAs(MARCUS);
    const id = await createPO(token);
    await patch(token, id, { paymentMethod: 'paypal', paypalTxnId: TXN_A });
    const shot = await multipart(`/api/orders/${id}/status-meta/Payment/attachments`,
      { file: new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'cash.png', { type: 'image/png' }) },
      { token });
    expect(shot.status).toBe(200);
    const r = await api('POST', `/api/orders/${id}/handoff`, {
      token, body: {
        warehouseId: 'WH-LA1', source: 'other', handoff: { method: 'pickup', byUserId: user.id },
        payment: 'company', paymentMethod: 'cash',
      },
    });
    expect(r.status).toBe(200);
    expect(await linkedTo(id)).toEqual([]);
  });
});

describe('which POs an id may link onto', () => {
  beforeEach(async () => { await resetDb(); });

  it('a self-paid PO carrying an id links nothing', async () => {
    await seed();
    const { token } = await loginAs(MARCUS);
    const id = await createPO(token, 'self');
    expect((await patch(token, id, { paypalTxnId: TXN_A })).status).toBe(200);
    expect(await linkedTo(id)).toEqual([]);
  });

  it('a cash or archived PO links nothing; a NULL method still links', async () => {
    await seed();
    const { token } = await loginAs(MARCUS);
    const sql = getTestDb();
    const cash = await createPO(token);
    await sql`UPDATE orders SET payment_method = 'cash', paypal_txn_id = ${TXN_A} WHERE id = ${cash}`;
    expect(await linkPaypalTxnToOrder(sql, TXN_A, cash, null)).toBe(0);

    const archived = await createPO(token);
    await sql`UPDATE orders SET paypal_txn_id = NULL WHERE id = ${cash}`;
    await sql`UPDATE orders SET paypal_txn_id = ${TXN_A}, archived_at = NOW() WHERE id = ${archived}`;
    expect(await linkPaypalTxnToOrder(sql, TXN_A, archived, null)).toBe(0);

    const scanned = await createPO(token);
    await sql`UPDATE orders SET paypal_txn_id = ${TXN_A} WHERE id = ${scanned}`;
    expect(await linkPaypalTxnToOrder(sql, TXN_A, scanned, null)).toBe(1);
  });

  it('an id another live PO carries links neither; an archived holder does not contest it', async () => {
    await seed();
    const { token } = await loginAs(MARCUS);
    const sql = getTestDb();
    const first = await createPO(token);
    await sql`UPDATE orders SET paypal_txn_id = ${TXN_A} WHERE id = ${first}`;
    const second = await createPO(token);
    expect((await patch(token, second, { paypalTxnId: TXN_A })).status).toBe(200);
    expect(await linkedTo(second)).toEqual([]);

    await sql`UPDATE orders SET archived_at = NOW() WHERE id = ${first}`;
    expect((await patch(token, second, { paypalTxnId: TXN_A })).status).toBe(200);
    expect(await linkedTo(second)).toEqual([TXN_A, 'm-settle'].sort());
  });

  it('the sync pass ignores an archived PO, and links the live one it leaves alone', async () => {
    const { token } = await loginAs(MARCUS);
    const sql = getTestDb();
    const archived = await createPO(token);
    const live = await createPO(token);
    await sql`UPDATE orders SET paypal_txn_id = ${TXN_A}, archived_at = NOW() WHERE id = ${archived}`;
    await sql`UPDATE orders SET paypal_txn_id = ${TXN_B}, archived_at = NOW() WHERE id = ${live}`;
    await seed();
    expect(await linkedTo(archived)).toEqual([]);
    expect(await linkedTo(live)).toEqual([]);

    await sql`UPDATE orders SET archived_at = NULL WHERE id = ${live}`;
    const other = await createPO(token);
    await sql`UPDATE orders SET paypal_txn_id = ${TXN_A} WHERE id = ${other}`;
    await seed();
    expect(await linkedTo(live)).toEqual([TXN_B]);
    expect(await linkedTo(other)).toEqual([TXN_A, 'm-settle'].sort());
  });
});
