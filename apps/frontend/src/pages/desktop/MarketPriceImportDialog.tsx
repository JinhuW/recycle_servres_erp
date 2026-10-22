import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { fmtMoney, fmtUSD } from '../../lib/format';
import { handleFetchError, showErrorDialog, showSuccessToast } from '../../lib/errorToast';
import { precheckMessageKey, precheckPriceFile } from '../../lib/priceFilePrecheck';
import { AttachmentDropzone } from '../../components/AttachmentDropzone';
import { CurrencyPicker, type Currency } from '../../components/CurrencyPicker';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';

// A price list dropped on the Market page. Only its Part Number and Unit Price
// columns are read, in dollars or yuan; the server converts yuan at the FX
// ledger's rate. The preview writes nothing; Apply records every matched price
// as a market data point, and a part's max buy follows its price.

type RowStatus =
  | 'matched' | 'not-on-market' | 'no-price' | 'invalid-price' | 'other-currency' | 'duplicate';

type PreviewRow = {
  sheet: string;
  rowNumber: number;
  rawPart: string;
  rawPrice: string;
  price: number | null;
  currency: string;
  listedPrice?: number;
  status: RowStatus;
  refPriceId?: string;
  partNumber?: string | null;
  label?: string;
  oldPrice?: number | null;
  oldMaxBuy?: number | null;
  newMaxBuy?: number | null;
};

type Preview = {
  targetMargin: number;
  fx: { oneUsdInQuote: number; source: string } | null;
  rows: PreviewRow[];
};

const SKIP_LABEL_KEY: Record<Exclude<RowStatus, 'matched'>, string> = {
  'not-on-market': 'mktImportNotOnMarket',
  'no-price': 'mktImportNoPrice',
  'invalid-price': 'mktImportInvalid',
  'other-currency': 'mktImportOtherCurrency',
  duplicate: 'mktImportDuplicate',
};

const rowKey = (r: PreviewRow) => `${r.sheet}:${r.rowNumber}`;

export function MarketPriceImportDialog({
  onClose, onApplied,
}: {
  onClose: () => void;
  onApplied: () => void;
}) {
  const { t, locale } = useT();
  const [busy, setBusy] = useState(false);
  const [currency, setCurrency] = useState<Currency>('USD');
  const [preview, setPreview] = useState<{ file: File; data: Preview } | null>(null);

  const close = () => {
    if (!busy) onClose();
  };

  // A switch on the preview sends the same file again: which rows convert
  // turns on each row's own currency mark, and only the server reads those.
  // The switch moves only once its preview lands, so it never shows a
  // currency the table wasn't read in.
  const read = async (file: File, cur: Currency, fresh: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const check = fresh ? await precheckPriceFile(file) : null;
      if (check && !check.ok) {
        showErrorDialog(t(precheckMessageKey(check)));
        return;
      }
      const form = new FormData();
      form.append('file', file);
      form.append('currency', cur);
      const data = await api.upload<Preview>('/api/market/price-import/preview', form);
      setCurrency(cur);
      setPreview({ file, data });
    } catch (e) {
      const body = e instanceof ApiError ? e.body as { code?: string; max?: number } | undefined : undefined;
      if (body?.code === 'too-many-prices') {
        showErrorDialog(t('mktImportTooMany', { n: body.max ?? '' }));
      } else if (e instanceof Error && /column/i.test(e.message)) {
        showErrorDialog(t('soPriceImportColumnsNotFound'));
      } else {
        handleFetchError(e);
      }
    } finally {
      setBusy(false);
    }
  };

  const onFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) void read(file, currency, true);
  };

  const onCurrency = (next: Currency) => {
    if (next === currency) return;
    if (preview) void read(preview.file, next, false);
    else setCurrency(next);
  };

  const matched = preview?.data.rows.filter(r => r.status === 'matched') ?? [];
  const skipped = preview?.data.rows.filter(r => r.status !== 'matched') ?? [];
  const fx = matched.some(r => r.listedPrice != null) ? preview?.data.fx : null;
  const currencySwitch = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{t('mktImportCurrency')}</span>
      <CurrencyPicker value={currency} onChange={onCurrency} t={t} disabled={busy} />
    </div>
  );

  const apply = async () => {
    if (!preview || busy || matched.length === 0) return;
    setBusy(true);
    try {
      const r = await api.post<{ updated: number; notFound: number }>('/api/market/price-import/apply', {
        fileName: preview.file.name,
        prices: matched.map(m => ({ id: m.refPriceId, price: m.price })),
      });
      showSuccessToast(r.notFound > 0
        ? t('mktImportAppliedSome', { n: r.updated, m: r.notFound })
        : t('mktImportApplied', { n: r.updated }));
      onApplied();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={close} shellStyle={{ maxWidth: 760, width: 'calc(100vw - 80px)' }}>
      <div className="modal-head">
        <div className="modal-title">{t('mktImportTitle')}</div>
      </div>
      <div className="modal-body" style={{ padding: 20, maxHeight: '60vh', overflowY: 'auto' }}>
        {!preview ? (
          <>
            <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55, marginBottom: 14 }}>
              {t('mktImportIntro')}
            </div>
            <div style={{ marginBottom: 14 }}>{currencySwitch}</div>
            <AttachmentDropzone
              onFiles={onFiles}
              uploading={busy}
              multiple={false}
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              boxHint={t('mktImportDropHint')}
            />
          </>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--fg-subtle)', minWidth: 0 }}>
                <Icon name="file" size={13} />
                <span className="mono">{preview.file.name}</span>
              </div>
              {currencySwitch}
            </div>
            {matched.length === 0 ? (
              <div style={{ fontSize: 13.5, color: 'var(--fg-subtle)' }}>{t('mktImportEmpty')}</div>
            ) : (
              <table className="so-line-table">
                <thead>
                  <tr>
                    <th>{t('item')}</th>
                    <th className="num" style={{ width: 100 }}>{t('mktImportCurrent')}</th>
                    <th className="num" style={{ width: 100 }}>{t('mktImportNew')}</th>
                    <th className="num" style={{ width: 170 }}>{t('mktColMaxBuy')}</th>
                  </tr>
                </thead>
                <tbody>
                  {matched.map(r => (
                    <tr key={rowKey(r)}>
                      <td>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>{r.label}</div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                          {r.partNumber ?? r.rawPart}
                        </div>
                      </td>
                      <td className="num mono" style={{ color: 'var(--fg-subtle)' }}>{fmtUSD(r.oldPrice, locale)}</td>
                      <td className="num mono" style={{ fontWeight: 600 }}>
                        {fmtUSD(r.price, locale)}
                        {r.listedPrice != null && (
                          <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--fg-subtle)', marginTop: 2 }}>
                            {fmtMoney(r.listedPrice, 'CNY', locale)}
                          </div>
                        )}
                      </td>
                      <td className="num mono">
                        <span style={{ color: 'var(--fg-subtle)' }}>{fmtUSD(r.oldMaxBuy, locale)}</span>
                        {' → '}
                        <span style={{ fontWeight: 600, color: 'var(--accent-strong)' }}>{fmtUSD(r.newMaxBuy, locale)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {fx && (
              <div className="mono" style={{ marginTop: 8, fontSize: 11.5, color: 'var(--fg-subtle)', textAlign: 'right' }}>
                {t('soFxRateNote', { rate: fx.oneUsdInQuote.toFixed(4), currency: 'CNY', source: fx.source })}
              </div>
            )}
            {skipped.length > 0 && (
              <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg-muted)' }}>
                  {t('mktImportSkipped', { n: skipped.length })}
                </div>
                {skipped.map(r => (
                  <div key={rowKey(r)} style={{ fontSize: 12.5, color: 'var(--fg-subtle)', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <Icon name="alert" size={12} style={{ flexShrink: 0, transform: 'translateY(1px)' }} />
                    <span>
                      <span className="mono">{r.rawPart}</span>
                      {(r.status === 'invalid-price' || r.status === 'other-currency') && r.rawPrice && (
                        <span className="mono"> · {r.rawPrice}</span>
                      )}
                      {' — '}{t(SKIP_LABEL_KEY[r.status as Exclude<RowStatus, 'matched'>], { currency: r.currency })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={close} disabled={busy}>{t('cancel')}</button>
        {preview && (
          <button className="btn accent" onClick={apply} disabled={busy || matched.length === 0}>
            {busy ? '…' : t('mktImportConfirm', { n: matched.length })}
          </button>
        )}
      </div>
    </Modal>
  );
}
