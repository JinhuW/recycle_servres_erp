import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS, SOFIA } from './helpers/auth';
import { syncBankTransactions } from '../src/banktx/sync';
import type { BankProvider, BankSource, NormalizedTxn } from '../src/banktx/types';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const TXN_A = '7AB12345CD678901E';

type TxnSpec = Partial<NormalizedTxn> & { externalId: string; amount: number };

function fakeProvider(source: BankSource, txns: TxnSpec[]): BankProvider {
  return {
    source,
    async fetchSince() {
      return {
        accounts: [{ externalId: `${source}-acct`, name: `${source} acct` }],
        txns: txns.map((t) => ({
          source,
          accountExternalId: `${source}-acct`,
          postedAt: new Date(NOW - DAY),
          counterparty: null,
          description: null,
          paypalTxnId: source === 'paypal' ? t.externalId : null,
          category: 'external' as const,
          raw: { id: t.externalId },
          ...t,
        })),
      };
    },
  };
}

type PaymentRow = {
  id: string;
  source: string;
  amount: number;
  counterparty: string | null;
  legs: { source: string; externalId: string }[];
  pairCandidate: { id: string; source: string; dayGap: number } | null;
  orderId: string | null;
  orderCost: number | null;
  linkKind: string | null;
  linkAuto: boolean;
  ignored: boolean;
};

async function seedPairedAndSingles(): Promise<void> {
  await syncBankTransactions(testEnv, [
    fakeProvider('paypal', [
      { externalId: TXN_A, amount: -1240, counterparty: "John's Servers", postedAt: new Date(NOW - 3 * DAY) },
    ]),
    fakeProvider('mercury', [
      { externalId: 'm-settle', amount: -1240, paypalTxnId: TXN_A, postedAt: new Date(NOW - 2 * DAY) },
      { externalId: 'm-wire', amount: -560, counterparty: 'Reddit Seller', postedAt: new Date(NOW - 5 * DAY) },
      { externalId: 'm-refund', amount: 120, counterparty: 'Reddit Seller', postedAt: new Date(NOW - 1 * DAY) },
    ]),
  ]);
}

async function createPO(token: string): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: { category: 'RAM', lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

async function idOf(externalId: string): Promise<string> {
  const rows = await getTestDb()`SELECT id FROM bank_transactions WHERE external_id = ${externalId}`;
  expect(rows).toHaveLength(1);
  return rows[0].id as string;
}

describe('bank transactions API', () => {
  beforeEach(async () => { await resetDb(); });

  it('every route is manager-only', async () => {
    const { token } = await loginAs(MARCUS);
    for (const [method, path] of [
      ['GET', '/api/bank-transactions'],
      ['GET', '/api/bank-transactions/stats'],
      ['POST', '/api/bank-transactions/sync'],
      ['GET', '/api/bank-transactions/by-order/PO-1'],
      ['POST', '/api/bank-transactions/x/link'],
      ['POST', '/api/bank-transactions/x/unlink'],
      ['POST', '/api/bank-transactions/x/pair'],
      ['POST', '/api/bank-transactions/x/unpair'],
      ['POST', '/api/bank-transactions/x/ignore'],
      ['POST', '/api/bank-transactions/x/unignore'],
      ['POST', '/api/bank-transactions/x/mark-transfer'],
      ['POST', '/api/bank-transactions/x/unmark-transfer'],
      ['GET', '/api/bank-transactions/x/suggestions'],
      ['GET', '/api/bank-transactions/x/pair-candidates'],
      ['POST', '/api/bank-transactions/x/assign'],
      ['POST', '/api/bank-transactions/x/unassign'],
    ] as const) {
      const r = await api(method, path, { token });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
  });

  it('lists logical payments: pairs collapse to one row with both legs', async () => {
    await seedPairedAndSingles();
    const { token } = await loginAs(ALEX);
    const r = await api<{ rows: PaymentRow[] }>('GET', '/api/bank-transactions', { token });
    expect(r.status).toBe(200);
    expect(r.body.rows).toHaveLength(3);

    const paired = r.body.rows.find((x) => x.source === 'paired')!;
    expect(paired.counterparty).toBe("John's Servers");
    expect(paired.legs.map((l) => l.source).sort()).toEqual(['mercury', 'paypal']);
    // The rest are single-leg rows.
    for (const row of r.body.rows.filter((x) => x !== paired)) {
      expect(row.legs).toHaveLength(1);
    }
  });

  it('filters by status, source, direction, and q', async () => {
    await seedPairedAndSingles();
    const { token } = await loginAs(ALEX);
    const db = getTestDb();
    await db`UPDATE bank_transactions SET ignored = TRUE WHERE external_id = 'm-wire'`;

    const unlinked = await api<{ rows: PaymentRow[] }>(
      'GET', '/api/bank-transactions?status=unlinked', { token });
    expect(unlinked.body.rows.map((r) => r.source).sort()).toEqual(['mercury', 'paired']);

    const ignored = await api<{ rows: PaymentRow[] }>(
      'GET', '/api/bank-transactions?status=ignored', { token });
    expect(ignored.body.rows).toHaveLength(1);
    expect(ignored.body.rows[0].ignored).toBe(true);

    // Source: the paired row matches both source filters.
    const mercury = await api<{ rows: PaymentRow[] }>(
      'GET', '/api/bank-transactions?source=mercury', { token });
    expect(mercury.body.rows).toHaveLength(3);
    const paypal = await api<{ rows: PaymentRow[] }>(
      'GET', '/api/bank-transactions?source=paypal', { token });
    expect(paypal.body.rows).toHaveLength(1);
    expect(paypal.body.rows[0].source).toBe('paired');

    const incoming = await api<{ rows: PaymentRow[] }>(
      'GET', '/api/bank-transactions?direction=in', { token });
    expect(incoming.body.rows).toHaveLength(1);
    expect(incoming.body.rows[0].amount).toBe(120);

    // q matches the Mercury leg of the pair even though PayPal is displayed.
    const byRef = await api<{ rows: PaymentRow[] }>(
      `GET`, `/api/bank-transactions?q=m-settle`, { token });
    expect(byRef.body.rows).toHaveLength(1);
    expect(byRef.body.rows[0].source).toBe('paired');
  });

  it('transfers stay out of the unlinked queue and get their own filter + stat', async () => {
    await seedPairedAndSingles();
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [
        { externalId: '9ZY87654WV321012K', amount: 2000, category: 'transfer', postedAt: new Date(NOW - 4 * DAY) },
      ]),
    ]);
    const { token } = await loginAs(ALEX);

    const unlinked = await api<{ rows: (PaymentRow & { category: string })[] }>(
      'GET', '/api/bank-transactions?status=unlinked', { token });
    expect(unlinked.body.rows.every((r) => r.category === 'external')).toBe(true);
    expect(unlinked.body.rows).toHaveLength(3);

    const transfers = await api<{ rows: (PaymentRow & { category: string })[] }>(
      'GET', '/api/bank-transactions?status=transfer', { token });
    expect(transfers.body.rows).toHaveLength(1);
    expect(transfers.body.rows[0].category).toBe('transfer');
    expect(transfers.body.rows[0].amount).toBe(2000);

    const stats = await api<{ unlinked: { count: number }; transfers: { count: number } }>(
      'GET', '/api/bank-transactions/stats', { token });
    expect(stats.body.transfers.count).toBe(1);
    expect(stats.body.unlinked.count).toBe(3);
  });

  it('mark-transfer / unmark-transfer flip the whole group with a sticky manual verdict', async () => {
    await seedPairedAndSingles();
    const { token } = await loginAs(ALEX);
    const db = getTestDb();

    // Marking one leg of the pair reclassifies both.
    const pairedLegId = await idOf('m-settle');
    const mark = await api('POST', `/api/bank-transactions/${pairedLegId}/mark-transfer`, { token });
    expect(mark.status).toBe(200);
    const marked = await db`
      SELECT category, category_manual FROM bank_transactions
      WHERE external_id IN ('7AB12345CD678901E', 'm-settle')`;
    expect(marked).toHaveLength(2);
    expect(marked.every((l) => l.category === 'transfer' && l.category_manual === true)).toBe(true);

    const unmark = await api('POST', `/api/bank-transactions/${pairedLegId}/unmark-transfer`, { token });
    expect(unmark.status).toBe(200);
    const unmarked = await db`
      SELECT category, category_manual FROM bank_transactions WHERE external_id = 'm-settle'`;
    expect(unmarked[0]).toMatchObject({ category: 'external', category_manual: true });

    // A linked payment must be unlinked before it can be called a transfer.
    const poId = await createPO(token);
    await api('POST', `/api/bank-transactions/${pairedLegId}/link`, { token, body: { orderId: poId } });
    expect((await api('POST', `/api/bank-transactions/${pairedLegId}/mark-transfer`, { token })).status).toBe(400);
  });

  it('mark-transfer teaches a counterparty rule that covers existing and future rows', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [
        { externalId: 'm-hk1', amount: 89261, counterparty: 'HK GREEN ENERGY', postedAt: new Date(NOW - 3 * DAY) },
        { externalId: 'm-hk2', amount: 42000, counterparty: 'HK GREEN ENERGY', postedAt: new Date(NOW - 8 * DAY) },
        { externalId: 'm-wire', amount: -560, counterparty: 'Reddit Seller', postedAt: new Date(NOW - 5 * DAY) },
      ]),
    ]);
    const { token } = await loginAs(ALEX);

    const mark = await api<{ ok: boolean; ruleCounterparty: string | null; alsoMarked: number }>(
      'POST', `/api/bank-transactions/${await idOf('m-hk1')}/mark-transfer`, { token });
    expect(mark.status).toBe(200);
    expect(mark.body.ruleCounterparty).toBe('HK GREEN ENERGY');
    expect(mark.body.alsoMarked).toBe(1); // m-hk2 came along

    const db = getTestDb();
    const after = await db`SELECT external_id, category, category_manual FROM bank_transactions ORDER BY external_id`;
    expect(after.find((r) => r.external_id === 'm-hk2')).toMatchObject({ category: 'transfer', category_manual: false });
    expect(after.find((r) => r.external_id === 'm-wire')!.category).toBe('external');

    // A future sync classifies new rows from the taught counterparty.
    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [
        { externalId: 'm-hk3', amount: 2500, counterparty: 'HK GREEN ENERGY', postedAt: new Date(NOW - DAY) },
      ]),
    ]);
    const hk3 = await db`SELECT category FROM bank_transactions WHERE external_id = 'm-hk3'`;
    expect(hk3[0].category).toBe('transfer');

    // Unmark drops the rule and reverts the rows the rule classified.
    const unmark = await api<{ ok: boolean; ruleRemoved: boolean }>(
      'POST', `/api/bank-transactions/${await idOf('m-hk1')}/unmark-transfer`, { token });
    expect(unmark.status).toBe(200);
    expect(unmark.body.ruleRemoved).toBe(true);
    const rules = await db`SELECT 1 FROM bank_transfer_counterparties`;
    expect(rules).toHaveLength(0);
    const reverted = await db`
      SELECT external_id, category FROM bank_transactions WHERE counterparty = 'HK GREEN ENERGY' ORDER BY external_id`;
    expect(reverted.every((r) => r.category === 'external')).toBe(true);
  });

  it('keyset-paginates without skips or duplicates', async () => {
    const txns: TxnSpec[] = Array.from({ length: 5 }, (_, i) => ({
      externalId: `m-${i}`, amount: -(i + 1), postedAt: new Date(NOW - i * DAY),
    }));
    await syncBankTransactions(testEnv, [fakeProvider('mercury', txns)]);
    const { token } = await loginAs(ALEX);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const url: string = `/api/bank-transactions?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await api<{ rows: PaymentRow[]; nextCursor: string | null }>('GET', url, { token });
      expect(page.status).toBe(200);
      seen.push(...page.body.rows.map((r) => r.id));
      if (!page.body.nextCursor) break;
      cursor = page.body.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('link writes every leg, unlink tombstones, and the ledger nets payment + refund', async () => {
    await seedPairedAndSingles();
    const { token } = await loginAs(ALEX);
    const poId = await createPO(token);

    const pairedLegId = await idOf('m-settle');
    const link = await api<{ ok: boolean; linkKind: string }>(
      'POST', `/api/bank-transactions/${pairedLegId}/link`, { token, body: { orderId: poId } });
    expect(link.status).toBe(200);
    expect(link.body.linkKind).toBe('payment');

    const db = getTestDb();
    const legs = await db`SELECT external_id, order_id, link_auto, linked_by FROM bank_transactions WHERE order_id = ${poId}`;
    expect(legs.map((l) => l.external_id).sort()).toEqual(['7AB12345CD678901E', 'm-settle']);
    expect(legs.every((l) => l.link_auto === false && l.linked_by !== null)).toBe(true);

    // Refund onto the same PO.
    const refundId = await idOf('m-refund');
    const refund = await api<{ linkKind: string }>(
      'POST', `/api/bank-transactions/${refundId}/link`, { token, body: { orderId: poId } });
    expect(refund.body.linkKind).toBe('refund');

    const ledger = await api<{ payments: { amount: number }[]; net: number }>(
      'GET', `/api/bank-transactions/by-order/${poId}`, { token });
    expect(ledger.status).toBe(200);
    expect(ledger.body.payments).toHaveLength(2);
    expect(ledger.body.net).toBe(-1120);

    // Unlink clears every leg and sets the tombstone.
    const unlink = await api('POST', `/api/bank-transactions/${pairedLegId}/unlink`, { token });
    expect(unlink.status).toBe(200);
    const after = await db`SELECT order_id, no_auto_link FROM bank_transactions WHERE external_id IN ('7AB12345CD678901E', 'm-settle')`;
    expect(after.every((l) => l.order_id === null && l.no_auto_link === true)).toBe(true);
  });

  // The number a manager reads the row's own amount against. Goods alone would
  // report 1200 beside a -1240 payment and look like a shortfall.
  it('a linked row carries the PO cost, goods plus fees', async () => {
    await seedPairedAndSingles();
    const { token } = await loginAs(ALEX);
    const poId = await createPO(token);
    await getTestDb()`UPDATE orders SET total_cost = 1200, other_fees = 40 WHERE id = ${poId}`;

    const pairedLegId = await idOf('m-settle');
    await api('POST', `/api/bank-transactions/${pairedLegId}/link`, { token, body: { orderId: poId } });

    const r = await api<{ rows: PaymentRow[] }>('GET', '/api/bank-transactions', { token });
    expect(r.status).toBe(200);
    const byId = new Map(r.body.rows.map((x) => [x.id, x]));
    const linked = [...byId.values()].find((x) => x.orderId === poId);
    expect(linked?.orderCost).toBe(1240);
    expect(linked?.amount).toBe(-1240);
    // An unlinked row has no PO to cost.
    expect(byId.get(await idOf('m-wire'))?.orderCost).toBeNull();

    // No stored goods total is not a cost of zero, and not a fees-only figure.
    await getTestDb()`UPDATE orders SET total_cost = NULL WHERE id = ${poId}`;
    const after = await api<{ rows: PaymentRow[] }>('GET', '/api/bank-transactions', { token });
    expect(after.body.rows.find((x) => x.orderId === poId)?.orderCost).toBeNull();
  });

  // ── A typed transaction id links the payment when the human types it, not
  // when the six-hourly sync next runs.

  it('a transaction id saved on a PO links the payment immediately', async () => {
    await seedPairedAndSingles();
    const { token, user } = await loginAs(ALEX);
    const poId = await createPO(token);

    const r = await api<{ paymentsLinked: number }>('PATCH', `/api/orders/${poId}`, {
      token, body: { paypalTxnId: TXN_A },
    });
    expect(r.status).toBe(200);
    expect(r.body.paymentsLinked).toBe(1);

    const legs = await getTestDb()`
      SELECT external_id, link_kind, link_auto, linked_by
      FROM bank_transactions WHERE order_id = ${poId}`;
    expect(legs.map((l) => l.external_id).sort()).toEqual(['7AB12345CD678901E', 'm-settle']);
    // A typed id is a human decision, so it must not wear the auto badge.
    expect(legs.every((l) => l.link_auto === false && l.linked_by === user.id)).toBe(true);
    expect(legs.every((l) => l.link_kind === 'payment')).toBe(true);
  });

  it('a typed id links money in as a refund', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [
        { externalId: 'm-credit', amount: 120, paypalTxnId: 'REFUND001' },
      ]),
    ]);
    const { token } = await loginAs(ALEX);
    const poId = await createPO(token);
    await api('PATCH', `/api/orders/${poId}`, { token, body: { paypalTxnId: 'refund001' } });

    const rows = await getTestDb()`
      SELECT link_kind FROM bank_transactions WHERE order_id = ${poId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].link_kind).toBe('refund');
  });

  it('a typed id leaves a transaction that is linked, tombstoned, or ignored alone', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [
        { externalId: 'm-taken', amount: -100, paypalTxnId: 'TAKEN0001' },
        { externalId: 'm-tomb', amount: -200, paypalTxnId: 'TOMB00001' },
        { externalId: 'm-ign', amount: -300, paypalTxnId: 'IGNORED01' },
      ]),
    ]);
    const { token } = await loginAs(ALEX);
    const otherPo = await createPO(token);

    await api('POST', `/api/bank-transactions/${await idOf('m-taken')}/link`, {
      token, body: { orderId: otherPo } });
    await api('POST', `/api/bank-transactions/${await idOf('m-tomb')}/link`, {
      token, body: { orderId: otherPo } });
    await api('POST', `/api/bank-transactions/${await idOf('m-tomb')}/unlink`, { token });
    await api('POST', `/api/bank-transactions/${await idOf('m-ign')}/ignore`, { token });

    for (const txn of ['TAKEN0001', 'TOMB00001', 'IGNORED01']) {
      const poId = await createPO(token);
      const r = await api<{ paymentsLinked: number }>('PATCH', `/api/orders/${poId}`, {
        token, body: { paypalTxnId: txn },
      });
      expect(r.status, txn).toBe(200);
      expect(r.body.paymentsLinked, txn).toBe(0);
      const rows = await getTestDb()`SELECT id FROM bank_transactions WHERE order_id = ${poId}`;
      expect(rows, txn).toHaveLength(0);
    }
    // The one that was already linked still belongs to the PO that claimed it.
    const taken = await getTestDb()`SELECT order_id FROM bank_transactions WHERE external_id = 'm-taken'`;
    expect(taken[0].order_id).toBe(otherPo);
  });

  it('a typed id will not split a pair across two POs', async () => {
    await seedPairedAndSingles();
    const { token } = await loginAs(ALEX);
    const poA = await createPO(token);
    const db = getTestDb();

    await api('POST', `/api/bank-transactions/${await idOf('m-settle')}/link`, {
      token, body: { orderId: poA } });
    // Free one leg while its partner stays with poA — the state the guard is
    // there for. Reached by hand because no endpoint will produce it.
    await db`
      UPDATE bank_transactions
      SET order_id = NULL, link_kind = NULL, linked_by = NULL, linked_at = NULL
      WHERE external_id = 'm-settle'`;

    const poB = await createPO(token);
    const r = await api<{ paymentsLinked: number }>('PATCH', `/api/orders/${poB}`, {
      token, body: { paypalTxnId: TXN_A },
    });
    expect(r.body.paymentsLinked).toBe(0);
    const settle = await db`SELECT order_id FROM bank_transactions WHERE external_id = 'm-settle'`;
    expect(settle[0].order_id).toBeNull();
  });

  it('a PO created carrying the transaction id links on create', async () => {
    await seedPairedAndSingles();
    const { token } = await loginAs(ALEX);
    const r = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM',
        paypalTxnId: TXN_A,
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }],
      },
    });
    expect(r.status).toBe(201);
    const legs = await getTestDb()`
      SELECT external_id FROM bank_transactions WHERE order_id = ${r.body.id}`;
    expect(legs).toHaveLength(2);
  });

  // ── The other direction: linking on the Payments page fills the PO's field.

  it('linking fills an empty PO transaction id and records who filled it', async () => {
    await seedPairedAndSingles();
    const { token, user } = await loginAs(ALEX);
    const poId = await createPO(token);

    const r = await api<{ orderTxnFilled: boolean }>(
      'POST', `/api/bank-transactions/${await idOf('m-settle')}/link`,
      { token, body: { orderId: poId } });
    expect(r.status).toBe(200);
    expect(r.body.orderTxnFilled).toBe(true);

    const db = getTestDb();
    const order = await db`SELECT paypal_txn_id FROM orders WHERE id = ${poId}`;
    expect(order[0].paypal_txn_id).toBe(TXN_A);

    const events = await db`
      SELECT actor_id, detail FROM order_events
      WHERE order_id = ${poId} AND kind = 'meta_changed'`;
    expect(events).toHaveLength(1);
    expect(events[0].actor_id).toBe(user.id);
  });

  it('linking never overwrites a transaction id the PO already names', async () => {
    await seedPairedAndSingles();
    const { token } = await loginAs(ALEX);
    const poId = await createPO(token);
    const db = getTestDb();
    await db`UPDATE orders SET paypal_txn_id = 'TYPEDBYHAND' WHERE id = ${poId}`;

    const r = await api<{ orderTxnFilled: boolean }>(
      'POST', `/api/bank-transactions/${await idOf('m-settle')}/link`,
      { token, body: { orderId: poId } });
    expect(r.status).toBe(200);
    expect(r.body.orderTxnFilled).toBe(false);

    const order = await db`SELECT paypal_txn_id FROM orders WHERE id = ${poId}`;
    expect(order[0].paypal_txn_id).toBe('TYPEDBYHAND');
    // The link itself still happened.
    const legs = await db`SELECT id FROM bank_transactions WHERE order_id = ${poId}`;
    expect(legs).toHaveLength(2);
    const events = await db`
      SELECT id FROM order_events WHERE order_id = ${poId} AND kind = 'meta_changed'`;
    expect(events).toHaveLength(0);
  });

  it('rejects a link to a missing order and an unlink of an unlinked row', async () => {
    await seedPairedAndSingles();
    const { token } = await loginAs(ALEX);
    const id = await idOf('m-wire');
    expect((await api('POST', `/api/bank-transactions/${id}/link`, { token, body: { orderId: 'PO-99999' } })).status).toBe(404);
    expect((await api('POST', `/api/bank-transactions/${id}/link`, { token, body: {} })).status).toBe(400);
    expect((await api('POST', `/api/bank-transactions/${id}/unlink`, { token })).status).toBe(400);
  });

  it('manual pair validates sources and amounts; unpair tombstones', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [
        { externalId: '8XK42345CD678901F', amount: -300, postedAt: new Date(NOW - 20 * DAY) },
      ]),
      fakeProvider('mercury', [
        { externalId: 'm-1', amount: -300, postedAt: new Date(NOW - DAY) },
        { externalId: 'm-2', amount: -300, postedAt: new Date(NOW - DAY) },
        { externalId: 'm-3', amount: -42, postedAt: new Date(NOW - DAY) },
      ]),
    ]);
    const { token } = await loginAs(ALEX);
    const p = await idOf('8XK42345CD678901F');
    const m1 = await idOf('m-1');
    const m2 = await idOf('m-2');
    const m3 = await idOf('m-3');

    // Ambiguity kept these unpaired; a human resolves it.
    expect((await api('POST', `/api/bank-transactions/${m1}/pair`, { token, body: { otherId: m2 } })).status).toBe(400); // same source
    expect((await api('POST', `/api/bank-transactions/${p}/pair`, { token, body: { otherId: m3 } })).status).toBe(400); // amounts differ
    expect((await api('POST', `/api/bank-transactions/${p}/pair`, { token, body: { otherId: m1 } })).status).toBe(200);

    const db = getTestDb();
    const paired = await db`SELECT pair_id FROM bank_transactions WHERE id IN (${p}, ${m1})`;
    expect(paired[0].pair_id).toBeTruthy();
    expect(paired[0].pair_id).toBe(paired[1].pair_id);
    expect((await api('POST', `/api/bank-transactions/${p}/pair`, { token, body: { otherId: m2 } })).status).toBe(400); // already paired

    expect((await api('POST', `/api/bank-transactions/${p}/unpair`, { token })).status).toBe(200);
    const unpaired = await db`SELECT pair_id, no_auto_pair FROM bank_transactions WHERE id IN (${p}, ${m1})`;
    expect(unpaired.every((l) => l.pair_id === null && l.no_auto_pair === true)).toBe(true);
  });

  it('pair-candidates offers only legs POST /pair would accept', async () => {
    // Three same-amount Mercury legs against two PayPal ones: the bucket is
    // nowhere near 1:1, so autoPair abstains and everything stays unpaired.
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [
        { externalId: '9CK42345CD678901G', amount: -300, postedAt: new Date(NOW - DAY) },
        { externalId: '9CK42345CD678901H', amount: -300, postedAt: new Date(NOW - DAY) },
      ]),
      fakeProvider('mercury', [
        { externalId: 'c-ok', amount: -300, postedAt: new Date(NOW - 2 * DAY) },
        { externalId: 'c-ignored', amount: -300, postedAt: new Date(NOW - 2 * DAY) },
        { externalId: 'c-far', amount: -300, postedAt: new Date(NOW - 60 * DAY) },
        { externalId: 'c-amount', amount: -301, postedAt: new Date(NOW - DAY) },
      ]),
    ]);
    const { token } = await loginAs(ALEX);
    const subject = await idOf('9CK42345CD678901G');
    const ok = await idOf('c-ok');
    expect((await api('POST', `/api/bank-transactions/${await idOf('c-ignored')}/ignore`, { token })).status).toBe(200);

    const ids = async (): Promise<string[]> => {
      const r = await api<{ candidates: { id: string }[] }>(
        'GET', `/api/bank-transactions/${subject}/pair-candidates`, { token });
      expect(r.status).toBe(200);
      return r.body.candidates.map((c) => c.id);
    };

    // Excluded: the other PayPal leg (same source), c-amount (a cent off),
    // c-ignored, and c-far (outside the picker's window).
    expect(await ids()).toEqual([ok]);

    // A counterpart already linked to a PO stays on offer — the endpoint
    // accepts that pair and propagates the link. Only two legs linked to
    // *different* orders are refused.
    const poA = await createPO(token);
    expect((await api('POST', `/api/bank-transactions/${ok}/link`, { token, body: { orderId: poA } })).status).toBe(200);
    expect(await ids()).toEqual([ok]);

    const poB = await createPO(token);
    expect((await api('POST', `/api/bank-transactions/${subject}/link`, { token, body: { orderId: poB } })).status).toBe(200);
    expect(await ids()).toEqual([]);
  });

  it('the list suggests a grouping only when it is certain on both sides', async () => {
    // The real shape of the miss: one stale same-amount leg makes autoPair's
    // globally-scoped bucket ambiguous, even though inside its 3-day window
    // the pairing is obvious.
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [
        { externalId: '1DK42345CD678901J', amount: -500, postedAt: new Date(NOW - DAY) },
        { externalId: '2DK42345CD678901K', amount: -700, postedAt: new Date(NOW - DAY) },
      ]),
      fakeProvider('mercury', [
        { externalId: 'g-near', amount: -500, postedAt: new Date(NOW - 2 * DAY) },
        { externalId: 'g-stale', amount: -500, postedAt: new Date(NOW - 60 * DAY) },
        { externalId: 'g-two-a', amount: -700, postedAt: new Date(NOW - DAY) },
        { externalId: 'g-two-b', amount: -700, postedAt: new Date(NOW - 2 * DAY) },
      ]),
    ]);
    const { token } = await loginAs(ALEX);
    const rows = async (): Promise<Map<string, PaymentRow>> => {
      const r = await api<{ rows: PaymentRow[] }>('GET', '/api/bank-transactions', { token });
      expect(r.status).toBe(200);
      return new Map(r.body.rows.map((x) => [x.id, x]));
    };

    const sole = await idOf('1DK42345CD678901J');
    const near = await idOf('g-near');
    let feed = await rows();
    // Mutually unique inside the window, from either side.
    expect(feed.get(sole)?.pairCandidate?.id).toBe(near);
    expect(feed.get(near)?.pairCandidate?.id).toBe(sole);
    // The stale leg has nothing within three days of it.
    expect(feed.get(await idOf('g-stale'))?.pairCandidate).toBeNull();

    // Two counterparts is ambiguity — and so is being one of two counterparts,
    // which a one-sided test would have shown as a confident suggestion.
    expect(feed.get(await idOf('2DK42345CD678901K'))?.pairCandidate).toBeNull();
    expect(feed.get(await idOf('g-two-a'))?.pairCandidate).toBeNull();

    // Ungroup tombstones both legs. The suggestion is the auto-matcher
    // speaking, so it goes quiet; the picker is the human, so it does not.
    expect((await api('POST', `/api/bank-transactions/${sole}/pair`, { token, body: { otherId: near } })).status).toBe(200);
    expect((await api('POST', `/api/bank-transactions/${sole}/unpair`, { token })).status).toBe(200);
    feed = await rows();
    expect(feed.get(sole)?.pairCandidate).toBeNull();
    const picker = await api<{ candidates: { id: string }[] }>(
      'GET', `/api/bank-transactions/${sole}/pair-candidates`, { token });
    expect(picker.body.candidates.map((c) => c.id)).toEqual([near]);
  });

  it('ignore requires an unlinked row and unignore restores it', async () => {
    await seedPairedAndSingles();
    const { token } = await loginAs(ALEX);
    const poId = await createPO(token);
    const id = await idOf('m-wire');

    await api('POST', `/api/bank-transactions/${id}/link`, { token, body: { orderId: poId } });
    expect((await api('POST', `/api/bank-transactions/${id}/ignore`, { token })).status).toBe(400);
    await api('POST', `/api/bank-transactions/${id}/unlink`, { token });
    expect((await api('POST', `/api/bank-transactions/${id}/ignore`, { token })).status).toBe(200);
    // Linking an ignored row is refused until unignored.
    expect((await api('POST', `/api/bank-transactions/${id}/link`, { token, body: { orderId: poId } })).status).toBe(400);
    expect((await api('POST', `/api/bank-transactions/${id}/unignore`, { token })).status).toBe(200);
    expect((await api('POST', `/api/bank-transactions/${id}/link`, { token, body: { orderId: poId } })).status).toBe(200);
  });

  it('stats dedupe pairs and split the tiles correctly', async () => {
    await seedPairedAndSingles();
    const { token } = await loginAs(ALEX);
    const poId = await createPO(token);
    await api('POST', `/api/bank-transactions/${await idOf('m-refund')}/link`, { token, body: { orderId: poId } });
    await api('POST', `/api/bank-transactions/${await idOf('m-wire')}/ignore`, { token });

    const r = await api<{
      unlinked: { count: number; amount: number };
      linked: { count: number };
      refunds: { count: number; amount: number };
      ignored: { count: number };
      sources: { source: string; lastSyncedAt: string | null }[];
    }>('GET', '/api/bank-transactions/stats', { token });
    expect(r.status).toBe(200);
    // The pair counts once (unlinked), the refund is linked, the wire ignored.
    expect(r.body.unlinked).toEqual({ count: 1, amount: 1240 });
    expect(r.body.linked.count).toBe(1);
    expect(r.body.refunds).toEqual({ count: 1, amount: 120 });
    expect(r.body.ignored.count).toBe(1);
    expect(r.body.sources.map((s) => s.source).sort()).toEqual(['mercury', 'paypal']);
  });

  it('sync endpoint reports not-configured sources when no keys are set', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ notConfigured: string[] }>('POST', '/api/bank-transactions/sync', { token });
    expect(r.status).toBe(200);
    expect(r.body.notConfigured.sort()).toEqual(['mercury', 'paypal']);
  });

  it('suggestions rank txn-id match first, then amount+date, then search', async () => {
    const { token } = await loginAs(ALEX);
    const poTxn = await createPO(token);
    const poAmount = await createPO(token);
    const db = getTestDb();
    await db`UPDATE orders SET paypal_txn_id = ${TXN_A} WHERE id = ${poTxn}`;
    await db`UPDATE orders SET total_cost = 560 WHERE id = ${poAmount}`;
    // Keep the txn-id order's total off 560 so it can't double-match.
    await db`UPDATE orders SET total_cost = 10 WHERE id = ${poTxn}`;

    // Tombstone auto-linking so the txn stays unlinked for the suggestion read.
    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [
        { externalId: 'm-x', amount: -560, paypalTxnId: TXN_A, postedAt: new Date(NOW - DAY) },
      ]),
    ]);
    await db`UPDATE bank_transactions SET order_id = NULL, link_kind = NULL, link_auto = FALSE, linked_at = NULL, no_auto_link = TRUE`;

    const id = await idOf('m-x');
    const r = await api<{ suggestions: { id: string; reason: string }[] }>(
      'GET', `/api/bank-transactions/${id}/suggestions`, { token });
    expect(r.status).toBe(200);
    const reasons = new Map(r.body.suggestions.map((s) => [s.id, s.reason]));
    expect(reasons.get(poTxn)).toBe('txn');
    expect(reasons.get(poAmount)).toBe('exact');
    expect(r.body.suggestions[0].id).toBe(poTxn);

    const searched = await api<{ suggestions: { id: string; reason: string }[] }>(
      'GET', `/api/bank-transactions/${id}/suggestions?q=${poAmount}`, { token });
    expect(searched.body.suggestions.some((s) => s.id === poAmount && s.reason === 'search')).toBe(true);
  });
});

// The queue defaults to money OUT, so a direction-blind tile counted rows the
// list underneath it was hiding — and once the out-queue was drained the page
// claimed there was nothing left while unlinked incoming payments sat unseen.
describe('GET /api/bank-transactions/stats — direction lens', () => {
  beforeEach(async () => { await resetDb(); });

  async function seedBothDirections() {
    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [
        { externalId: 'dir-out-1', amount: -250 },
        { externalId: 'dir-out-2', amount: -20 },
        { externalId: 'dir-in-1', amount: 180 },
      ]),
    ]);
  }

  it('scopes the unlinked tile to the same direction as the list', async () => {
    const { token } = await loginAs(ALEX);
    await seedBothDirections();

    const all = await api<{ unlinked: { count: number } }>(
      'GET', '/api/bank-transactions/stats', { token });
    const out = await api<{ unlinked: { count: number } }>(
      'GET', '/api/bank-transactions/stats?direction=out', { token });
    const inn = await api<{ unlinked: { count: number } }>(
      'GET', '/api/bank-transactions/stats?direction=in', { token });

    expect(out.body.unlinked.count).toBe(2);
    expect(inn.body.unlinked.count).toBe(1);
    // No lens still means the whole queue.
    expect(all.body.unlinked.count).toBe(out.body.unlinked.count + inn.body.unlinked.count);
  });

  it('agrees with the list it sits above', async () => {
    const { token } = await loginAs(ALEX);
    await seedBothDirections();

    const stats = await api<{ unlinked: { count: number } }>(
      'GET', '/api/bank-transactions/stats?direction=out', { token });
    const list = await api<{ rows: unknown[] }>(
      'GET', '/api/bank-transactions?status=unlinked&direction=out&limit=100', { token });
    expect(stats.body.unlinked.count).toBe(list.body.rows.length);
  });
});

// An owner for a payment nobody has explained yet. It is the one verdict on
// this page that does NOT resolve the row — the payment still needs an answer,
// it just has someone to answer it — so the queue has to keep showing it.
describe('assigning a payment to a member', () => {
  beforeEach(async () => { await resetDb(); });

  async function seedOne(): Promise<string> {
    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [{ externalId: 'm-mystery', amount: -600, counterparty: 'Unknown' }]),
    ]);
    return idOf('m-mystery');
  }

  it('writes every leg and keeps the row in the unlinked queue', async () => {
    await seedPairedAndSingles();
    const { token, user } = await loginAs(ALEX);
    const pairedLegId = await idOf('m-settle');

    const r = await api<{ assignee: { id: string; name: string } }>(
      'POST', `/api/bank-transactions/${pairedLegId}/assign`, { token, body: { userId: user.id } });
    expect(r.status).toBe(200);
    expect(r.body.assignee.id).toBe(user.id);

    const legs = await getTestDb()`
      SELECT external_id, assignee_id, assigned_by, assigned_at
      FROM bank_transactions WHERE assignee_id IS NOT NULL ORDER BY external_id`;
    expect(legs.map((l) => l.external_id)).toEqual([TXN_A, 'm-settle']);
    expect(legs.every((l) => l.assigned_by === user.id && l.assigned_at !== null)).toBe(true);

    // Still work to do: assignment routes it, it does not classify it. The
    // pair's display row is the PayPal leg, so that is where the owner shows.
    const queue = await api<{ rows: { id: string; assignee: { name: string } | null }[] }>(
      'GET', '/api/bank-transactions?status=unlinked&direction=out', { token });
    const displayId = await idOf(TXN_A);
    const row = queue.body.rows.find((x) => x.id === displayId);
    expect(row?.assignee?.name).toBeTruthy();
  });

  it('filters by owner and by unassigned', async () => {
    const txnId = await seedOne();
    const { token, user } = await loginAs(ALEX);
    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [{ externalId: 'm-other', amount: -75 }]),
    ]);
    await api('POST', `/api/bank-transactions/${txnId}/assign`, { token, body: { userId: user.id } });

    const mine = await api<{ rows: { id: string }[] }>(
      'GET', `/api/bank-transactions?direction=all&assignee=${user.id}`, { token });
    expect(mine.body.rows.map((r) => r.id)).toEqual([txnId]);

    const none = await api<{ rows: { id: string }[] }>(
      'GET', '/api/bank-transactions?direction=all&assignee=unassigned', { token });
    expect(none.body.rows.map((r) => r.id)).not.toContain(txnId);
    expect(none.body.rows.length).toBeGreaterThan(0);

    // A malformed owner is the caller's mistake, not a 500 from a ::uuid cast.
    const bad = await api('GET', '/api/bank-transactions?assignee=not-a-uuid', { token });
    expect(bad.status).toBe(400);
  });

  it('refuses a PO-linked row, an unknown member, and a deactivated one', async () => {
    const txnId = await seedOne();
    const { token, user } = await loginAs(ALEX);

    const unknown = await api('POST', `/api/bank-transactions/${txnId}/assign`, {
      token, body: { userId: '00000000-0000-4000-8000-000000000000' } });
    expect(unknown.status).toBe(404);

    const db = getTestDb();
    const [inactive] = await db<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${MARCUS}`;
    await db`UPDATE users SET active = FALSE WHERE id = ${inactive.id}`;
    const deactivated = await api('POST', `/api/bank-transactions/${txnId}/assign`, {
      token, body: { userId: inactive.id } });
    expect(deactivated.status).toBe(404);

    const poId = await createPO(token);
    await api('POST', `/api/bank-transactions/${txnId}/link`, { token, body: { orderId: poId } });
    const linked = await api<{ error: string }>('POST', `/api/bank-transactions/${txnId}/assign`, {
      token, body: { userId: user.id } });
    expect(linked.status).toBe(400);
    expect(linked.body.error).toMatch(/unlink/i);
  });

  it('linking to a PO clears the owner', async () => {
    const txnId = await seedOne();
    const { token, user } = await loginAs(ALEX);
    const poId = await createPO(token);
    await api('POST', `/api/bank-transactions/${txnId}/assign`, { token, body: { userId: user.id } });

    const link = await api('POST', `/api/bank-transactions/${txnId}/link`, {
      token, body: { orderId: poId } });
    expect(link.status).toBe(200);

    const [row] = await getTestDb()`
      SELECT assignee_id, assigned_at FROM bank_transactions WHERE id = ${txnId}`;
    expect(row.assignee_id).toBeNull();
    expect(row.assigned_at).toBeNull();
  });

  it('propagates a lone owner across a manual pair, and refuses two different ones', async () => {
    // Two Mercury legs at the same amount keep auto-pair out of it — the 1:1
    // bucket rule refuses to guess, which is exactly when a human pairs by hand.
    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [
        { externalId: 'pm-m', amount: -300 },
        { externalId: 'pm-decoy', amount: -300 },
      ]),
      fakeProvider('paypal', [{ externalId: 'pm-p', amount: -300 }]),
    ]);
    const { token, user } = await loginAs(ALEX);
    const mId = await idOf('pm-m');
    const pId = await idOf('pm-p');
    const [sofia] = await getTestDb()<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${SOFIA}`;

    await api('POST', `/api/bank-transactions/${mId}/assign`, { token, body: { userId: user.id } });
    await api('POST', `/api/bank-transactions/${pId}/assign`, { token, body: { userId: sofia.id } });
    const clash = await api<{ error: string }>('POST', `/api/bank-transactions/${mId}/pair`, {
      token, body: { otherId: pId } });
    expect(clash.status).toBe(400);
    expect(clash.body.error).toMatch(/different members/i);

    await api('POST', `/api/bank-transactions/${pId}/unassign`, { token });
    const paired = await api('POST', `/api/bank-transactions/${mId}/pair`, {
      token, body: { otherId: pId } });
    expect(paired.status).toBe(200);

    const owners = await getTestDb()`
      SELECT assignee_id FROM bank_transactions WHERE id IN (${mId}, ${pId})`;
    expect(owners.every((o) => o.assignee_id === user.id)).toBe(true);
  });
});
