import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
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
          settleStatus: 'settled' as const,
          raw: { id: t.externalId },
          ...t,
        })),
      };
    },
  };
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

// A Mercury->PayPal transfer as it actually arrives: money out of one account,
// the same money into the other. The legs carry OPPOSITE signs, which is what
// separates a transfer from a payment pair.
async function seedTransferLegs(): Promise<void> {
  await syncBankTransactions(testEnv, [
    fakeProvider('mercury', [
      { externalId: 'm-out', amount: -5000, counterparty: 'PayPal', postedAt: new Date(NOW - 4 * DAY) },
    ]),
    fakeProvider('paypal', [
      { externalId: 'p-in', amount: 5000, counterparty: 'Mercury', postedAt: new Date(NOW - 3 * DAY) },
    ]),
  ]);
}

// A seller payment recorded twice — the PayPal charge and its Mercury
// settlement, same sign, auto-paired by sync.
async function seedPaymentPair(): Promise<void> {
  await syncBankTransactions(testEnv, [
    fakeProvider('paypal', [
      { externalId: TXN_A, amount: -1240, counterparty: "John's Servers", postedAt: new Date(NOW - 3 * DAY) },
    ]),
    fakeProvider('mercury', [
      { externalId: 'm-settle', amount: -1240, paypalTxnId: TXN_A, postedAt: new Date(NOW - 2 * DAY) },
    ]),
  ]);
}

type RecordRow = {
  id: string; title: string | null; note: string | null;
  memberCount: number; totalIn: number; totalOut: number; net: number;
  members?: { id: string; source: string; legs: unknown[] }[];
};

async function createRecord(
  token: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/internal-transactions', { token, body });
  expect(r.status).toBe(201);
  return r.body.id;
}

describe('internal transactions API', () => {
  beforeEach(async () => { await resetDb(); });

  it('every route is manager-only', async () => {
    const { token } = await loginAs(MARCUS);
    const uuid = '00000000-0000-4000-8000-000000000000';
    for (const [method, path] of [
      ['GET', '/api/internal-transactions'],
      ['POST', '/api/internal-transactions'],
      ['GET', `/api/internal-transactions/${uuid}`],
      ['PATCH', `/api/internal-transactions/${uuid}`],
      ['POST', `/api/internal-transactions/${uuid}/members`],
      ['DELETE', `/api/internal-transactions/${uuid}/members/${uuid}`],
      ['DELETE', `/api/internal-transactions/${uuid}`],
    ] as const) {
      const r = await api(method, path, { token });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
  });

  it('filing a transaction takes it off the unlinked queue and names its record', async () => {
    await seedTransferLegs();
    const { token } = await loginAs(ALEX);
    const outId = await idOf('m-out');

    const id = await createRecord(token, {
      title: 'Mercury → PayPal top-up',
      note: 'Funding the PayPal balance before the Friday buys.',
      txnIds: [outId],
    });

    const row = await getTestDb()`
      SELECT internal_txn_id, category, category_manual FROM bank_transactions WHERE id = ${outId}`;
    expect(row[0].internal_txn_id).toBe(id);
    expect(row[0].category).toBe('transfer');
    expect(row[0].category_manual).toBe(true);

    const unlinked = await api<{ rows: { id: string }[] }>(
      'GET', '/api/bank-transactions?status=unlinked&direction=all', { token });
    expect(unlinked.body.rows.map((r) => r.id)).not.toContain(outId);

    const feed = await api<{ rows: { id: string; internalTxn: { id: string; title: string } | null }[] }>(
      'GET', '/api/bank-transactions?status=transfer&direction=all', { token });
    const filed = feed.body.rows.find((r) => r.id === outId);
    expect(filed?.internalTxn).toEqual({ id, title: 'Mercury → PayPal top-up' });
  });

  it('nets a transfer to zero but counts a payment pair once', async () => {
    await seedTransferLegs();
    await seedPaymentPair();
    const { token } = await loginAs(ALEX);

    const transferId = await createRecord(token, {
      title: 'Transfer', txnIds: [await idOf('m-out'), await idOf('p-in')],
    });
    // The payment pair is one movement seen twice: both legs are −1,240, so
    // only the display leg counts.
    const paymentId = await createRecord(token, {
      title: 'Payment', txnIds: [await idOf('m-settle')],
    });

    const list = await api<{ rows: RecordRow[] }>('GET', '/api/internal-transactions', { token });
    expect(list.status).toBe(200);
    const byId = new Map(list.body.rows.map((r) => [r.id, r]));

    const transfer = byId.get(transferId)!;
    expect(transfer.memberCount).toBe(2);
    expect(transfer.totalIn).toBe(5000);
    expect(transfer.totalOut).toBe(-5000);
    expect(transfer.net).toBe(0);

    const payment = byId.get(paymentId)!;
    expect(payment.memberCount).toBe(1);
    expect(payment.net).toBe(-1240);
  });

  it('files both legs of a pair and serves them as one member', async () => {
    await seedPaymentPair();
    const { token } = await loginAs(ALEX);
    const settleId = await idOf('m-settle');

    const id = await createRecord(token, { txnIds: [settleId] });

    const legs = await getTestDb()`
      SELECT external_id FROM bank_transactions WHERE internal_txn_id = ${id} ORDER BY external_id`;
    expect(legs.map((l) => l.external_id)).toEqual([TXN_A, 'm-settle']);

    const one = await api<RecordRow>('GET', `/api/internal-transactions/${id}`, { token });
    expect(one.status).toBe(200);
    expect(one.body.members).toHaveLength(1);
    expect(one.body.members![0].source).toBe('paired');
    expect(one.body.members![0].legs).toHaveLength(2);
  });

  it('refuses a transaction that is linked to a purchase order', async () => {
    await seedTransferLegs();
    const { token } = await loginAs(ALEX);
    const poId = await createPO(token);
    const outId = await idOf('m-out');
    expect((await api('POST', `/api/bank-transactions/${outId}/link`, {
      token, body: { orderId: poId },
    })).status).toBe(200);

    const r = await api<{ error: string }>('POST', '/api/internal-transactions', {
      token, body: { txnIds: [outId] },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/purchase order/i);

    // And the refused member left no empty record behind.
    const list = await api<{ rows: RecordRow[] }>('GET', '/api/internal-transactions', { token });
    expect(list.body.rows).toHaveLength(0);
  });

  it('refuses to link a filed transaction to a PO, or to unmark it', async () => {
    await seedTransferLegs();
    const { token } = await loginAs(ALEX);
    const poId = await createPO(token);
    const outId = await idOf('m-out');
    await createRecord(token, { txnIds: [outId] });

    const link = await api<{ error: string }>('POST', `/api/bank-transactions/${outId}/link`, {
      token, body: { orderId: poId },
    });
    expect(link.status).toBe(400);
    expect(link.body.error).toMatch(/internal transaction/i);

    const unmark = await api<{ error: string }>(
      'POST', `/api/bank-transactions/${outId}/unmark-transfer`, { token });
    expect(unmark.status).toBe(400);
    expect(unmark.body.error).toMatch(/internal transaction/i);
  });

  it('edits the note, drops a member without re-queuing it, and deletes the record', async () => {
    await seedTransferLegs();
    const { token } = await loginAs(ALEX);
    const outId = await idOf('m-out');
    const inId = await idOf('p-in');
    const id = await createRecord(token, { note: 'first', txnIds: [outId, inId] });

    expect((await api('PATCH', `/api/internal-transactions/${id}`, {
      token, body: { note: 'Owner moved float ahead of the auction.' },
    })).status).toBe(200);
    const after = await api<RecordRow>('GET', `/api/internal-transactions/${id}`, { token });
    expect(after.body.note).toBe('Owner moved float ahead of the auction.');

    // Removing a member releases it but leaves the human category verdict.
    expect((await api('DELETE', `/api/internal-transactions/${id}/members/${inId}`, { token })).status).toBe(200);
    const dropped = await getTestDb()`
      SELECT internal_txn_id, category FROM bank_transactions WHERE id = ${inId}`;
    expect(dropped[0].internal_txn_id).toBeNull();
    expect(dropped[0].category).toBe('transfer');

    expect((await api('DELETE', `/api/internal-transactions/${id}`, { token })).status).toBe(200);
    const released = await getTestDb()`
      SELECT internal_txn_id FROM bank_transactions WHERE id = ${outId}`;
    expect(released[0].internal_txn_id).toBeNull();
    expect((await api('GET', `/api/internal-transactions/${id}`, { token })).status).toBe(404);
  });

  it('refuses a transaction that already belongs to another record', async () => {
    await seedTransferLegs();
    const { token } = await loginAs(ALEX);
    const outId = await idOf('m-out');
    await createRecord(token, { txnIds: [outId] });
    const other = await createRecord(token, {});

    const r = await api<{ error: string }>('POST', `/api/internal-transactions/${other}/members`, {
      token, body: { txnIds: [outId] },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/already belongs/i);
  });

  it('survives a re-sync', async () => {
    await seedTransferLegs();
    const { token } = await loginAs(ALEX);
    const outId = await idOf('m-out');
    const id = await createRecord(token, { txnIds: [outId] });

    await seedTransferLegs();

    const row = await getTestDb()`
      SELECT internal_txn_id, category FROM bank_transactions WHERE id = ${outId}`;
    expect(row[0].internal_txn_id).toBe(id);
    expect(row[0].category).toBe('transfer');
  });
});
