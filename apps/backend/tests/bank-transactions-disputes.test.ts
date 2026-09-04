import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { syncBankTransactions } from '../src/banktx/sync';
import { disputeTimeline, normalizeDispute } from '../src/banktx/paypal';
import type {
  BankProvider, BankSource, NormalizedDispute, NormalizedTxn,
} from '../src/banktx/types';

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const TXN_A = '7AB12345CD678901E';
const TXN_IN = '3CD00000INCOMING1';

type TxnSpec = Partial<NormalizedTxn> & { externalId: string; amount: number };

function dispute(over: Partial<NormalizedDispute> & { disputeId: string; txnIds: string[] }): NormalizedDispute {
  return {
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    status: 'OPEN',
    disputeState: 'OPEN_INQUIRIES',
    lifeCycleStage: 'INQUIRY',
    channel: 'INTERNAL',
    amount: 1240,
    currency: 'USD',
    outcomeCode: null,
    refundedAmount: null,
    openedAt: new Date(NOW - 2 * DAY).toISOString(),
    updatedAt: new Date(NOW - DAY).toISOString(),
    buyerResponseDueAt: null,
    sellerResponseDueAt: null,
    timeline: [],
    ...over,
  };
}

// `disputes` is a function so a test can make it throw — the point of hanging
// it off the provider rather than off fetchSince is that it can fail alone.
function fakeProvider(
  source: BankSource,
  txns: TxnSpec[],
  disputes?: () => Promise<NormalizedDispute[]>,
): BankProvider {
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
    ...(disputes ? { fetchDisputes: disputes } : {}),
  };
}

type Row = {
  id: string;
  source: string;
  amount: number;
  orderId: string | null;
  legs: { source: string; externalId: string }[];
  disputes: { disputeId: string; status: string | null }[] | null;
};

const paypalOut = (extra: TxnSpec[] = []): TxnSpec[] => [
  { externalId: TXN_A, amount: -1240, counterparty: "John's Servers", postedAt: new Date(NOW - 3 * DAY) },
  ...extra,
];

async function list(token: string, query = ''): Promise<Row[]> {
  const r = await api<{ rows: Row[] }>('GET', `/api/bank-transactions${query}`, { token });
  expect(r.status).toBe(200);
  return r.body.rows;
}

describe('PayPal disputes on the payments feed', () => {
  beforeEach(async () => { await resetDb(); });

  it('attaches a case to the transaction it names, and re-syncing does not duplicate it', async () => {
    const provider = () => fakeProvider('paypal', paypalOut(), async () => [
      dispute({ disputeId: 'PP-D-1', txnIds: [TXN_A] }),
    ]);
    const first = await syncBankTransactions(testEnv, [provider()]);
    expect(first.perSource.paypal?.disputes).toBe(1);
    await syncBankTransactions(testEnv, [provider()]);

    const rows = await getTestDb()`SELECT dispute FROM bank_transactions WHERE external_id = ${TXN_A}`;
    expect(rows[0].dispute).toHaveLength(1);
    expect((rows[0].dispute as { disputeId: string }[])[0].disputeId).toBe('PP-D-1');
  });

  it('keeps a second case on the same payment instead of replacing the first', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', paypalOut(), async () => [
        dispute({ disputeId: 'PP-D-1', txnIds: [TXN_A], openedAt: new Date(NOW - 9 * DAY).toISOString() }),
        dispute({ disputeId: 'PP-D-2', txnIds: [TXN_A], openedAt: new Date(NOW - 2 * DAY).toISOString() }),
      ]),
    ]);
    const { token } = await loginAs(ALEX);
    const rows = await list(token, '?dispute=1');
    // One row, both cases, newest first — a join would have returned two rows
    // and quietly shortened the keyset page.
    expect(rows).toHaveLength(1);
    expect(rows[0].disputes?.map(d => d.disputeId)).toEqual(['PP-D-2', 'PP-D-1']);
  });

  it('matches on either the payer-side or the payee-side transaction id', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', paypalOut(), async () => [
        dispute({ disputeId: 'PP-D-1', txnIds: ['SOMEOTHERID12345X', TXN_A] }),
      ]),
    ]);
    const { token } = await loginAs(ALEX);
    expect(await list(token, '?dispute=1')).toHaveLength(1);
  });

  it('filters to cases we filed: an incoming disputed payment is left out', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', paypalOut([
        { externalId: TXN_IN, amount: 480, counterparty: 'A Customer', postedAt: new Date(NOW - 4 * DAY) },
      ]), async () => [
        dispute({ disputeId: 'PP-D-OURS', txnIds: [TXN_A] }),
        // A case against us sits on money coming in, and is not what the page
        // is for.
        dispute({ disputeId: 'PP-D-THEIRS', txnIds: [TXN_IN], amount: 480 }),
      ]),
    ]);
    const { token } = await loginAs(ALEX);
    const rows = await list(token, '?dispute=1');
    expect(rows.map(r => r.disputes?.[0].disputeId)).toEqual(['PP-D-OURS']);
  });

  it('leaves the case off an incoming payment in the unfiltered feed too', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', paypalOut([
        { externalId: TXN_IN, amount: 480, counterparty: 'A Customer', postedAt: new Date(NOW - 4 * DAY) },
      ]), async () => [
        dispute({ disputeId: 'PP-D-OURS', txnIds: [TXN_A] }),
        dispute({ disputeId: 'PP-D-THEIRS', txnIds: [TXN_IN], amount: 480 }),
      ]),
    ]);
    const { token } = await loginAs(ALEX);
    // Not behind ?dispute=1: the row payload has to agree with the tile and the
    // filter, or the incoming row badges red in the default list while the
    // Disputed tile reads 1 and clicking it never reaches that row.
    const rows = await list(token, '?status=all');
    const incoming = rows.find(r => r.amount === 480);
    const outgoing = rows.find(r => r.amount === -1240);
    expect(incoming?.disputes).toBeNull();
    expect(outgoing?.disputes?.[0].disputeId).toBe('PP-D-OURS');
  });

  it('counts the tile the same way the list filters it', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', paypalOut([
        { externalId: TXN_IN, amount: 480, postedAt: new Date(NOW - 4 * DAY) },
      ]), async () => [
        dispute({ disputeId: 'PP-D-OURS', txnIds: [TXN_A] }),
        dispute({ disputeId: 'PP-D-THEIRS', txnIds: [TXN_IN], amount: 480 }),
      ]),
    ]);
    const { token } = await loginAs(ALEX);
    const r = await api<{ disputes: { count: number; amount: number } }>(
      'GET', '/api/bank-transactions/stats', { token },
    );
    expect(r.status).toBe(200);
    expect(r.body.disputes).toEqual({ count: 1, amount: 1240 });
  });

  it('shows a linked payment under the filter — a disputed payment usually has a PO', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', paypalOut(), async () => [dispute({ disputeId: 'PP-D-1', txnIds: [TXN_A] })]),
    ]);
    const { token } = await loginAs(ALEX);
    const po = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: { category: 'RAM', lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    const [row] = await list(token, '?dispute=1');
    const linked = await api('POST', `/api/bank-transactions/${row.id}/link`, {
      token, body: { orderId: po.body.id },
    });
    expect(linked.status).toBe(200);

    const rows = await list(token, '?dispute=1');
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe(po.body.id);
  });

  it('badges the PayPal leg of a pair once, never the Mercury settlement', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', paypalOut(), async () => [dispute({ disputeId: 'PP-D-1', txnIds: [TXN_A] })]),
      // Same paypal_txn_id, parsed out of the bank description. Without the
      // source filter on the write, this leg would carry the case too.
      fakeProvider('mercury', [
        { externalId: 'm-settle', amount: -1240, paypalTxnId: TXN_A, postedAt: new Date(NOW - 2 * DAY) },
      ]),
    ]);
    const legs = await getTestDb()<{ external_id: string; dispute: unknown }[]>`
      SELECT external_id, dispute FROM bank_transactions ORDER BY external_id`;
    const mercury = legs.find(l => l.external_id === 'm-settle');
    expect(mercury?.dispute).toBeNull();

    const { token } = await loginAs(ALEX);
    const rows = await list(token, '?dispute=1');
    expect(rows).toHaveLength(1);
  });

  it('stores a case whose payment has not arrived yet without failing the sync', async () => {
    const r = await syncBankTransactions(testEnv, [
      fakeProvider('paypal', paypalOut(), async () => [
        dispute({ disputeId: 'PP-D-ORPHAN', txnIds: ['NOTINTHEFEEDYET1'] }),
      ]),
    ]);
    expect(r.perSource.paypal?.error).toBeUndefined();
    expect(r.perSource.paypal?.disputes).toBe(0);
  });

  it('lands the transactions even when the disputes API is refused', async () => {
    const r = await syncBankTransactions(testEnv, [
      fakeProvider('paypal', paypalOut(), async () => {
        throw new Error('paypal GET /v1/customer/disputes failed: HTTP 403 NOT_AUTHORIZED');
      }),
    ]);
    // The money still arrived; only the disputes half reports a problem, and it
    // reports it separately from the per-source sync error.
    expect(r.perSource.paypal?.error).toBeUndefined();
    expect(r.perSource.paypal?.inserted).toBe(1);
    expect(r.perSource.paypal?.disputeError).toMatch(/403/);

    const { token } = await loginAs(ALEX);
    const stats = await api<{ sources: { source: string; disputeError: string | null }[] }>(
      'GET', '/api/bank-transactions/stats', { token },
    );
    expect(stats.body.sources.find(s => s.source === 'paypal')?.disputeError).toMatch(/403/);
  });

  it('clears the recorded failure once the disputes API answers again', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', paypalOut(), async () => { throw new Error('HTTP 403'); }),
    ]);
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', paypalOut(), async () => [dispute({ disputeId: 'PP-D-1', txnIds: [TXN_A] })]),
    ]);
    const { token } = await loginAs(ALEX);
    const stats = await api<{ sources: { source: string; disputeError: string | null }[] }>(
      'GET', '/api/bank-transactions/stats', { token },
    );
    expect(stats.body.sources.find(s => s.source === 'paypal')?.disputeError).toBeNull();
  });

  it('leaves the feed alone when the filter is off', async () => {
    await syncBankTransactions(testEnv, [
      fakeProvider('paypal', paypalOut([
        { externalId: '9ZY87654WV321012K', amount: -89.99, postedAt: new Date(NOW - 6 * DAY) },
      ]), async () => [dispute({ disputeId: 'PP-D-1', txnIds: [TXN_A] })]),
    ]);
    const { token } = await loginAs(ALEX);
    expect(await list(token, '?status=all')).toHaveLength(2);
  });
});

describe('dispute timeline mapping', () => {
  const detail = {
    create_time: '2026-08-01T10:00:00Z',
    update_time: '2026-08-20T09:00:00Z',
    reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
    status: 'RESOLVED',
    dispute_life_cycle_stage: 'CHARGEBACK',
    dispute_amount: { currency_code: 'USD', value: '1240.00' },
    disputed_transactions: [{ buyer_transaction_id: 'abc12345678901234', seller_transaction_id: 'def12345678901234' }],
    dispute_outcome: { outcome_code: 'RESOLVED_BUYER_FAVOUR', amount_refunded: { currency_code: 'USD', value: '1240.00' } },
    adjudications: [
      { type: 'PAYOUT_TO_BUYER', adjudication_time: '2026-08-15T12:00:00Z', reason: 'NO_SELLER_RESPONSE', dispute_life_cycle_stage: 'CHARGEBACK' },
    ],
    fund_movements: [
      { party: 'BUYER', type: 'CREDIT', initiated_time: '2026-08-18T12:00:00Z', amount: { currency_code: 'USD', value: '1240.00' } },
    ],
  };

  it('orders every recorded event by when it happened', () => {
    expect(disputeTimeline(detail).map(e => [e.kind, e.code])).toEqual([
      ['opened', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED'],
      ['adjudication', 'PAYOUT_TO_BUYER'],
      ['money', 'CREDIT'],
      ['outcome', 'RESOLVED_BUYER_FAVOUR'],
    ]);
  });

  it('reads the deprecated money_movements when fund_movements is absent', () => {
    const { fund_movements, ...old } = detail;
    const entry = disputeTimeline({
      ...old,
      money_movements: [{ affected_party: 'BUYER', type: 'DEBIT', initiated_time: '2026-08-18T12:00:00Z' }],
    }).find(e => e.kind === 'money');
    expect(entry).toMatchObject({ code: 'DEBIT', party: 'BUYER' });
  });

  it('does not report NONE as an outcome', () => {
    const events = disputeTimeline({ ...detail, dispute_outcome: { outcome_code: 'NONE' } });
    expect(events.some(e => e.kind === 'outcome')).toBe(false);
  });

  it('takes both transaction ids, uppercased, and no counterparty detail', () => {
    const d = normalizeDispute({ dispute_id: 'PP-D-9', dispute_state: 'RESOLVED' }, detail);
    expect(d.txnIds).toEqual(['ABC12345678901234', 'DEF12345678901234']);
    // dispute_state lives only on the summary, everything else prefers the
    // detail document.
    expect(d.disputeState).toBe('RESOLVED');
    expect(d.lifeCycleStage).toBe('CHARGEBACK');
    expect(d.refundedAmount).toBe(1240);
    expect(JSON.stringify(d)).not.toContain('buyer_transaction_id');
  });
});
