import { useEffect, useState } from 'react';
import { api } from './api';
import type { PaidBy } from './useCommissionPaidBy';
import {
  addDays, addMonths, startOfMonth, startOfYear, todayIn,
  type AccountingCheck, type AccountingCurrency, type AccountingDirection, type AccountingKind,
  type AccountingMethod, type AccountingReviewFacts, type AccountingReviewState, type AccountingReviewTab,
  type AccountingTargetType, type IsoDate,
} from '@recycle-erp/shared';

// The RMB Flow: the API client both shells use, and the small pure helpers
// its pages share.

export type AcctEntry = {
  id: string; direction: AccountingDirection; kind: AccountingKind;
  amount: number; currency: AccountingCurrency; fxRate: number | null; amountCny: number;
  method: AccountingMethod; occurredOn: IsoDate;
  // Who paid. On a PO's entry it is the PO's own payer, kept in step both
  // ways; a PO the Business Account paid voids its entries instead.
  manager: { id: string; name: string };
  target: { type: AccountingTargetType; id: string } | null;
  counterparty: string | null; reference: string | null; note: string | null;
  createdAt: string; updatedAt: string;
  createdBy: { id: string; name: string } | null;
  voided: { at: string; by: string | null; reason: string } | null;
  // Null once voided: a voided entry is out of review.
  review: AcctReview | null;
};

export type AcctPerson = { id: string; name: string };

export type AcctReview = {
  state: AccountingReviewState;
  // What a sign-off names, so a stale page can't sign off another version.
  version: string;
  // Whoever wrote the version on the book; null for a backfilled entry.
  author: AcctPerson | null;
  by: AcctPerson | null;
  at: string | null;
  clearedAt: string | null;
  query: {
    by: AcctPerson | null; text: string; at: string; to: AcctPerson | null;
    // An answer with no text is an edit that fixed the entry.
    answer: { by: AcctPerson | null; text: string | null; at: string } | null;
  } | null;
};

export type AcctRow = AcctEntry & { balance: number | null };

// A record an entry can be for, as the picker and the cards show it: its own
// figure in its own currency, and what the book already has against it.
export type AcctTarget = {
  id: string; status: string; party: string | null;
  amount: number | null; currency: AccountingCurrency; recordedCny: number;
  // Whose hands the record says the money went through — a PO's cost payer
  // or commission payer. The form offers them as the manager; one who is not
  // an active manager falls back to the recorder. Optional for deploy skew.
  payerId?: string | null;
  // The payer as the picker reads it: the person's name, or the Business
  // Account — a PO's cost paid from the company's account, or a commission
  // the company paid (on file, or a Mercury/PayPal row linked as it).
  payerName?: string | null;
  // The PO the Business Account paid takes no RMB entry: the form and the
  // card say so and point to Payments.
  payerBusiness?: boolean;
  // The purchaser may be a self-paid cost's payer.
  owner?: { id: string; name: string };
};

export type AcctEvent = {
  id: string;
  kind: 'created' | 'edited' | 'voided' | 'restored' | 'unlinked'
    | 'reviewed' | 'unreviewed' | 'queried' | 'answered' | 'query_withdrawn';
  detail: {
    changes?: Record<string, { from: unknown; to: unknown }>; reason?: string; orderId?: string;
    backfilled?: 'commission_paid_by' | 'payment_received_by' | 'payer';
    // Written by the PO's side of the link, not by a person.
    synced?: 'po';
    text?: string; amountCny?: number;
    clearedReview?: { by: string | null; at: string };
  };
  at: string; actor: { id: string; name: string } | null;
};

export type AcctEntryDetail = AcctEntry & { targetFacts: AcctTarget | null; events: AcctEvent[] };

export type AcctFx = { rate: number; source: string; effectiveDate: string };

export type AcctSummary = {
  from: IsoDate; to: IsoDate;
  opening: number; received: number; paid: number; closing: number;
  byKind: Record<AccountingKind, { received: number; paid: number; count: number }>;
  managers: { id: string; name: string; balance: number }[];
  first: IsoDate | null;
  fx: AcctFx;
  // Optional: a backend older than Review mode sends none.
  review?: {
    entries: number; reviewed: number; changed: number; queried: number;
    forMe: number; waitingOnOthers: number; movedCny: number; reviewedCny: number; activeManagers: number;
  };
};

// A row of Review mode: the entry, what it is weighed against, and every
// field changed since an earlier sign-off was cleared.
export type AcctReviewRow = AcctEntry & {
  targetFacts: AcctTarget | null;
  facts: AccountingReviewFacts;
  checks: AccountingCheck[];
  cleared: {
    reviewer: AcctPerson | null; at: string; changes: Record<string, { from: unknown; to: unknown }>;
    // The last change was the PO's payer moving the entry's Paid by.
    followedPo: boolean;
  } | null;
};

export type AcctReviewQueue = {
  rows: AcctReviewRow[];
  counts: Record<AccountingReviewTab, number>;
  truncated: boolean;
};

export type AcctLedger = {
  entries: AcctEntry[];
  net: number;
  target: AcctTarget & { amountCny: number | null };
  fx: AcctFx;
};

export type AcctEntryBody = {
  direction: AccountingDirection; kind: AccountingKind; amount: number; currency: AccountingCurrency;
  fxRate: number | null; method: AccountingMethod; occurredOn: IsoDate; managerId: string;
  targetId: string | null; counterparty: string | null; reference: string | null; note: string | null;
};

// Which record's side of the book a card shows.
export type AcctScope =
  | { orderId: string; kind: 'purchase' | 'commission' }
  | { sellOrderId: string }
  | { afterSalesId: string };

const enc = encodeURIComponent;

export const acctSummary = (q: { from: IsoDate; to: IsoDate; managerId?: string }) =>
  api.get<AcctSummary>('/api/accounting/summary?' + new URLSearchParams(
    { from: q.from, to: q.to, ...(q.managerId ? { managerId: q.managerId } : {}) }));
export const acctEntries = (query: string) =>
  api.get<{ rows: AcctRow[]; nextCursor: string | null }>('/api/accounting/entries' + (query ? '?' + query : ''));
export const acctEntry = (id: string) =>
  api.get<{ entry: AcctEntryDetail }>(`/api/accounting/entries/${enc(id)}`);
export const acctCreate = (body: AcctEntryBody) =>
  api.post<{ id: string; commissionPaidBy?: PaidBy }>('/api/accounting/entries', body).then(reviewChanged);
export const acctPatch = (id: string, body: Partial<AcctEntryBody>) =>
  api.patch<{ ok: true; commissionPaidBy?: PaidBy }>(`/api/accounting/entries/${enc(id)}`, body).then(reviewChanged);
export const acctVoid = (id: string, reason: string) =>
  api.post<{ ok: true }>(`/api/accounting/entries/${enc(id)}/void`, { reason }).then(reviewChanged);
export const acctRestore = (id: string) =>
  api.post<{ ok: true }>(`/api/accounting/entries/${enc(id)}/restore`, {}).then(reviewChanged);
export const acctReviewQueue = (tab: AccountingReviewTab, managerId?: string) =>
  api.get<AcctReviewQueue>('/api/accounting/review?' + new URLSearchParams({ tab, ...(managerId ? { managerId } : {}) }));
export const acctMarkReviewed = (id: string, version: string) =>
  api.post<{ ok: true }>(`/api/accounting/entries/${enc(id)}/review`, { version }).then(reviewChanged);
export const acctWithdrawReview = (id: string) =>
  api.delete<{ ok: true }>(`/api/accounting/entries/${enc(id)}/review`).then(reviewChanged);
export const acctAsk = (id: string, text: string) =>
  api.post<{ ok: true }>(`/api/accounting/entries/${enc(id)}/query`, { text }).then(reviewChanged);
export const acctWithdrawQuery = (id: string) =>
  api.delete<{ ok: true }>(`/api/accounting/entries/${enc(id)}/query`).then(reviewChanged);
export const acctAnswer = (id: string, text: string) =>
  api.post<{ ok: true }>(`/api/accounting/entries/${enc(id)}/answer`, { text }).then(reviewChanged);
// POST /review/bulk's cap per request; a longer queue goes in batches.
export const ACCT_BULK_MAX = 200;
export const acctBulkReview = (entries: { id: string; version: string }[]) =>
  api.post<{ reviewed: string[]; skipped: { id: string; reason: string }[] }>('/api/accounting/review/bulk', { entries })
    .then(reviewChanged);
export const acctTargets = (kind: AccountingKind, q: string) =>
  api.get<{ candidates: AcctTarget[] }>('/api/accounting/targets?' + new URLSearchParams({ kind, ...(q ? { q } : {}) }));

export function acctLedgerPath(scope: AcctScope): string {
  if ('orderId' in scope) return `/api/accounting/by-order/${enc(scope.orderId)}?kind=${scope.kind}`;
  if ('sellOrderId' in scope) return `/api/accounting/by-sell-order/${enc(scope.sellOrderId)}`;
  return `/api/accounting/by-after-sales/${enc(scope.afterSalesId)}`;
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** A money figure cut where a ledger cuts it: sign, whole yuan, and the
 *  jiao/fen the book prints quieter. */
export function splitYuan(n: number, locale: string): { sign: '' | '−'; whole: string; fraction: string } {
  const parts = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .formatToParts(Math.abs(n));
  let whole = '';
  let fraction = '';
  let seenDecimal = false;
  for (const p of parts) {
    if (p.type === 'decimal') seenDecimal = true;
    if (seenDecimal) fraction += p.value; else whole += p.value;
  }
  // Rounds to -0.00 for a tiny negative: no sign on a zero.
  return { sign: n < 0 && Math.abs(n) >= 0.005 ? '−' : '', whole, fraction };
}

export function fmtCny(n: number, locale: string): string {
  const s = splitYuan(n, locale);
  return `${s.sign}¥${s.whole}${s.fraction}`;
}

/** `+¥…` received, `−¥…` paid: an entry's figure as the phone lists it. */
export function fmtSignedCny(n: number, locale: string): string {
  return (n < 0 ? '−' : '+') + fmtCny(Math.abs(n), locale);
}

/** "Oct 21" for a calendar date, read as written rather than as a moment. */
export function fmtBookDay(d: IsoDate, locale: string, withYear = false): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short', day: 'numeric', timeZone: 'UTC', ...(withYear ? { year: 'numeric' } : {}),
  }).format(new Date(d + 'T00:00:00Z'));
}

/** Whether each row is the first of its day, so the book prints the date once. */
export function markDayStarts(rows: readonly { occurredOn: string }[]): boolean[] {
  return rows.map((r, i) => i === 0 || rows[i - 1].occurredOn !== r.occurredOn);
}

/** An entry's figure with its sign: received counts up, paid down. */
export const signedCny = (e: Pick<AcctEntry, 'direction' | 'amountCny'>) =>
  e.direction === 'in' ? e.amountCny : -e.amountCny;

/**
 * What a CNY sell order still has to bring in: its total less what was booked
 * on the order itself. A case's refund settles the case; it doesn't reopen
 * what the buyer owes.
 */
export function owedOnSale(
  amount: number, entries: readonly Pick<AcctEntry, 'kind' | 'direction' | 'amountCny'>[],
): number {
  const paid = entries.filter(e => e.kind === 'sale').reduce((sum, e) => sum + signedCny(e), 0);
  return Math.round((amount - paid) * 100) / 100;
}

// ── Dates ───────────────────────────────────────────────────────────────────

// The book's dates are calendar dates as the manager typed them, so "today"
// is the viewer's own — not the dashboard's Denver clock (REPORTING_TZ). The
// managers who keep RMB books are a day ahead of Denver for most of theirs.
export function localToday(now: Date = new Date()): IsoDate {
  return todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone, now);
}

export const PHONE_PERIODS = ['month', 'lastMonth', '30d', 'year'] as const;
export type PhonePeriod = typeof PHONE_PERIODS[number];

export function phonePeriod(p: PhonePeriod, today: IsoDate): { from: IsoDate; to: IsoDate } {
  switch (p) {
    case 'month': return { from: startOfMonth(today), to: today };
    case 'lastMonth': {
      const from = startOfMonth(addMonths(startOfMonth(today), -1));
      return { from, to: addDays(startOfMonth(today), -1) };
    }
    case '30d': return { from: addDays(today, -29), to: today };
    case 'year': return { from: startOfYear(today), to: today };
  }
}

// ── Review ──────────────────────────────────────────────────────────────────

// Fired after any write that can move a count: a sign-off, a question, an
// edit or a void. The sidebar badge and the page header listen.
const REVIEW_CHANGED = 'acct-review-changed';
export function reviewChanged<T>(r: T): T {
  window.dispatchEvent(new Event(REVIEW_CHANGED));
  return r;
}

/** What waits on the viewer: entries to sign off, and questions to answer. */
export function useAcctReviewCount(enabled: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => {
      api.get<{ forMe: number; asked: number }>('/api/accounting/review/count')
        // A badge that fails to load stays as it was; it is never worth a dialog.
        .then(r => { if (alive) setN(r.forMe + r.asked); }, () => {});
    };
    load();
    window.addEventListener(REVIEW_CHANGED, load);
    return () => { alive = false; window.removeEventListener(REVIEW_CHANGED, load); };
  }, [enabled]);
  return enabled ? n : 0;
}

/**
 * What the viewer may do about an entry's review — the server's rules, so a
 * button is never offered that the API would refuse. The author never signs
 * off their own version; a question goes to the author or, for an entry
 * nobody wrote, to the manager whose money it was.
 */
export function reviewActions(e: Pick<AcctEntry, 'review' | 'manager'>, me: string) {
  const r = e.review;
  const none = { review: false, withdraw: false, query: false, answer: false, withdrawQuery: false, own: false };
  if (!r) return none;
  const own = r.author?.id === me;
  const addressee = r.author?.id ?? e.manager.id;
  const open = r.state === 'open' || r.state === 'changed';
  return {
    review: !own && r.state !== 'reviewed',
    withdraw: r.state === 'reviewed' && r.by?.id === me,
    query: !own && open && addressee !== me,
    answer: r.state === 'queried' && r.query?.to?.id === me,
    withdrawQuery: r.state === 'queried' && r.query?.by?.id === me,
    own: own && r.state !== 'reviewed',
  };
}

/**
 * Every field changed since a sign-off was cleared, from what the reviewer
 * signed to what the entry says now, read off the entry's own history. A
 * field put back as it was drops out. The server's Review mode rows carry
 * the same thing, worked out the same way.
 */
export function changesSinceReview(events: readonly AcctEvent[], clearedAt: string | null) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  if (!clearedAt) return out;
  const since = new Date(clearedAt).getTime();
  for (const ev of events) {
    if (ev.kind !== 'edited' || new Date(ev.at).getTime() < since) continue;
    for (const [k, ch] of Object.entries(ev.detail.changes ?? {})) {
      out[k] = { from: k in out ? out[k].from : ch.from, to: ch.to };
    }
  }
  for (const k of Object.keys(out)) if (JSON.stringify(out[k].from) === JSON.stringify(out[k].to)) delete out[k];
  return out;
}

/** Who signed the version an edit then cleared: the last sign-off before it. */
export function clearedReviewer(events: readonly AcctEvent[], clearedAt: string | null): AcctPerson | null {
  if (!clearedAt) return null;
  const since = new Date(clearedAt).getTime();
  const last = events.filter(e => e.kind === 'reviewed' && new Date(e.at).getTime() <= since).at(-1);
  return last?.actor ?? null;
}
