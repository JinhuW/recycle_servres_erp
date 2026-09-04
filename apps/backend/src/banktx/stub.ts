// Deterministic canned transactions for local UI work. Activated only by the
// explicit BANKTX_STUB flag — never as a silent fallback for missing keys
// (the OCR module's silent stub already burned us once).

import type {
  BankFetch, BankProvider, BankTxnCategory, NormalizedDispute, NormalizedTxn, SettleStatus,
} from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

function txn(
  partial: Omit<NormalizedTxn, 'raw' | 'category' | 'settleStatus'>
    & { category?: BankTxnCategory; settleStatus?: SettleStatus },
): NormalizedTxn {
  return {
    category: 'external', settleStatus: 'settled', ...partial,
    raw: { stub: true, id: partial.externalId },
  };
}

// A fixed anchor keeps re-syncs idempotent within a process while staying
// recent enough to land inside the default backfill window.
const anchor = Date.now() - (Date.now() % DAY_MS);

export function stubMercuryProvider(): BankProvider {
  return {
    source: 'mercury',
    async fetchSince(): Promise<BankFetch> {
      return {
        accounts: [{ externalId: 'stub-checking', name: 'Mercury Checking (stub)' }],
        txns: [
          // Settlement leg of the PayPal payment below (reference match).
          txn({
            source: 'mercury', externalId: 'stub-m-1', accountExternalId: 'stub-checking',
            postedAt: new Date(anchor - 2 * DAY_MS), amount: -1240,
            counterparty: 'PayPal', description: 'PAYPAL TRANSFER 7AB12345CD678901E',
            paypalTxnId: '7AB12345CD678901E',
          }),
          // Direct wire to a seller — the unlinked-queue case.
          txn({
            source: 'mercury', externalId: 'stub-m-2', accountExternalId: 'stub-checking',
            postedAt: new Date(anchor - 5 * DAY_MS), amount: -560,
            counterparty: 'Reddit Seller LLC', description: 'Wire transfer', paypalTxnId: null,
          }),
          // A refund coming back in.
          txn({
            source: 'mercury', externalId: 'stub-m-3', accountExternalId: 'stub-checking',
            postedAt: new Date(anchor - 1 * DAY_MS), amount: 120,
            counterparty: 'Reddit Seller LLC', description: 'Returned payment', paypalTxnId: null,
          }),
          // Not a seller payment at all — the Ignore case.
          txn({
            source: 'mercury', externalId: 'stub-m-4', accountExternalId: 'stub-checking',
            postedAt: new Date(anchor - 3 * DAY_MS), amount: -312.55,
            counterparty: 'AWS', description: 'AWS EMEA', paypalTxnId: null,
          }),
          // Bank side of a PayPal top-up — transfer-pairs with stub-p-topup.
          txn({
            source: 'mercury', externalId: 'stub-m-5', accountExternalId: 'stub-checking',
            postedAt: new Date(anchor - 4 * DAY_MS), amount: -800,
            counterparty: 'PayPal', description: 'PAYPAL TRANSFER', paypalTxnId: null,
          }),
          // An ACH still in flight — no posted date on the wire, so it is
          // dated by creation. Stays in the queue, badged.
          txn({
            source: 'mercury', externalId: 'stub-m-6', accountExternalId: 'stub-checking',
            postedAt: new Date(anchor - 6 * DAY_MS), amount: -1875,
            counterparty: 'Rack & Stack Ltd', description: 'ACH to seller', paypalTxnId: null,
            settleStatus: 'pending',
          }),
        ],
      };
    },
  };
}

export function stubPaypalProvider(): BankProvider {
  return {
    source: 'paypal',
    async fetchSince(): Promise<BankFetch> {
      return {
        accounts: [{ externalId: 'primary', name: 'PayPal (stub)' }],
        txns: [
          txn({
            source: 'paypal', externalId: '7AB12345CD678901E', accountExternalId: 'primary',
            postedAt: new Date(anchor - 3 * DAY_MS), amount: -1240,
            counterparty: "John's Servers", description: 'RAM lot payment',
            paypalTxnId: '7AB12345CD678901E',
          }),
          txn({
            source: 'paypal', externalId: '9ZY87654WV321012K', accountExternalId: 'primary',
            postedAt: new Date(anchor - 6 * DAY_MS), amount: -89.99,
            counterparty: 'Parts Plus', description: 'Heatsinks',
            paypalTxnId: '9ZY87654WV321012K',
          }),
          // Funding credit from the bank (T0300 shape) — the Transfers case.
          txn({
            source: 'paypal', externalId: '5TR00000TRANSFER1', accountExternalId: 'primary',
            postedAt: new Date(anchor - 4 * DAY_MS), amount: 800,
            counterparty: null, description: 'Bank Deposit to PP Account',
            paypalTxnId: '5TR00000TRANSFER1', category: 'transfer',
          }),
          // A large payment sitting pending — the case that prompted all this.
          // In the queue and in the totals; its Mercury pull has not arrived.
          txn({
            source: 'paypal', externalId: '1PENDING0000STUB1', accountExternalId: 'primary',
            postedAt: new Date(anchor - 15 * DAY_MS), amount: -20570,
            counterparty: 'Kody Orr', description: 'Server lot',
            paypalTxnId: '1PENDING0000STUB1', settleStatus: 'pending',
          }),
          // Denied: a record, not a task. Out of the queue and every tile,
          // reachable only through the settlement filter.
          txn({
            source: 'paypal', externalId: '2DENIED00000STUB1', accountExternalId: 'primary',
            postedAt: new Date(anchor - 8 * DAY_MS), amount: -430,
            counterparty: 'Parts Plus', description: 'Declined by PayPal',
            paypalTxnId: '2DENIED00000STUB1', settleStatus: 'failed',
          }),
        ],
      };
    },
    // One live case against the RAM lot payment, so the badge, the filter and
    // the timeline all have something to render without credentials.
    async fetchDisputes(): Promise<NormalizedDispute[]> {
      return [{
        disputeId: 'PP-D-STUB001',
        txnIds: ['7AB12345CD678901E'],
        reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
        status: 'WAITING_FOR_SELLER_RESPONSE',
        disputeState: 'REQUIRED_OTHER_PARTY_ACTION',
        lifeCycleStage: 'INQUIRY',
        channel: 'INTERNAL',
        amount: 1240,
        currency: 'USD',
        outcomeCode: null,
        refundedAmount: null,
        openedAt: new Date(anchor - 2 * DAY_MS).toISOString(),
        updatedAt: new Date(anchor - DAY_MS).toISOString(),
        buyerResponseDueAt: null,
        sellerResponseDueAt: new Date(anchor + 5 * DAY_MS).toISOString(),
        timeline: [{
          at: new Date(anchor - 2 * DAY_MS).toISOString(),
          kind: 'opened', code: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
          stage: null, party: null, amount: 1240,
        }],
      }];
    },
  };
}
