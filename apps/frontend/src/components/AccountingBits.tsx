import type { AccountingDirection, AccountingKind, AccountingTargetType } from '@recycle-erp/shared';
import { splitYuan, type AcctEntry, type AcctEvent } from '../lib/accounting';
import { afterSalesCasePath } from '../lib/route';
import { poStageName, type Translate } from '../lib/orderPresentation';
import { sellOrderStatusShort } from '../lib/lookups';

// The few pieces of the RMB book both shells draw the same way.

/** An RMB figure as the book prints it: a small ¥, the whole yuan, and the
 *  jiao/fen quieter. `signed` writes the + of money received too. */
export function Yuan({ value, locale, signed, className }: {
  value: number; locale: string; signed?: boolean; className?: string;
}) {
  const s = splitYuan(value, locale);
  const sign = signed ? (value < 0 ? '−' : '+') : s.sign;
  return (
    <span className={'acct-fig' + (className ? ' ' + className : '')}>
      {sign}<span className="acct-cur">¥</span>{s.whole}<span className="acct-fen">{s.fraction}</span>
    </span>
  );
}

/** The verb a Record button carries: what the money does for that record. */
export function recordActionKey(kind: AccountingKind, direction: AccountingDirection): string {
  if (direction === 'in') return 'acctRecordReceipt';
  return kind === 'after_sales' ? 'acctRecordRefund' : 'acctRecordPayment';
}

/** Where an entry's record lives; a PO opens on the tab the money belongs to. */
export function recordPath(e: Pick<AcctEntry, 'kind' | 'target'>): string | null {
  if (!e.target) return null;
  switch (e.target.type) {
    case 'po': return `/purchase-orders/${encodeURIComponent(e.target.id)}?tab=${e.kind === 'commission' ? 'commission' : 'payment'}`;
    case 'so': return `/sell-orders/${encodeURIComponent(e.target.id)}`;
    case 'as': return afterSalesCasePath(e.target.id);
  }
}

// The i18n key of what a record's own figure is.
export const FIGURE_KEY: Record<Exclude<AccountingKind, 'other'>, string> = {
  purchase: 'acctFigurePurchase',
  commission: 'acctFigureCommission',
  sale: 'acctFigureSale',
  after_sales: 'acctFigureAs',
};

// The i18n key of what a record's side of the book comes to.
export const NET_KEY: Record<Exclude<AccountingKind, 'other'>, string> = {
  purchase: 'acctNetPaid',
  commission: 'acctNetPaid',
  sale: 'acctNetReceived',
  after_sales: 'acctNetRefunded',
};

/** A record's stage in the words its own page uses. */
export function targetStatusLabel(type: AccountingTargetType, status: string, t: Translate): string {
  if (type === 'po') return poStageName(status, t);
  if (type === 'so') return sellOrderStatusShort(status);
  return t('asStatus_' + status.replace(/ /g, '_'));
}

const FIELD_KEY: Record<string, string> = {
  direction: 'acctFieldDirection', kind: 'acctFieldKind', amount: 'acctFieldAmount', currency: 'acctFieldCurrency',
  fxRate: 'acctFieldRate', method: 'acctFieldMethod', occurredOn: 'acctFieldDate', managerId: 'acctFieldManager',
  targetId: 'acctFieldRecord', counterparty: 'acctFieldCounterparty', reference: 'acctFieldReference', note: 'acctFieldNote',
};

/** One line of an entry's history, after the actor's name. */
export function eventLine(e: AcctEvent, t: Translate): string {
  switch (e.kind) {
    case 'created': return t('acctEvCreated');
    case 'edited': return t('acctEvEdited', {
      fields: Object.keys(e.detail.changes ?? {}).map(k => FIELD_KEY[k] ? t(FIELD_KEY[k]) : k).join(', '),
    });
    case 'voided': return t('acctEvVoided', { reason: e.detail.reason ?? '' });
    case 'restored': return t('acctEvRestored');
    case 'unlinked': return t('acctEvUnlinked', { id: e.detail.orderId ?? '' });
  }
}

