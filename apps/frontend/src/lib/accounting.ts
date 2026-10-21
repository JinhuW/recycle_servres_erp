import { api } from './api';
import type { PaidBy } from './useCommissionPaidBy';
import {
  addDays, addMonths, startOfMonth, startOfYear, todayIn,
  type AccountingCurrency, type AccountingDirection, type AccountingKind, type AccountingMethod,
  type AccountingTargetType, type IsoDate,
} from '@recycle-erp/shared';

// The managers' RMB book: the API client both shells use, and the small
// pure helpers its pages share.

export type AcctEntry = {
  id: string; direction: AccountingDirection; kind: AccountingKind;
  amount: number; currency: AccountingCurrency; fxRate: number | null; amountCny: number;
  method: AccountingMethod; occurredOn: IsoDate;
  manager: { id: string; name: string };
  target: { type: AccountingTargetType; id: string } | null;
  counterparty: string | null; reference: string | null; note: string | null;
  createdAt: string; updatedAt: string;
  createdBy: { id: string; name: string } | null;
  voided: { at: string; by: string | null; reason: string } | null;
};

export type AcctRow = AcctEntry & { balance: number | null };

// A record an entry can be for, as the picker and the cards show it: its own
// figure in its own currency, and what the book already has against it.
export type AcctTarget = {
  id: string; status: string; party: string | null;
  amount: number | null; currency: AccountingCurrency; recordedCny: number;
};

export type AcctEvent = {
  id: string; kind: 'created' | 'edited' | 'voided' | 'restored' | 'unlinked';
  detail: { changes?: Record<string, { from: unknown; to: unknown }>; reason?: string; orderId?: string };
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
  api.post<{ id: string; commissionPaidBy?: PaidBy }>('/api/accounting/entries', body);
export const acctPatch = (id: string, body: Partial<AcctEntryBody>) =>
  api.patch<{ ok: true; commissionPaidBy?: PaidBy }>(`/api/accounting/entries/${enc(id)}`, body);
export const acctVoid = (id: string, reason: string) =>
  api.post<{ ok: true }>(`/api/accounting/entries/${enc(id)}/void`, { reason });
export const acctRestore = (id: string) =>
  api.post<{ ok: true }>(`/api/accounting/entries/${enc(id)}/restore`, {});
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
