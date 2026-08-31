// Deterministic canned transactions for local UI work. Activated only by the
// explicit BANKTX_STUB flag — never as a silent fallback for missing keys
// (the OCR module's silent stub already burned us once).

import type { BankFetch, BankProvider, BankTxnCategory, NormalizedTxn } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

function txn(
  partial: Omit<NormalizedTxn, 'raw' | 'category'> & { category?: BankTxnCategory },
): NormalizedTxn {
  return { category: 'external', ...partial, raw: { stub: true, id: partial.externalId } };
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
        ],
      };
    },
  };
}
