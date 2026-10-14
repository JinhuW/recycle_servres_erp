// A bank row links to one of three targets: a PO's cost, a PO's commission or
// a sell order. These cover the two newer ones and the seams between them —
// the PO's paid figure, pairing, the guards that read "linked".
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { NOW, DAY, fakeProvider } from './helpers/bankProvider';
import { freeSellableLine } from './helpers/inventory';
import { createSellOrderOn } from './helpers/fixtures';
import { syncBankTransactions } from '../src/banktx/sync';

const TXN_IN = '9IN12345CD678901E';

type Ledger = { payments: { amount: number; linkKind: string }[]; net: number };
type Row = {
  id: string; orderId: string | null; sellOrderId: string | null; sellOrderTotal: number | null;
  linkKind: string | null; legs: { externalId: string }[];
};

async function seed(): Promise<void> {
  await syncBankTransactions(testEnv, [
    fakeProvider('paypal', [
      // Money in: a buyer paying, settled through Mercury a day later.
      { externalId: TXN_IN, amount: 90, counterparty: 'Buyer Co', postedAt: new Date(NOW - 3 * DAY) },
      { externalId: 'p-lone', amount: 200, counterparty: 'Other Buyer', postedAt: new Date(NOW - 4 * DAY) },
    ]),
    fakeProvider('mercury', [
      { externalId: 'm-in', amount: 90, paypalTxnId: TXN_IN, postedAt: new Date(NOW - 2 * DAY) },
      { externalId: 'm-refund-out', amount: -30, counterparty: 'Buyer Co', postedAt: new Date(NOW - 1 * DAY) },
      { externalId: 'm-commission', amount: -50, counterparty: 'Marcus', postedAt: new Date(NOW - 1 * DAY) },
      { externalId: 'm-lone', amount: 200, counterparty: 'Other Buyer', postedAt: new Date(NOW - 4 * DAY) },
    ]),
  ]);
}

async function idOf(externalId: string): Promise<string> {
  const rows = await getTestDb()`SELECT id FROM bank_transactions WHERE external_id = ${externalId}`;
  expect(rows).toHaveLength(1);
  return rows[0].id as string;
}

async function createPO(token: string): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: { category: 'RAM', lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

async function createSO(token: string): Promise<string> {
  const line = await freeSellableLine(token, 1);
  return createSellOrderOn(token, line.id, 'PN-1', 1, 90);
}

const link = (token: string, txnId: string, body: Record<string, unknown>) =>
  api<{ ok: boolean; linkKind: string; orderId: string | null; sellOrderId: string | null; orderTxnFilled: boolean; error?: string }>(
    'POST', `/api/bank-transactions/${txnId}/link`, { token, body });

describe('bank transactions: sell-order and commission links', () => {
  beforeEach(async () => { await resetDb(); });

  it('links a sell order on every leg, by sign, and the ledger nets it', async () => {
    await seed();
    const { token } = await loginAs(ALEX);
    const soId = await createSO(token);
    const db = getTestDb();

    const paid = await link(token, await idOf('m-in'), { sellOrderId: soId });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ linkKind: 'payment', sellOrderId: soId, orderId: null, orderTxnFilled: false });
    const legs = await db`SELECT external_id, order_id, sell_order_id, link_kind FROM bank_transactions WHERE sell_order_id = ${soId}`;
    expect(legs.map((l) => l.external_id).sort()).toEqual([TXN_IN, 'm-in']);
    expect(legs.every((l) => l.order_id === null && l.link_kind === 'payment')).toBe(true);

    // Money back to the buyer is the sell order's refund.
    const refund = await link(token, await idOf('m-refund-out'), { sellOrderId: soId });
    expect(refund.body.linkKind).toBe('refund');

    const ledger = await api<Ledger>('GET', `/api/bank-transactions/by-sell-order/${soId}`, { token });
    expect(ledger.status).toBe(200);
    expect(ledger.body.payments.map((p) => p.linkKind).sort()).toEqual(['payment', 'refund']);
    expect(ledger.body.net).toBe(60);

    // The feed pins to it, reads it as linked, and carries the SO's total.
    const pinned = await api<{ rows: Row[] }>('GET', `/api/bank-transactions?sellOrderId=${soId}`, { token });
    expect(pinned.body.rows).toHaveLength(2);
    const row = pinned.body.rows.find((r) => r.linkKind === 'payment')!;
    expect(row).toMatchObject({ sellOrderId: soId, orderId: null, sellOrderTotal: 90 });
    const linked = await api<{ rows: Row[] }>('GET', '/api/bank-transactions?status=linked&direction=all', { token });
    expect(linked.body.rows.map((r) => r.sellOrderId)).toEqual([soId, soId]);
    const stats = await api<{ linked: { count: number }; refunds: { count: number; amount: number } }>(
      'GET', '/api/bank-transactions/stats', { token });
    expect(stats.body.linked.count).toBe(2);
    // The Refunds tile is PO refunds (money in) and opens that list; the
    // sell order's refund is money out and stays off it.
    expect(stats.body.refunds).toEqual({ count: 0, amount: 0 });

    // The guards that read "linked" see it.
    const assign = await api<{ error: string }>('POST', `/api/bank-transactions/${await idOf('m-in')}/assign`,
      { token, body: { userId: (await db`SELECT id FROM users WHERE role = 'manager' AND active LIMIT 1`)[0].id } });
    expect(assign.status).toBe(400);
    const ignore = await api('POST', `/api/bank-transactions/${await idOf('m-in')}/ignore`, { token });
    expect(ignore.status).toBe(400);
    const transfer = await api('POST', `/api/bank-transactions/${await idOf('m-in')}/mark-transfer`, { token });
    expect(transfer.status).toBe(400);
    const untouched = await db`SELECT category, assignee_id FROM bank_transactions WHERE external_id = 'm-in'`;
    expect(untouched[0]).toMatchObject({ category: 'external', assignee_id: null });

    const unlink = await api('POST', `/api/bank-transactions/${await idOf('m-in')}/unlink`, { token });
    expect(unlink.status).toBe(200);
    const after = await db`SELECT sell_order_id, linked_at, no_auto_link FROM bank_transactions WHERE external_id IN (${TXN_IN}, 'm-in')`;
    expect(after.every((l) => l.sell_order_id === null && l.linked_at === null && l.no_auto_link === true)).toBe(true);
  });

  it('refuses two targets, a missing, archived or closed sell order', async () => {
    await seed();
    const { token } = await loginAs(ALEX);
    const poId = await createPO(token);
    const soId = await createSO(token);
    const txn = await idOf('m-in');

    expect((await link(token, txn, { orderId: poId, sellOrderId: soId })).status).toBe(400);
    expect((await link(token, txn, {})).status).toBe(400);
    expect((await link(token, txn, { sellOrderId: 'SO-999999' })).status).toBe(404);
    expect((await link(token, txn, { sellOrderId: soId, kind: 'commission' })).status).toBe(400);

    await getTestDb()`UPDATE sell_orders SET status = 'Closed' WHERE id = ${soId}`;
    expect((await link(token, txn, { sellOrderId: soId })).status).toBe(409);
    await getTestDb()`UPDATE sell_orders SET status = 'Draft', archived_at = NOW() WHERE id = ${soId}`;
    expect((await link(token, txn, { sellOrderId: soId })).status).toBe(409);
  });

  it('a commission link sits beside the cost link and never counts as cost paid', async () => {
    await seed();
    const { token } = await loginAs(ALEX);
    const poId = await createPO(token);
    const db = getTestDb();

    const r = await link(token, await idOf('m-commission'), { orderId: poId, kind: 'commission' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ linkKind: 'commission', orderId: poId, orderTxnFilled: false });

    // The PO reads nothing paid toward its cost.
    const detail = await api<{ order: { linkedPaid: number | null; paypalTxnId: string | null } }>(
      'GET', `/api/orders/${poId}`, { token });
    expect(detail.body.order.linkedPaid).toBeNull();
    const cost = await api<Ledger>('GET', `/api/bank-transactions/by-order/${poId}`, { token });
    expect(cost.body.payments).toHaveLength(0);
    const commission = await api<Ledger>('GET', `/api/bank-transactions/by-order/${poId}?kind=commission`, { token });
    expect(commission.body.payments.map((p) => p.linkKind)).toEqual(['commission']);
    expect(commission.body.net).toBe(-50);

    // A PayPal leg linked as commission does not become the PO's transaction id.
    const paired = await link(token, await idOf('m-in'), { orderId: poId, kind: 'commission' });
    expect(paired.body.orderTxnFilled).toBe(false);
    const [po] = await db`SELECT paypal_txn_id FROM orders WHERE id = ${poId}`;
    expect(po.paypal_txn_id).toBeNull();

    // Both kinds show on the pinned PO view, told apart by their kind.
    const pinned = await api<{ rows: Row[] }>('GET', `/api/bank-transactions?orderId=${poId}`, { token });
    expect(pinned.body.rows.map((x) => x.linkKind)).toEqual(['commission', 'commission']);

    expect((await link(token, await idOf('m-refund-out'), { orderId: poId, kind: 'bogus' })).status).toBe(400);
  });

  it('grouping carries a sell-order link across the pair and ungrouping takes it back', async () => {
    await seed();
    const { token } = await loginAs(ALEX);
    const soId = await createSO(token);
    const db = getTestDb();
    const p = await idOf('p-lone');
    const m = await idOf('m-lone');

    expect((await link(token, p, { sellOrderId: soId })).status).toBe(200);
    const pair = await api('POST', `/api/bank-transactions/${p}/pair`, { token, body: { otherId: m } });
    expect(pair.status).toBe(200);
    const legs = await db`SELECT external_id, sell_order_id, link_kind FROM bank_transactions WHERE external_id IN ('p-lone', 'm-lone')`;
    expect(legs.every((l) => l.sell_order_id === soId && l.link_kind === 'payment')).toBe(true);

    expect((await api('POST', `/api/bank-transactions/${p}/unpair`, { token })).status).toBe(200);
    const after = await db`SELECT external_id, sell_order_id FROM bank_transactions WHERE external_id IN ('p-lone', 'm-lone') ORDER BY external_id`;
    expect(after.map((l) => [l.external_id, l.sell_order_id])).toEqual([['m-lone', null], ['p-lone', soId]]);
  });

  it('the sync pairs a settlement onto a sell-order-linked charge and spreads the link', async () => {
    await seed();
    const { token } = await loginAs(ALEX);
    const soId = await createSO(token);
    expect((await link(token, await idOf('p-lone'), { sellOrderId: soId })).status).toBe(200);

    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [
        { externalId: 'm-late', amount: 200, paypalTxnId: 'p-lone', postedAt: new Date(NOW - 3 * DAY) },
      ]),
    ]);
    const legs = await getTestDb()`SELECT external_id, pair_id, sell_order_id FROM bank_transactions WHERE external_id IN ('p-lone', 'm-late')`;
    expect(legs).toHaveLength(2);
    expect(legs[0].pair_id).not.toBeNull();
    expect(legs[0].pair_id).toBe(legs[1].pair_id);
    expect(legs.every((l) => l.sell_order_id === soId)).toBe(true);
  });

  it('suggests sell orders and commissions by search, exact amount first', async () => {
    await seed();
    const { token } = await loginAs(ALEX);
    const soId = await createSO(token);
    const poId = await createPO(token);
    const db = getTestDb();
    type So = { id: string; status: string; customerName: string; total: number; reason: string };
    type Cm = { id: string; commission: number | null; linkedTotal: number; reason: string };

    // A Draft is not offered unprompted; a search finds it, and the exact
    // total is badged.
    const txnIn = await idOf('m-in');
    const quiet = await api<{ suggestions: So[] }>('GET', `/api/bank-transactions/${txnIn}/suggestions?target=so`, { token });
    expect(quiet.body.suggestions.map((s) => s.id)).not.toContain(soId);
    const found = await api<{ suggestions: So[] }>('GET', `/api/bank-transactions/${txnIn}/suggestions?target=so&q=${soId}`, { token });
    expect(found.body.suggestions[0]).toMatchObject({ id: soId, total: 90, reason: 'exact' });
    await db`UPDATE sell_orders SET status = 'Awaiting payment' WHERE id = ${soId}`;
    const waiting = await api<{ suggestions: So[] }>('GET', `/api/bank-transactions/${txnIn}/suggestions?target=so`, { token });
    expect(waiting.body.suggestions[0]).toMatchObject({ id: soId, status: 'Awaiting payment' });

    // Commission: the projected figure (margin × rate), exact on the $50 row.
    await db`UPDATE order_lines SET sell_price = 110 WHERE order_id = ${poId}`;
    await db`UPDATE orders SET lifecycle = 'ready_to_pay', commission_rate = 0.5 WHERE id = ${poId}`;
    const txnOut = await idOf('m-commission');
    const cm = await api<{ suggestions: Cm[] }>('GET', `/api/bank-transactions/${txnOut}/suggestions?target=commission`, { token });
    expect(cm.body.suggestions[0]).toMatchObject({ id: poId, commission: 50, linkedTotal: 0, reason: 'exact' });

    expect((await api('GET', `/api/bank-transactions/${txnOut}/suggestions?target=nope`, { token })).status).toBe(400);
  });
});
