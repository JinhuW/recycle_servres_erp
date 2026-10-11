import { useState } from 'react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { fmtUSD } from '../../lib/format';
import { handleFetchError, showErrorDialog, showSuccessToast } from '../../lib/errorToast';
import { precheckPriceFile } from '../../lib/priceFilePrecheck';
import { AttachmentDropzone } from '../../components/AttachmentDropzone';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';

// A price list dropped on the Market page. Only its Part Number and Unit Price
// columns are read. The preview writes nothing; Apply records every matched
// price as a market data point, and a part's max buy follows its price.

type RowStatus =
  | 'matched' | 'not-on-market' | 'no-price' | 'invalid-price' | 'not-usd' | 'duplicate';

type PreviewRow = {
  sheet: string;
  rowNumber: number;
  rawPart: string;
  rawPrice: string;
  price: number | null;
  status: RowStatus;
  refPriceId?: string;
  partNumber?: string | null;
  label?: string;
  oldPrice?: number | null;
  oldMaxBuy?: number | null;
  newMaxBuy?: number | null;
};

type Preview = { targetMargin: number; rows: PreviewRow[] };

const SKIP_LABEL_KEY: Record<Exclude<RowStatus, 'matched'>, string> = {
  'not-on-market': 'mktImportNotOnMarket',
  'no-price': 'mktImportNoPrice',
  'invalid-price': 'mktImportInvalid',
  'not-usd': 'mktImportNotUsd',
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
  const [preview, setPreview] = useState<{ fileName: string; data: Preview } | null>(null);

  const close = () => {
    if (!busy) onClose();
  };

  const onFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || busy) return;
    setBusy(true);
    try {
      const check = await precheckPriceFile(file);
      if (!check.ok) {
        showErrorDialog(t(
          check.reason === 'columns-missing'
            ? check.missing.length === 1
              ? check.missing[0] === 'part' ? 'mktImportMissingPart' : 'mktImportMissingPrice'
              : 'soPriceImportColumnsNotFound'
            : check.reason === 'too-large' ? 'soPriceImportTooLarge'
              : check.reason === 'no-rows' ? 'soPriceImportNoRows'
                : 'soPriceImportNotXlsx',
        ));
        return;
      }
      const form = new FormData();
      form.append('file', file);
      const data = await api.upload<Preview>('/api/market/price-import/preview', form);
      setPreview({ fileName: file.name, data });
    } catch (e) {
      if (e instanceof Error && /column/i.test(e.message)) {
        showErrorDialog(t('soPriceImportColumnsNotFound'));
      } else {
        handleFetchError(e);
      }
    } finally {
      setBusy(false);
    }
  };

  const matched = preview?.data.rows.filter(r => r.status === 'matched') ?? [];
  const skipped = preview?.data.rows.filter(r => r.status !== 'matched') ?? [];

  const apply = async () => {
    if (!preview || busy || matched.length === 0) return;
    setBusy(true);
    try {
      const r = await api.post<{ updated: number; notFound: number }>('/api/market/price-import/apply', {
        fileName: preview.fileName,
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--fg-subtle)', marginBottom: 12 }}>
              <Icon name="file" size={13} />
              <span className="mono">{preview.fileName}</span>
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
                      <td className="num mono" style={{ fontWeight: 600 }}>{fmtUSD(r.price, locale)}</td>
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
                      {(r.status === 'invalid-price' || r.status === 'not-usd') && r.rawPrice && (
                        <span className="mono"> · {r.rawPrice}</span>
                      )}
                      {' — '}{t(SKIP_LABEL_KEY[r.status as Exclude<RowStatus, 'matched'>])}
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
