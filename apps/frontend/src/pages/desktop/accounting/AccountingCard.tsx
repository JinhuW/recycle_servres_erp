import { useState } from 'react';
import { KIND_DEFAULT_DIRECTION, type AccountingKind } from '@recycle-erp/shared';
import { Icon } from '../../../components/Icon';
import { RouteLink } from '../../../components/RouteLink';
import { FIGURE_KEY, NET_KEY, Yuan, recordActionKey } from '../../../components/AccountingBits';
import { useT } from '../../../lib/i18n';
import { showSuccessToast } from '../../../lib/errorToast';
import { fmtMoney } from '../../../lib/format';
import { accountingEntryPath, paymentsForOrderPath } from '../../../lib/route';
import { fmtBookDay, owedOnSale, signedCny, type AcctScope } from '../../../lib/accounting';
import { useAccountingTarget } from '../../../lib/useAccountingTarget';
import type { SavedEntry } from '../../../lib/useAccountingEntryForm';
import type { EntryPreset } from '../../../lib/accountingForm';
import { EntryDialog } from './EntryDialog';
import '../../../styles/accounting.css';

const EMPTY_KEY: Record<Exclude<AccountingKind, 'other'>, string> = {
  purchase: 'acctCardEmptyPurchase',
  commission: 'acctCardEmptyCommission',
  sale: 'acctCardEmptySale',
  after_sales: 'acctCardEmptyAs',
};

export const scopeKind = (s: AcctScope): Exclude<AccountingKind, 'other'> =>
  'orderId' in s ? s.kind : 'sellOrderId' in s ? 'sale' : 'after_sales';

// A record's side of the managers' RMB book, on the record's own page: what
// has been booked against it, what that comes to, and a Record button with
// the record already chosen. The host shows it to managers only.
export function AccountingCard({ scope, className, managerId, onRecorded }: {
  scope: AcctScope;
  className?: string;
  // Who usually holds this money — a sell order's payment receiver.
  managerId?: string | null;
  onRecorded?: (r: SavedEntry) => void;
}) {
  const { t, locale } = useT();
  const { ledger, reload } = useAccountingTarget(scope);
  const [recording, setRecording] = useState(false);
  const kind = scopeKind(scope);
  if (!ledger) return null;

  const { target } = ledger;
  // Money a CNY order still has to bring in is the obvious amount to book.
  const owed = target.currency === 'CNY' && target.amount != null && kind === 'sale'
    ? owedOnSale(target.amount, ledger.entries) : 0;
  const preset: EntryPreset = {
    kind, target, managerId: managerId ?? undefined, ...(owed > 0 ? { amount: owed } : {}),
  };
  const action = t(recordActionKey(kind, KIND_DEFAULT_DIRECTION[kind]));

  return (
    <div className={className ?? 'oe-ledger'}>
      <div className="acct-card-head">
        <div className="acct-card-title">{t('acctCardTitle')}</div>
        {target.payerBusiness && 'orderId' in scope ? (
          // The Business Account's money is Payments', not the RMB Flow's.
          <RouteLink to={paymentsForOrderPath(scope.orderId)} className="btn sm ghost">{t('payLedgerOpen')}</RouteLink>
        ) : (
          <button type="button" className="btn sm" onClick={() => setRecording(true)}>
            <Icon name="plus" size={12} /> {action}
          </button>
        )}
      </div>
      {target.payerBusiness && <div className="acct-card-empty">{t('acctPaidFromBusiness')}</div>}
      {ledger.entries.length === 0 ? (
        <div className="acct-card-empty">{t(EMPTY_KEY[kind])}</div>
      ) : (
        <div className="acct-card-rows">
          {ledger.entries.map(e => (
            <RouteLink key={e.id} to={accountingEntryPath(e.id)} className="acct-card-row">
              <span className="acct-card-day">{fmtBookDay(e.occurredOn, locale)}</span>
              <span className="acct-card-what">
                {[kind === 'sale' && e.kind !== 'sale' ? t('acctKind_' + e.kind) : null, e.manager.name, t('acctMethod_' + e.method)]
                  .filter(Boolean).join(' · ')}
              </span>
              <Yuan value={signedCny(e)} locale={locale} signed className={e.direction === 'in' ? 'acct-in' : undefined} />
            </RouteLink>
          ))}
          <div className="acct-card-net">
            <span>{t(NET_KEY[kind])}</span>
            <Yuan value={ledger.net} locale={locale} />
          </div>
        </div>
      )}
      {target.amount != null && (
        <div className="acct-card-ref">
          {t(FIGURE_KEY[kind])} {fmtMoney(target.amount, target.currency, locale)}
          {target.currency === 'USD' && target.amountCny != null && (
            <> ≈ <Yuan value={target.amountCny} locale={locale} /> · {t('acctRateNote', { rate: ledger.fx.rate.toFixed(4) })}</>
          )}
        </div>
      )}
      {recording && (
        <EntryDialog
          preset={preset}
          onClose={() => setRecording(false)}
          onSaved={r => {
            setRecording(false);
            showSuccessToast(t('acctRecordedToast', { id: r.id }));
            reload();
            onRecorded?.(r);
          }}
        />
      )}
    </div>
  );
}
