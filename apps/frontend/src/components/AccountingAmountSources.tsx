import type { AccountingEntryForm } from '../lib/useAccountingEntryForm';
import { useT } from '../lib/i18n';
import { fmtMoney } from '../lib/format';

export function AccountingAmountSources({ f }: { f: AccountingEntryForm }) {
  const { t, locale } = useT();
  if (f.editing) return null;
  return (
    <div className="acct-amount-sources" aria-label={t('acctAmountSources')}>
      {f.suggested != null && f.suggested > 0 && (
        <button type="button" className="btn sm" onClick={f.useOrderAmount} disabled={f.busy}
                aria-pressed={f.form.amountSource === 'order'}>
          {t('acctUseOrderAmount', { amount: fmtMoney(f.suggested, f.form.currency, locale) })}
        </button>
      )}
      {f.readings.map(({ file, receipt }, i) => receipt.currency && (
        <button key={i} type="button" className="btn sm" title={file.name} disabled={f.busy}
                aria-pressed={f.selectedReceiptFile === file}
                onClick={() => f.useReceipt(file, receipt)}>
          {t('acctUseReceiptAmount', { amount: fmtMoney(Number(receipt.amount), receipt.currency, locale) })}
        </button>
      ))}
      {f.reading && <div className="acct-hint" role="status">{t('acctReceiptReading')}</div>}
      {f.scanNotice && <div className="acct-hint" role="status">{f.scanNotice}</div>}
    </div>
  );
}
