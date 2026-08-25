import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
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
          raw: { id: t.externalId },
          ...t,
        })),
      };
    },
  };
}

type LegRow = {
  external_id: string;
  pair_id: string | null;
  no_auto_pair: boolean;
  order_id: string | null;
  link_kind: string | null;
  link_auto: boolean;
  linked_by: string | null;
  no_auto_link: boolean;
  ignored: boolean;
  description: string | null;
};

async function legs(): Promise<Map<string, LegRow>> {
  const db = getTestDb();
  const rows = await db<LegRow[]>`
    SELECT external_id, pair_id, no_auto_pair, order_id, link_kind, link_auto,
           linked_by, no_auto_link, ignored, description
    FROM bank_transactions`;
  return new Map(rows.map((r) => [r.external_id, r]));
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

describe('bank transaction sync', () => {
  beforeEach(async () => { await resetDb(); });

  it('inserts accounts and transactions, and re-sync updates provider fields only', async () => {
    const first = await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [
        { externalId: 'm1', amount: -560, description: 'Wire' },
        { externalId: 'm2', amount: -312.55, description: 'AWS' },
      ]),
    ]);
    expect(first.perSource.mercury).toMatchObject({ inserted: 2, updated: 0 });

    // Human state set between syncs must survive the provider re-upsert.
    const db = getTestDb();
    await db`UPDATE bank_transactions SET ignored = TRUE, no_auto_pair = TRUE WHERE external_id = 'm2'`;

    const second = await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [
        { externalId: 'm1', amount: -560, description: 'Wire' },
        { externalId: 'm2', amount: -312.55, description: 'AWS EMEA' },
      ]),
    ]);
    expect(second.perSource.mercury).toMatchObject({ inserted: 0, updated: 2 });

    const rows = await legs();
    expect(rows.get('m2')).toMatchObject({ ignored: true, no_auto_pair: true, description: 'AWS EMEA' });

    const accounts = await db`SELECT source, external_id, sync_cursor FROM bank_accounts`;
    expect(accounts).toHaveLength(1);
    expect(accounts[0].sync_cursor).toBeTruthy();
  });

  it('auto-pairs by PayPal txn id reference regardless of date gap', async () => {
    const result = await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [{ externalId: TXN_A, amount: -1240, postedAt: new Date(NOW - 10 * DAY) }]),
      fakeProvider('mercury', [
        { externalId: 'm-settle', amount: -1240, paypalTxnId: TXN_A, postedAt: new Date(NOW - DAY) },
      ]),
    ]);
    expect(result.perSource.mercury?.paired).toBe(1);

    const rows = await legs();
    expect(rows.get('m-settle')!.pair_id).toBeTruthy();
    expect(rows.get('m-settle')!.pair_id).toBe(rows.get(TXN_A)!.pair_id);
  });

  it('auto-pairs an unambiguous amount+date match, leaves ambiguous amounts alone', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [
        { externalId: '9ZY87654WV321012K', amount: -89.99, postedAt: new Date(NOW - 2 * DAY) },
        { externalId: '8XK42345CD678901F', amount: -500, postedAt: new Date(NOW - 2 * DAY) },
      ]),
      fakeProvider('mercury', [
        { externalId: 'm-a', amount: -89.99, postedAt: new Date(NOW - DAY) },
        // Two same-amount Mercury candidates → ambiguous, no pairing.
        { externalId: 'm-b1', amount: -500, postedAt: new Date(NOW - DAY) },
        { externalId: 'm-b2', amount: -500, postedAt: new Date(NOW - DAY) },
      ]),
    ]);

    const rows = await legs();
    expect(rows.get('m-a')!.pair_id).toBe(rows.get('9ZY87654WV321012K')!.pair_id);
    expect(rows.get('m-a')!.pair_id).toBeTruthy();
    for (const id of ['m-b1', 'm-b2', '8XK42345CD678901F']) {
      expect(rows.get(id)!.pair_id).toBeNull();
    }
  });

  it('does not pair outside the date window', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [{ externalId: '8XK42345CD678901F', amount: -75, postedAt: new Date(NOW - 10 * DAY) }]),
      fakeProvider('mercury', [{ externalId: 'm-late', amount: -75, postedAt: new Date(NOW - DAY) }]),
    ]);
    const rows = await legs();
    expect(rows.get('m-late')!.pair_id).toBeNull();
  });

  it('a human unpair sticks across re-syncs', async () => {
    const providers = [
      fakeProvider('paypal', [{ externalId: TXN_A, amount: -1240 }]),
      fakeProvider('mercury', [{ externalId: 'm-settle', amount: -1240, paypalTxnId: TXN_A }]),
    ];
    await syncBankTransactions(testEnv, providers);
    const db = getTestDb();
    await db`UPDATE bank_transactions SET pair_id = NULL, no_auto_pair = TRUE`;

    await syncBankTransactions(testEnv, providers);
    const rows = await legs();
    expect(rows.get('m-settle')!.pair_id).toBeNull();
    expect(rows.get(TXN_A)!.pair_id).toBeNull();
  });

  it('auto-links an exact PayPal txn id match to the PO, covering both paired legs', async () => {
    const poId = await createPO(TXN_A);
    const result = await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [{ externalId: TXN_A, amount: -1240 }]),
      fakeProvider('mercury', [{ externalId: 'm-settle', amount: -1240, paypalTxnId: TXN_A }]),
    ]);
    // PayPal syncs first, so its pass links the leg; the Mercury pass then
    // pairs and copies the link — the count lands on paypal.
    expect(result.perSource.paypal?.autoLinked).toBe(1);

    const rows = await legs();
    for (const id of [TXN_A, 'm-settle']) {
      expect(rows.get(id)).toMatchObject({
        order_id: poId, link_kind: 'payment', link_auto: true, linked_by: null,
      });
    }
  });

  it('never auto-links when two orders claim the same txn id', async () => {
    await createPO(TXN_A);
    await createPO(TXN_A);
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [{ externalId: TXN_A, amount: -1240 }]),
    ]);
    const rows = await legs();
    expect(rows.get(TXN_A)!.order_id).toBeNull();
  });

  it('a human unlink sticks across re-syncs', async () => {
    await createPO(TXN_A);
    const providers = [fakeProvider('paypal', [{ externalId: TXN_A, amount: -1240 }])];
    await syncBankTransactions(testEnv, providers);

    const db = getTestDb();
    await db`
      UPDATE bank_transactions
      SET order_id = NULL, link_kind = NULL, link_auto = FALSE, linked_at = NULL, no_auto_link = TRUE`;

    await syncBankTransactions(testEnv, providers);
    const rows = await legs();
    expect(rows.get(TXN_A)!.order_id).toBeNull();
  });

  it('links money coming back in as a refund', async () => {
    const poId = await createPO(TXN_A);
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [{ externalId: TXN_A, amount: 120 }]),
    ]);
    const rows = await legs();
    expect(rows.get(TXN_A)).toMatchObject({ order_id: poId, link_kind: 'refund' });
  });

  it('one failing provider does not block the other', async () => {
    const broken: BankProvider = {
      source: 'paypal',
      async fetchSince() { throw new Error('paypal down'); },
    };
    const result = await syncBankTransactions(testEnv, [
      broken,
      fakeProvider('mercury', [{ externalId: 'm1', amount: -10 }]),
    ]);
    expect(result.perSource.paypal?.error).toContain('paypal down');
    expect(result.perSource.mercury).toMatchObject({ inserted: 1 });
  });
});
