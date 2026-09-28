import type {
  BankProvider, BankSource, NormalizedDispute, NormalizedTxn,
} from '../../src/banktx/types';

// Pinned once per test file (vitest re-evaluates this module per file), so a
// fixture's `postedAt` and the default below agree to the millisecond.
export const NOW = Date.now();
export const DAY = 24 * 60 * 60 * 1000;

export type TxnSpec = Partial<NormalizedTxn> & { externalId: string; amount: number };

// `disputes` is a function so a test can make it throw — the point of hanging
// it off the provider rather than off fetchSince is that it can fail alone.
export function fakeProvider(
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
