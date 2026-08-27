import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { syncBankTransactions } from '../src/banktx/sync';
import { mercuryTxnCategory } from '../src/banktx/mercury';
import { paypalTxnCategory } from '../src/banktx/paypal';
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
  category: string;
  category_manual: boolean;
};

async function legs(): Promise<Map<string, LegRow>> {
  const db = getTestDb();
  const rows = await db<LegRow[]>`
    SELECT external_id, pair_id, no_auto_pair, order_id, link_kind, link_auto,
           linked_by, no_auto_link, ignored, description, category, category_manual
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

  it('classifies PayPal bank-transfer event codes as transfer', () => {
    expect(paypalTxnCategory('T0300')).toBe('transfer'); // bank deposit into PayPal
    expect(paypalTxnCategory('T0403')).toBe('transfer'); // withdrawal to bank
    expect(paypalTxnCategory('T0700')).toBe('transfer'); // card-funded top-up
    expect(paypalTxnCategory('T0701')).toBe('transfer'); // card deposit for negative balance
    expect(paypalTxnCategory('T0006')).toBe('external'); // regular payment
    expect(paypalTxnCategory(undefined)).toBe('external');
  });

  it('transfer-pairs a PayPal funding credit with the opposite-sign Mercury debit', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [
        { externalId: TXN_A, amount: 2000, category: 'transfer', postedAt: new Date(NOW - 2 * DAY) },
      ]),
      fakeProvider('mercury', [
        { externalId: 'm-topup', amount: -2000, postedAt: new Date(NOW - DAY) },
      ]),
    ]);
    const rows = await legs();
    expect(rows.get('m-topup')!.pair_id).toBeTruthy();
    expect(rows.get('m-topup')!.pair_id).toBe(rows.get(TXN_A)!.pair_id);
    // The Mercury side of a transfer pair is a transfer too.
    expect(rows.get('m-topup')!.category).toBe('transfer');
  });

  it('never transfer-pairs when two Mercury debits carry the same amount', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [
        { externalId: TXN_A, amount: 2000, category: 'transfer', postedAt: new Date(NOW - 2 * DAY) },
      ]),
      fakeProvider('mercury', [
        { externalId: 'm-t1', amount: -2000, postedAt: new Date(NOW - DAY) },
        { externalId: 'm-t2', amount: -2000, postedAt: new Date(NOW - DAY) },
      ]),
    ]);
    const rows = await legs();
    for (const id of [TXN_A, 'm-t1', 'm-t2']) {
      expect(rows.get(id)!.pair_id).toBeNull();
    }
  });

  it('transfer legs never join payment amount+date pairing', async () => {
    // Same signed amount, same window — the old payment matcher would pair
    // this funding credit with the unrelated Mercury refund.
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [
        { externalId: TXN_A, amount: 120, category: 'transfer', postedAt: new Date(NOW - 2 * DAY) },
      ]),
      fakeProvider('mercury', [
        { externalId: 'm-refund', amount: 120, postedAt: new Date(NOW - DAY) },
      ]),
    ]);
    const rows = await legs();
    expect(rows.get(TXN_A)!.pair_id).toBeNull();
    expect(rows.get('m-refund')!.pair_id).toBeNull();
  });

  it('auto-link skips transfer legs even on an exact txn id match', async () => {
    await createPO(TXN_A);
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [{ externalId: TXN_A, amount: 2000, category: 'transfer' }]),
    ]);
    const rows = await legs();
    expect(rows.get(TXN_A)!.order_id).toBeNull();
  });

  it('a manual category verdict sticks across re-syncs', async () => {
    const providers = [
      fakeProvider('paypal', [{ externalId: TXN_A, amount: 2000, category: 'transfer' as const }]),
    ];
    await syncBankTransactions(testEnv, providers);
    const db = getTestDb();
    await db`UPDATE bank_transactions SET category = 'external', category_manual = TRUE`;

    await syncBankTransactions(testEnv, providers);
    const rows = await legs();
    expect(rows.get(TXN_A)).toMatchObject({ category: 'external', category_manual: true });
  });

  it('classifies Mercury internal-account moves as transfer', () => {
    expect(mercuryTxnCategory('internalTransfer', null)).toBe('transfer'); // own accounts
    expect(mercuryTxnCategory('treasuryTransfer', null)).toBe('transfer');
    expect(mercuryTxnCategory('incomingDomesticWire', null)).toBe('external');
    expect(mercuryTxnCategory(undefined, null)).toBe('external');
  });

  it('classifies Mercury PayPal ACH descriptor rows as transfer, card settlements as external', () => {
    // ACH moves between our own PayPal and Mercury carry the "PAYPAL; …" descriptor.
    expect(mercuryTxnCategory('other', 'PAYPAL; RETRY PYMT; RECYCLE SERVERS LLC')).toBe('transfer');
    expect(mercuryTxnCategory('other', 'PAYPAL; TRANSFER; RECYCLE SERVERS LLC')).toBe('transfer');
    expect(mercuryTxnCategory('other', 'PAYPAL; PURCHASE; RECYCLE SERVERS LLC')).toBe('transfer');
    // Card purchases at PayPal merchants use "PAYPAL *name" — real payments,
    // must stay pairable with the PayPal payment leg.
    expect(mercuryTxnCategory('debitCardTransaction', 'PAYPAL *tywhitsett')).toBe('external');
    expect(mercuryTxnCategory('other', 'ACME SUPPLY CO ACH')).toBe('external');
  });

  it('a counterparty rule classifies matching syncs, skipping linked and manual rows', async () => {
    const db = getTestDb();
    await db`
      INSERT INTO bank_transfer_counterparties (source, counterparty)
      VALUES ('mercury', 'HK GREEN ENERGY')`;
    const poId = await createPO();
    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [
        { externalId: 'm-hk1', amount: 89261, counterparty: 'HK GREEN ENERGY' },
        { externalId: 'm-hk2', amount: 5000, counterparty: 'HK GREEN ENERGY' },
        { externalId: 'm-other', amount: 5000, counterparty: 'Reddit Seller' },
      ]),
    ]);
    await db`
      UPDATE bank_transactions
      SET order_id = ${poId}, link_kind = 'refund', linked_at = NOW(), category = 'external'
      WHERE external_id = 'm-hk2'`;
    await db`
      UPDATE bank_transactions SET category = 'external', category_manual = TRUE
      WHERE external_id = 'm-hk1'`;

    await syncBankTransactions(testEnv, [
      fakeProvider('mercury', [
        { externalId: 'm-hk1', amount: 89261, counterparty: 'HK GREEN ENERGY' },
        { externalId: 'm-hk2', amount: 5000, counterparty: 'HK GREEN ENERGY' },
        { externalId: 'm-hk3', amount: 2500, counterparty: 'HK GREEN ENERGY' },
        { externalId: 'm-other', amount: 5000, counterparty: 'Reddit Seller' },
      ]),
    ]);
    const rows = await legs();
    expect(rows.get('m-hk3')).toMatchObject({ category: 'transfer', category_manual: false });
    expect(rows.get('m-hk1')!.category).toBe('external'); // human verdict wins
    expect(rows.get('m-hk2')!.category).toBe('external'); // linked rows untouched
    expect(rows.get('m-other')!.category).toBe('external');
  });

  it('never transfer-pairs a Mercury leg that is already a transfer itself', async () => {
    // A Savings->Checking move's sibling is the other Mercury account, not a
    // same-amount PayPal funding credit that happens to be in the window.
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', [
        { externalId: TXN_A, amount: 5000, category: 'transfer', postedAt: new Date(NOW - 2 * DAY) },
      ]),
      fakeProvider('mercury', [
        { externalId: 'm-internal', amount: -5000, category: 'transfer', postedAt: new Date(NOW - DAY) },
      ]),
    ]);
    const rows = await legs();
    expect(rows.get(TXN_A)!.pair_id).toBeNull();
    expect(rows.get('m-internal')!.pair_id).toBeNull();
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
