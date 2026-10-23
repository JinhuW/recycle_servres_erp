// Accounting: the managers' own book of money received and paid, kept in RMB.
// The vocabulary the backend route, the API client and both shells agree on.

export const ACCOUNTING_DIRECTIONS = ['in', 'out'] as const;
export type AccountingDirection = typeof ACCOUNTING_DIRECTIONS[number];

// Named after the record an entry is for. The link each one carries is
// KIND_TARGET; `other` is money that belongs to no record.
export const ACCOUNTING_KINDS = ['purchase', 'commission', 'sale', 'after_sales', 'other'] as const;
export type AccountingKind = typeof ACCOUNTING_KINDS[number];

export const ACCOUNTING_METHODS = ['bank', 'alipay', 'wechat', 'cash', 'other'] as const;
export type AccountingMethod = typeof ACCOUNTING_METHODS[number];

// RMB is the book's currency; a dollar entry carries the rate it was booked at.
export const ACCOUNTING_CURRENCIES = ['CNY', 'USD'] as const;
export type AccountingCurrency = typeof ACCOUNTING_CURRENCIES[number];

export type AccountingTargetType = 'po' | 'so' | 'as';

export const KIND_TARGET: Record<AccountingKind, AccountingTargetType | null> = {
  purchase: 'po',
  commission: 'po',
  sale: 'so',
  after_sales: 'as',
  other: null,
};

// What the money usually does for each kind. A refund is the same kind with
// the direction flipped, so this is a default, not a rule.
export const KIND_DEFAULT_DIRECTION: Record<AccountingKind, AccountingDirection> = {
  purchase: 'out',
  commission: 'out',
  sale: 'in',
  after_sales: 'out',
  other: 'out',
};

export const isAccountingKind = (v: unknown): v is AccountingKind =>
  typeof v === 'string' && (ACCOUNTING_KINDS as readonly string[]).includes(v);
export const isAccountingMethod = (v: unknown): v is AccountingMethod =>
  typeof v === 'string' && (ACCOUNTING_METHODS as readonly string[]).includes(v);
export const isAccountingDirection = (v: unknown): v is AccountingDirection =>
  typeof v === 'string' && (ACCOUNTING_DIRECTIONS as readonly string[]).includes(v);
export const isAccountingCurrency = (v: unknown): v is AccountingCurrency =>
  typeof v === 'string' && (ACCOUNTING_CURRENCIES as readonly string[]).includes(v);

// ── Review ──────────────────────────────────────────────────────────────────
// One manager who didn't write an entry signs it off. `open` is To review;
// `changed` is To review after an edit cleared an earlier sign-off. A voided
// entry has no state at all.
export const ACCOUNTING_REVIEW_STATES = ['open', 'changed', 'queried', 'reviewed'] as const;
export type AccountingReviewState = typeof ACCOUNTING_REVIEW_STATES[number];
export const isAccountingReviewState = (v: unknown): v is AccountingReviewState =>
  typeof v === 'string' && (ACCOUNTING_REVIEW_STATES as readonly string[]).includes(v);

// Review mode's lists. `mine` is what the viewer can sign off; `others` is
// what the viewer wrote and waits on someone else.
export const ACCOUNTING_REVIEW_TABS = ['mine', 'queried', 'others', 'reviewed'] as const;
export type AccountingReviewTab = typeof ACCOUNTING_REVIEW_TABS[number];

export const ACCOUNTING_QUERY_MAX = 280;

// The fields a sign-off covers. The note explains an entry without changing
// it, so editing the note keeps the review — the sell order's sign-off rule.
export const ACCOUNTING_UNREVIEWED_FIELDS = ['note'] as const;

// Who may do what about an entry's review. The API refuses with
// accountingReviewRefusal and the pages offer buttons with
// accountingReviewActions, so a page never offers what the API would refuse.
export const ACCOUNTING_REVIEW_ACTIONS = ['review', 'withdraw', 'query', 'answer', 'withdrawQuery'] as const;
export type AccountingReviewAction = typeof ACCOUNTING_REVIEW_ACTIONS[number];

// An entry as the rules read it. `state` is null once the entry is voided.
export type AccountingReviewSubject = {
  state: AccountingReviewState | null;
  authorId: string | null;
  reviewedBy: string | null;
  queryBy: string | null;
  queryTo: string | null;
  // Who a new question goes to: the author, or for an entry nobody wrote
  // (the backfill) the manager whose money it was.
  addressee: string;
};

export type AccountingReviewRefusal =
  | 'voided' | 'reviewed' | 'own' | 'notReviewed' | 'notReviewer'
  | 'openQuestion' | 'yours' | 'noQuestion' | 'notAddressee' | 'notAsker';

/**
 * Why `me` may not take `action` on an entry, or null when they may. The
 * author never signs off their own version; a sign-off may close an open
 * question; only the reviewer withdraws a sign-off, only the asker a
 * question, and only its addressee answers it.
 */
export function accountingReviewRefusal(
  s: AccountingReviewSubject, me: string, action: AccountingReviewAction,
): AccountingReviewRefusal | null {
  switch (action) {
    case 'review':
      if (s.state === null) return 'voided';
      if (s.state === 'reviewed') return 'reviewed';
      return s.authorId === me ? 'own' : null;
    case 'withdraw':
      if (s.state !== 'reviewed') return 'notReviewed';
      return s.reviewedBy === me ? null : 'notReviewer';
    case 'query':
      if (s.state === null) return 'voided';
      if (s.state === 'reviewed') return 'reviewed';
      if (s.state === 'queried') return 'openQuestion';
      if (s.authorId === me) return 'own';
      return s.addressee === me ? 'yours' : null;
    case 'answer':
      if (s.state !== 'queried') return 'noQuestion';
      return s.queryTo === me ? null : 'notAddressee';
    case 'withdrawQuery':
      if (s.state !== 'queried') return 'noQuestion';
      return s.queryBy === me ? null : 'notAsker';
  }
}

/** Each action `me` may take, and `own`: the entry waits on someone else
 *  because `me` wrote this version. */
export function accountingReviewActions(s: AccountingReviewSubject, me: string) {
  const can = (a: AccountingReviewAction) => accountingReviewRefusal(s, me, a) === null;
  return {
    review: can('review'), withdraw: can('withdraw'), query: can('query'),
    answer: can('answer'), withdrawQuery: can('withdrawQuery'),
    own: s.state !== null && s.state !== 'reviewed' && s.authorId === me,
  };
}

export type AccountingChanges = Record<string, { from: unknown; to: unknown }>;

/**
 * A run of edits read as one: each field from its first old value to its
 * last new one. A field put back as it was drops out. What Review mode and
 * the entry drawer show as changed since a sign-off was cleared.
 */
export function foldChanges(edits: readonly (AccountingChanges | null | undefined)[]): AccountingChanges {
  const out: AccountingChanges = {};
  for (const changes of edits) {
    for (const [k, ch] of Object.entries(changes ?? {})) {
      out[k] = { from: k in out ? out[k].from : ch.from, to: ch.to };
    }
  }
  for (const k of Object.keys(out)) if (JSON.stringify(out[k].from) === JSON.stringify(out[k].to)) delete out[k];
  return out;
}

// What the server knows about an entry that a reviewer weighs it against.
export type AccountingReviewFacts = {
  // The record's own figure, in its own currency, and what the whole book has
  // against it. Null for an Other entry, or one whose record was deleted.
  record: { amount: number | null; currency: AccountingCurrency; recordedCny: number } | null;
  // CNY per 1 USD in the FX ledger on the entry's date.
  ledgerRate: number | null;
  // Another live entry that looks like the same money.
  duplicateOf: string | null;
  // A sale whose sell order also has a live Mercury/PayPal deposit linked as
  // its payment: that money is the Business Account's, on Payments. Optional
  // for a backend older than the check.
  businessReceived?: boolean;
};

export type AccountingCheck =
  | { kind: 'record'; tone: 'ok' | 'warn' | 'info'; verdict: 'matches' | 'over' | 'short';
      figureCny: number; recordedCny: number; diffCny: number }
  | { kind: 'noFigure'; tone: 'info' }
  | { kind: 'noRecord'; tone: 'info' }
  | { kind: 'recordGone'; tone: 'info' }
  | { kind: 'rate'; tone: 'warn'; rate: number; ledgerRate: number; pct: number }
  | { kind: 'duplicate'; tone: 'warn'; of: string }
  | { kind: 'businessReceived'; tone: 'warn' };

// A booked figure within 1% or ¥10 of the record's own is the same money:
// commissions round, and a dollar figure moves with the rate.
const RECORD_TOLERANCE_PCT = 0.01;
const RECORD_TOLERANCE_CNY = 10;
// A dollar entry's rate this far from the ledger's for its day was likely mistyped.
const RATE_TOLERANCE_PCT = 0.02;
// Two entries this many days apart with the same amount, method and record
// look like one payment booked twice.
export const ACCOUNTING_DUPLICATE_DAYS = 7;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The checks Review mode shows on an entry. Hints, never gates: a warning
 * keeps an entry out of the bulk sign-off, nothing more. Being short is
 * information, not a warning — a sale arrives in part-payments and a PO is
 * often partly company-paid — but being over is money nobody asked for.
 */
export function accountingChecks(
  e: { kind: AccountingKind; currency: AccountingCurrency; fxRate: number | null; hasTarget: boolean },
  f: AccountingReviewFacts,
): AccountingCheck[] {
  const out: AccountingCheck[] = [];
  if (e.kind === 'other') out.push({ kind: 'noRecord', tone: 'info' });
  else if (!e.hasTarget || !f.record) out.push({ kind: 'recordGone', tone: 'info' });
  else {
    const r = f.record;
    const figureCny = r.amount === null ? null
      : r.currency === 'CNY' ? r.amount
      : f.ledgerRate === null ? null : round2(r.amount * f.ledgerRate);
    if (figureCny === null) out.push({ kind: 'noFigure', tone: 'info' });
    else {
      const diffCny = round2(r.recordedCny - figureCny);
      const tolerance = Math.max(RECORD_TOLERANCE_CNY, Math.abs(figureCny) * RECORD_TOLERANCE_PCT);
      const verdict = Math.abs(diffCny) <= tolerance ? 'matches' : diffCny > 0 ? 'over' : 'short';
      out.push({
        kind: 'record', verdict, figureCny, recordedCny: r.recordedCny, diffCny,
        tone: verdict === 'matches' ? 'ok' : verdict === 'over' ? 'warn' : 'info',
      });
    }
  }
  if (e.currency === 'USD' && e.fxRate !== null && f.ledgerRate !== null && f.ledgerRate > 0) {
    const pct = e.fxRate / f.ledgerRate - 1;
    if (Math.abs(pct) > RATE_TOLERANCE_PCT) {
      out.push({ kind: 'rate', tone: 'warn', rate: e.fxRate, ledgerRate: f.ledgerRate, pct });
    }
  }
  if (f.duplicateOf) out.push({ kind: 'duplicate', tone: 'warn', of: f.duplicateOf });
  // Part of a sale can still reach a manager, so it is a warning, not a refusal.
  if (e.kind === 'sale' && f.businessReceived) out.push({ kind: 'businessReceived', tone: 'warn' });
  return out;
}

export const hasAccountingWarning = (checks: readonly AccountingCheck[]) => checks.some(c => c.tone === 'warn');
