import { useEffect } from 'react';
import { KIND_DEFAULT_DIRECTION } from '@recycle-erp/shared';
import { Icon } from './Icon';
import { RouteLink } from './RouteLink';
import { FIGURE_KEY, NET_KEY, Yuan, recordActionKey } from './AccountingBits';
import { useT } from '../lib/i18n';
import { fmtMoney } from '../lib/format';
import { accountingEntryPath } from '../lib/route';
import { acctPayerName, fmtBookDay, signedCny } from '../lib/accounting';
import { useAccountingTarget } from '../lib/useAccountingTarget';
import type { EntryPreset } from '../lib/accountingForm';
import '../styles/accounting.css';

// A PO's side of the managers' RMB book, inside the phone PO page's Cost
// Payment or Commission fold. Recording opens the screen's own sheet
// (`onRecord`); `version` is bumped by the screen after a save.
export function PhAccountingSection({ orderId, kind, version, onRecord }: {
  orderId: string;
  kind: 'purchase' | 'commission';
  version: number;
  onRecord: (preset: EntryPreset) => void;
}) {
  const { t, locale } = useT();
  const { ledger, reload } = useAccountingTarget({ orderId, kind });
  useEffect(() => { if (version > 0) reload(); }, [version, reload]);
  if (!ledger) return null;
  const { target } = ledger;
  return (
    <div className="acct-ph-section">
      <div className="acct-card-head">
        <div className="acct-card-title">{t('acctCardTitle')}</div>
        <button type="button" className="ph-btn acct-ph-record" onClick={() => onRecord({ kind, target })}>
          <Icon name="plus" size={12} /> {t(recordActionKey(kind, KIND_DEFAULT_DIRECTION[kind]))}
        </button>
      </div>
      {ledger.entries.length === 0 ? (
        <div className="acct-card-empty">
          {t(kind === 'purchase' ? 'acctCardEmptyPurchase' : 'acctCardEmptyCommission')}
        </div>
      ) : (
        <div className="acct-card-rows">
          {ledger.entries.map(e => (
            <RouteLink key={e.id} to={accountingEntryPath(e.id)} className="acct-card-row">
              <span className="acct-card-day">{fmtBookDay(e.occurredOn, locale)}</span>
              <span className="acct-card-what">{acctPayerName(e.manager, t)} · {t('acctMethod_' + e.method)}</span>
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
          {target.amountCny != null && <> ≈ <Yuan value={target.amountCny} locale={locale} /></>}
        </div>
      )}
    </div>
  );
}
