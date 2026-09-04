// Bank-transaction sync: provider-neutral shapes. Amounts are signed dollars
// (negative = money out to a seller, positive = money coming back in) — there
// is no separate direction field anywhere in the pipeline.

export type BankSource = 'mercury' | 'paypal';

// 'transfer' = an internal Mercury<->PayPal move (top-up, withdrawal, the
// funding leg of a bank-funded payment) — never linkable to a purchase order.
export type BankTxnCategory = 'external' | 'transfer';

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
  // Only PayPal metadata can classify at fetch time; Mercury legs arrive
  // 'external' and are reclassified when transfer-pairing settles them.
  category: BankTxnCategory;
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

// One dated thing that happened to a case. `code` is PayPal's own enum value
// (an adjudication type, a fund-movement type, an outcome code) rather than
// prose, so the page translates it like every other label.
export type DisputeTimelineEntry = {
  at: string;
  kind: 'opened' | 'adjudication' | 'money' | 'outcome';
  code: string | null;
  stage: string | null;
  party: string | null;
  amount: number | null;
};

// A PayPal case as we store it. Message threads, evidence and the buyer/seller
// blocks PayPal returns are deliberately absent: the ask was for status, and
// the rest is correspondence and counterparty PII.
export type NormalizedDispute = {
  disputeId: string;
  // Both the payer-side and payee-side ids PayPal names for the disputed
  // payment; either may be the one our transaction feed knows.
  txnIds: string[];
  reason: string | null;
  status: string | null;
  disputeState: string | null;
  lifeCycleStage: string | null;
  channel: string | null;
  amount: number | null;
  currency: string | null;
  outcomeCode: string | null;
  refundedAmount: number | null;
  openedAt: string | null;
  updatedAt: string | null;
  buyerResponseDueAt: string | null;
  sellerResponseDueAt: string | null;
  timeline: DisputeTimelineEntry[];
};

export type BankProvider = {
  source: BankSource;
  // sinceIso already includes the sync overlap window; providers just fetch.
  fetchSince(sinceIso: string): Promise<BankFetch>;
  // PayPal only, and kept off `fetchSince` on purpose: disputes are a second
  // API behind a second app permission, so they have to be able to fail without
  // taking the transaction feed with them.
  fetchDisputes?(): Promise<NormalizedDispute[]>;
};
