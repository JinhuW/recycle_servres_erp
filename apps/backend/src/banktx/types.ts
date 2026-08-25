// Bank-transaction sync: provider-neutral shapes. Amounts are signed dollars
// (negative = money out to a seller, positive = money coming back in) — there
// is no separate direction field anywhere in the pipeline.

export type BankSource = 'mercury' | 'paypal';

export type NormalizedTxn = {
  source: BankSource;
  externalId: string;
  accountExternalId: string;
  postedAt: Date;
  amount: number;
  counterparty: string | null;
  description: string | null;
  // PayPal legs: the transaction id itself. Mercury legs: parsed from the
  // bank description when it mentions PayPal. Feeds auto-pair + auto-link.
  paypalTxnId: string | null;
  raw: unknown;
};

export type BankAccountInfo = {
  externalId: string;
  name: string | null;
};

export type BankFetch = {
  accounts: BankAccountInfo[];
  txns: NormalizedTxn[];
};

export type BankProvider = {
  source: BankSource;
  // sinceIso already includes the sync overlap window; providers just fetch.
  fetchSince(sinceIso: string): Promise<BankFetch>;
};
