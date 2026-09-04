import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { syncBankTransactions } from '../src/banktx/sync';
import type { BankProvider, BankSource, NormalizedTxn } from '../src/banktx/types';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const TXN_A = '7AB12345CD678901E';
const TXN_B = '9ZY87654WV321012K';

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

type Row = {
  id: string;
  source: string;
  amount: number;
  orderId: string | null;
  settleStatus: string;
  pairCandidate: unknown | null;
};

async function list(token: string, query = ''): Promise<Row[]> {
  const r = await api<{ rows: Row[] }>('GET', `/api/bank-transactions${query}`, { token });
  expect(r.status).toBe(200);
  return r.body.rows;
}

async function stats(token: string, query = '') {
  const r = await api<{
    unlinked: { count: number; amount: number };
    transfers: { count: number };
  }>('GET', `/api/bank-transactions/stats${query}`, { token });
  expect(r.status).toBe(200);
  return r.body;
}

async function createPO(paypalTxnId?: string): Promise<string> {
  const { token } = await loginAs(ALEX);
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: { category: 'RAM', lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
  });
  expect(r.status).toBe(201);
  if (paypalTxnId) {
    await getTestDb()`UPDATE orders SET paypal_txn_id = ${paypalTxnId} WHERE id = ${r.body.id}`;
  }
  return r.body.id;
}

const idOf = async (externalId: string): Promise<string> => {
  const [row] = await getTestDb()<{ id: string }[]>`
    SELECT id FROM bank_transactions WHERE external_id = ${externalId}`;
  return row.id;
};

describe('unsettled bank transactions', () => {
  beforeEach(async () => { await resetDb(); });

  it('ingests pending, failed and reversed rows instead of dropping them', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [
        { externalId: TXN_A, amount: -20570, settleStatus: 'pending' },
        { externalId: TXN_B, amount: -430, settleStatus: 'failed' },
        { externalId: '5REVERSED0000001', amount: -99, settleStatus: 'reversed' },
        { externalId: '4SETTLED00000001', amount: -12 },
      ]),
    ]);
    const { token } = await loginAs(ALEX);
    const rows = await list(token, '?direction=all');
    expect(rows).toHaveLength(4);
    expect(new Map(rows.map((r) => [r.amount, r.settleStatus]))).toEqual(new Map([
      [-20570, 'pending'], [-430, 'failed'], [-99, 'reversed'], [-12, 'settled'],
    ]));
  });

  it('clears the badge when the payment settles, with no human action', async () => {
    const pending = () => fakeProvider('paypal', [
      { externalId: TXN_A, amount: -20570, settleStatus: 'pending' },
    ]);
    await syncBankTransactions(testEnv, [pending()]);
    const { token } = await loginAs(ALEX);
    expect((await list(token))[0].settleStatus).toBe('pending');

    // The same id comes back settled — the upsert has to overwrite the column,
    // or the badge is frozen at whatever it said the day it was ingested.
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [{ externalId: TXN_A, amount: -20570 }]),
    ]);
    expect((await list(token))[0].settleStatus).toBe('settled');
  });

  // The overlap window is five days; a payment can sit pending for weeks. If
  // the window were the only reach-back, the row would fall out of every
  // subsequent fetch and its badge would never resolve.
  it('keeps fetching back to the oldest row still pending', async () => {
    const old = new Date(NOW - 40 * DAY);
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [{ externalId: TXN_A, amount: -20570, settleStatus: 'pending', postedAt: old }]),
    ]);

    let askedFor = '';
    await syncBankTransactions(testEnv, [{
      source: 'paypal',
      async fetchSince(sinceIso: string) {
        askedFor = sinceIso;
        return { accounts: [], txns: [] };
      },
    }]);
    expect(new Date(askedFor).getTime()).toBeLessThanOrEqual(old.getTime());
  });

  describe('pending', () => {
    it('is auto-linked to the PO naming its transaction id', async () => {
      const poId = await createPO(TXN_A);
      await syncBankTransactions(testEnv, [
        fakeProvider('paypal', [{ externalId: TXN_A, amount: -20570, settleStatus: 'pending' }]),
      ]);
      const { token } = await loginAs(ALEX);
      const [row] = await list(token, '?settle=pending');
      expect(row.orderId).toBe(poId);
    });

    it('is never paired — automatically, as a suggestion, or by hand', async () => {
      await syncBankTransactions(testEnv, [
        fakeProvider('paypal', [{ externalId: TXN_A, amount: -1240, settleStatus: 'pending' }]),
        fakeProvider('mercury', [{ externalId: 'm-1', amount: -1240, paypalTxnId: TXN_A }]),
      ]);
      const db = getTestDb();
      const rows = await db<{ pair_id: string | null }[]>`SELECT pair_id FROM bank_transactions`;
      expect(rows.every((r) => r.pair_id === null)).toBe(true);

      const { token } = await loginAs(ALEX);
      const mercury = (await list(token)).find((r) => r.source === 'mercury')!;
      expect(mercury.pairCandidate).toBeNull();

      const r = await api('POST', `/api/bank-transactions/${mercury.id}/pair`, {
        token, body: { otherId: await idOf(TXN_A) },
      });
      expect(r.status).toBe(400);
    });

    it('pairs on the sync after it settles', async () => {
      await syncBankTransactions(testEnv, [
        fakeProvider('paypal', [{ externalId: TXN_A, amount: -1240, settleStatus: 'pending' }]),
        fakeProvider('mercury', [{ externalId: 'm-1', amount: -1240, paypalTxnId: TXN_A }]),
      ]);
      await syncBankTransactions(testEnv, [
        fakeProvider('paypal', [{ externalId: TXN_A, amount: -1240 }]),
        fakeProvider('mercury', [{ externalId: 'm-1', amount: -1240, paypalTxnId: TXN_A }]),
      ]);
      const rows = await getTestDb()<{ pair_id: string | null }[]>`
        SELECT pair_id FROM bank_transactions`;
      expect(rows.every((r) => r.pair_id !== null)).toBe(true);
    });

    it('counts in the unlinked tile, as any other row does', async () => {
      await syncBankTransactions(testEnv, [
        fakeProvider('paypal', [{ externalId: TXN_A, amount: -20570, settleStatus: 'pending' }]),
      ]);
      const { token } = await loginAs(ALEX);
      expect(await stats(token, '?direction=out')).toMatchObject({
        unlinked: { count: 1, amount: 20570 },
      });
    });
  });

  describe('failed and reversed', () => {
    it('are absent from the queue and from the tile above it', async () => {
      await syncBankTransactions(testEnv, [
        fakeProvider('paypal', [
          { externalId: TXN_A, amount: -430, settleStatus: 'failed' },
          { externalId: '5REVERSED0000001', amount: -99, settleStatus: 'reversed' },
          { externalId: '4SETTLED00000001', amount: -12 },
        ]),
      ]);
      const { token } = await loginAs(ALEX);
      const rows = await list(token, '?status=unlinked&direction=out');
      expect(rows.map((r) => r.amount)).toEqual([-12]);
      // The tile has to agree with the list it sits above.
      expect(await stats(token, '?direction=out')).toMatchObject({
        unlinked: { count: rows.length, amount: 12 },
      });
    });

    it('are still reachable through the settlement filter', async () => {
      await syncBankTransactions(testEnv, [
        fakeProvider('paypal', [{ externalId: TXN_A, amount: -430, settleStatus: 'failed' }]),
      ]);
      const { token } = await loginAs(ALEX);
      expect((await list(token, '?settle=failed')).map((r) => r.amount)).toEqual([-430]);
      const bad = await api('GET', '/api/bank-transactions?settle=nonsense', { token });
      expect(bad.status).toBe(400);
    });

    it('are never auto-linked, and refuse a hand link or an owner', async () => {
      const poId = await createPO(TXN_A);
      await syncBankTransactions(testEnv, [
        fakeProvider('paypal', [{ externalId: TXN_A, amount: -430, settleStatus: 'failed' }]),
      ]);
      const { token, user } = await loginAs(ALEX);
      const [row] = await list(token, '?settle=failed');
      expect(row.orderId).toBeNull();

      const linked = await api('POST', `/api/bank-transactions/${row.id}/link`, {
        token, body: { orderId: poId },
      });
      expect(linked.status).toBe(400);
      const assigned = await api('POST', `/api/bank-transactions/${row.id}/assign`, {
        token, body: { userId: user.id },
      });
      expect(assigned.status).toBe(400);
    });

    it('are not swept into Transfers by a counterparty rule', async () => {
      await syncBankTransactions(testEnv, [
        fakeProvider('mercury', [
          { externalId: 'm-ok', amount: -800, counterparty: 'PayPal' },
          { externalId: 'm-dead', amount: -900, counterparty: 'PayPal', settleStatus: 'failed' },
        ]),
      ]);
      const { token } = await loginAs(ALEX);
      const ok = (await list(token)).find((r) => r.amount === -800)!;
      const r = await api('POST', `/api/bank-transactions/${ok.id}/mark-transfer`, { token });
      expect(r.status).toBe(200);

      const rows = await getTestDb()<{ external_id: string; category: string }[]>`
        SELECT external_id, category FROM bank_transactions`;
      expect(new Map(rows.map((x) => [x.external_id, x.category]))).toEqual(new Map([
        ['m-ok', 'transfer'], ['m-dead', 'external'],
      ]));
    });
  });

  // PayPal reverses a payment in place, keeping the transaction id, so this
  // arrives on a row that is already linked to a PO.
  it('a linked payment that reverses stops counting towards its PO', async () => {
    const poId = await createPO(TXN_A);
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [{ externalId: TXN_A, amount: -1240 }]),
    ]);
    const { token } = await loginAs(ALEX);
    const paid = await api<{ net: number }>('GET', `/api/bank-transactions/by-order/${poId}`, { token });
    expect(paid.body.net).toBe(-1240);

    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [{ externalId: TXN_A, amount: -1240, settleStatus: 'reversed' }]),
    ]);
    const after = await api<{ net: number; payments: { settleStatus: string }[] }>(
      'GET', `/api/bank-transactions/by-order/${poId}`, { token });
    // Still listed and badged — the PO's history did happen — but no longer
    // money the PO has been paid.
    expect(after.body.payments[0].settleStatus).toBe('reversed');
    expect(after.body.net).toBe(0);
  });

  it('human state survives a change of settlement state', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [{ externalId: TXN_A, amount: -1240, settleStatus: 'pending' }]),
    ]);
    const db = getTestDb();
    await db`UPDATE bank_transactions SET ignored = TRUE, no_auto_pair = TRUE WHERE external_id = ${TXN_A}`;

    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [{ externalId: TXN_A, amount: -1240 }]),
    ]);
    const [row] = await db<{ ignored: boolean; no_auto_pair: boolean; settle_status: string }[]>`
      SELECT ignored, no_auto_pair, settle_status FROM bank_transactions WHERE external_id = ${TXN_A}`;
    expect(row).toMatchObject({ ignored: true, no_auto_pair: true, settle_status: 'settled' });
  });
});
