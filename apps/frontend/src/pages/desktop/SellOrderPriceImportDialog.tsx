import { useState } from 'react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { fmtMoney } from '../../lib/format';
import { handleFetchError, showErrorToast } from '../../lib/errorToast';
import { precheckPriceFile } from '../../lib/priceFilePrecheck';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { AttachmentDropzone } from '../../components/AttachmentDropzone';
import { Icon } from '../../components/Icon';
import type { PriceApplyRow } from '../../lib/priceImport';

// Vendor price round-trip inside the sell-order edit modal: download the bid
// template, vendor fills unit prices, drop the file back here. The backend
// preview endpoint matches rows by canonical part number and writes nothing —
// confirming fills the edit form's inputs, and the manager saves as usual.

type PreviewRowStatus =
  | 'matched' | 'not-in-order' | 'no-price' | 'invalid-price' | 'duplicate' | 'ambiguous';

type PreviewRow = {
  rowNumber: number;
  rawPart: string;
  canonPart: string;
  condition: string | null;
  price: number | null;
  rawPrice: string;
  status: PreviewRowStatus;
  partNumber?: string | null;
  label?: string;
  oldPrice?: number | null;
  qty?: number;
  lineCount?: number;
};

type ProductRef = { partNumber: string | null; label: string; condition: string | null };

type PreviewResponse = {
  currency: string;
  rows: PreviewRow[];
  unmatchedProducts: ProductRef[];
  manualProducts: ProductRef[];
  summary: {
    matched: number; notInOrder: number; noPrice: number;
    invalid: number; duplicate: number; ambiguous: number;
  };
};

function StepBadge({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
        border: '1.5px solid var(--accent)', color: 'var(--accent)',
        fontSize: 11, fontWeight: 700,
      }}
    >
      {n}
    </span>
  );
}

export function PriceImportSection({
  orderId, currency, locale, onApply,
}: {
  orderId: string;
  currency: string;
  locale: string;
  onApply: (rows: PriceApplyRow[]) => void;
}) {
  const { t } = useT();
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);

  const downloadTemplate = async () => {
    try {
      await api.download(`/api/sell-orders/${orderId}/price-template`, `${orderId}-price-template.xlsx`);
    } catch (e) {
      handleFetchError(e);
    }
  };

  const onFiles = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || uploading) return;
    setUploading(true);
    try {
      // Cheap local sanity check before any bytes leave the browser — catches
      // the wrong file (CSV, PDF, unrelated workbook), an empty table, or a
      // deleted key column, with a message naming exactly what's wrong.
      const check = await precheckPriceFile(file);
      if (!check.ok) {
        if (check.reason === 'columns-missing') {
          showErrorToast(
            check.missing.length === 1
              ? t(check.missing[0] === 'part' ? 'soPriceImportMissingPart' : 'soPriceImportMissingPrice')
              : t('soPriceImportColumnsNotFound'),
          );
        } else {
          showErrorToast(t(
            check.reason === 'too-large' ? 'soPriceImportTooLarge'
              : check.reason === 'no-rows' ? 'soPriceImportNoRows'
                : 'soPriceImportNotXlsx',
          ));
        }
        return;
      }
      const form = new FormData();
      form.append('file', file);
      const res = await api.upload<PreviewResponse>(
        `/api/sell-orders/${orderId}/price-import/preview`, form,
      );
      setPreview(res);
    } catch (e) {
      if (e instanceof Error && /column/i.test(e.message)) {
        showErrorToast(t('soPriceImportColumnsNotFound'));
      } else {
        handleFetchError(e);
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="so-section" style={{ marginTop: 18 }}>
      <div className="so-section-head">
        <Icon name="upload" size={14} /> {t('soPriceImportTitle')}
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, justifyContent: 'center', minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StepBadge n={1} />
            <button className="btn sm" onClick={downloadTemplate}>
              <Icon name="download" size={13} /> {t('soDownloadPriceTemplate')}
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--fg-subtle)' }}>
            <StepBadge n={2} />
            {t('soPriceImportStep2')}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--fg-subtle)' }}>
            <StepBadge n={3} />
            {t('soPriceImportStep3')}
          </div>
        </div>
        <div style={{ flex: '1 1 260px' }}>
          <AttachmentDropzone
            onFiles={onFiles}
            uploading={uploading}
            multiple={false}
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            boxHint={t('soPriceImportDropHint')}
          />
        </div>
      </div>
      {preview && (
        <PriceImportPreviewDialog
          preview={preview}
          currency={currency}
          locale={locale}
          onCancel={() => setPreview(null)}
          onConfirm={rows => {
            setPreview(null);
            onApply(rows);
            window.__showToast?.(t('soPriceImportApplied', { n: String(rows.length) }), 'success');
          }}
        />
      )}
    </div>
  );
}

const WARNING_LABEL_KEY: Record<Exclude<PreviewRowStatus, 'matched'>, string> = {
  'not-in-order': 'soPriceImportNotInOrder',
  'no-price': 'soPriceImportNoPrice',
  'invalid-price': 'soPriceImportInvalid',
  duplicate: 'soPriceImportDuplicate',
  ambiguous: 'soPriceImportAmbiguous',
};

function PriceImportPreviewDialog({
  preview, currency, locale, onCancel, onConfirm,
}: {
  preview: PreviewResponse;
  currency: string;
  locale: string;
  onCancel: () => void;
  onConfirm: (rows: PriceApplyRow[]) => void;
}) {
  const { t } = useT();
  useEscapeKey(onCancel);

  const matched = preview.rows.filter(r => r.status === 'matched');
  const warnings = preview.rows.filter(r => r.status !== 'matched');
  const [excluded, setExcluded] = useState<Set<number>>(new Set());

  const toggle = (rowNumber: number) =>
    setExcluded(prev => {
      const next = new Set(prev);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });

  const included = matched.filter(r => !excluded.has(r.rowNumber));
  const confirm = () =>
    onConfirm(included.map(r => ({
      canonPart: r.canonPart,
      condition: r.condition ?? null,
      price: r.price ?? 0,
    })));

  const money = (n: number | null | undefined) =>
    n == null ? '—' : fmtMoney(n, currency, locale);

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-shell" style={{ maxWidth: 680, width: 'calc(100vw - 80px)' }}>
        <div className="modal-head">
          <div className="modal-title">{t('soPriceImportPreviewTitle')}</div>
        </div>
        <div className="modal-body" style={{ padding: 20, maxHeight: '60vh', overflowY: 'auto' }}>
          {matched.length === 0 && (
            <div style={{ fontSize: 13.5, color: 'var(--fg-subtle)' }}>
              {t('soPriceImportEmpty')}
            </div>
          )}
          {matched.length > 0 && (
            <table className="so-line-table">
              <thead>
                <tr>
                  <th style={{ width: 30 }}></th>
                  <th>{t('item')}</th>
                  <th className="num" style={{ width: 60 }}>{t('qty')}</th>
                  <th className="num" style={{ width: 110 }}>{t('soPriceImportOldPrice')}</th>
                  <th className="num" style={{ width: 110 }}>{t('soPriceImportNewPrice')}</th>
                </tr>
              </thead>
              <tbody>
                {matched.map(r => (
                  <tr key={r.rowNumber} style={{ opacity: excluded.has(r.rowNumber) ? 0.45 : 1 }}>
                    <td>
                      <input
                        type="checkbox"
                        checked={!excluded.has(r.rowNumber)}
                        onChange={() => toggle(r.rowNumber)}
                      />
                    </td>
                    <td>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>{r.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--fg-subtle)', display: 'flex', gap: 8, marginTop: 2 }}>
                        <span className="mono">{r.partNumber ?? '—'}</span>
                        {r.condition && <span>{r.condition}</span>}
                        {(r.lineCount ?? 1) > 1 && (
                          <span>{t('soPriceImportAppliesTo', { n: String(r.lineCount) })}</span>
                        )}
                      </div>
                    </td>
                    <td className="num mono">{r.qty}</td>
                    <td className="num mono" style={{ color: 'var(--fg-subtle)' }}>{money(r.oldPrice)}</td>
                    <td className="num mono" style={{ fontWeight: 600 }}>{money(r.price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {(warnings.length > 0 || preview.unmatchedProducts.length > 0 || preview.manualProducts.length > 0) && (
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {warnings.map(r => (
                <div key={`w${r.rowNumber}`} style={{ fontSize: 12.5, color: 'var(--fg-subtle)', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <Icon name="alert" size={12} style={{ flexShrink: 0, transform: 'translateY(1px)' }} />
                  <span>
                    <span className="mono">{r.rawPart}</span>
                    {' — '}{t(WARNING_LABEL_KEY[r.status as Exclude<PreviewRowStatus, 'matched'>])}
                  </span>
                </div>
              ))}
              {preview.unmatchedProducts.map((p, i) => (
                <div key={`u${i}`} style={{ fontSize: 12.5, color: 'var(--fg-subtle)', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <Icon name="alert" size={12} style={{ flexShrink: 0, transform: 'translateY(1px)' }} />
                  <span>
                    <span className="mono">{p.partNumber ?? p.label}</span>
                    {' — '}{t('soPriceImportUnpriced')}
                  </span>
                </div>
              ))}
              {preview.manualProducts.map((p, i) => (
                <div key={`m${i}`} style={{ fontSize: 12.5, color: 'var(--fg-subtle)', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <Icon name="alert" size={12} style={{ flexShrink: 0, transform: 'translateY(1px)' }} />
                  <span>{p.label}{' — '}{t('soPriceImportManual')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>{t('cancel')}</button>
          <button className="btn accent" onClick={confirm} disabled={included.length === 0}>
            {t('soPriceImportConfirm', { n: String(included.length) })}
          </button>
        </div>
      </div>
    </div>
  );
}
