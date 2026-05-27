import { useState } from 'react';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { PhCategoryFields } from '../components/PhCategoryFields';
import { useT } from '../lib/i18n';
import { AI_CONFIDENCE_FLOOR, AI_UNREADABLE_FLOOR } from '../lib/status';
import { validateScan, stripUnmatched } from '../lib/scanValidation';
import { CONDITIONS } from '../lib/catalog';
import { fmtUSD } from '../lib/format';
import type { Category, DraftLine, ScanResponse } from '../lib/types';
import { ImageLightbox } from '../components/ImageLightbox';

type Props = {
  category: Category;
  detected: ScanResponse | null;
  lineCount: number;
  editingLineIdx?: number | null;
  existingLine?: DraftLine;
  onSaveLine: (line: DraftLine) => void;
  onCancel: () => void;
  onBack?: () => void;
  // Re-open the Camera page (take or upload a label photo). The current draft
  // is handed back so the new scan merges into it instead of rebuilding it.
  onRescan: (draft: DraftLine) => void;
  // In-progress draft carried across a rescan trip through the Camera page.
  rescanDraft?: DraftLine | null;
};

const blankDefaults = (category: Category): DraftLine => ({
  _cid: crypto.randomUUID(),
  category,
  brand: null,
  capacity: null,
  type: null,
  generation: null,
  classification: null,
  rank: null,
  speed: null,
  interface: null,
  formFactor: null,
  description: null,
  partNumber: '',
  qty: 0,
  unitCost: 0,
  sellPrice: null,
  condition: undefined,
  scanImageId: null,
  scanConfidence: null,
});

const aiPatch = (scan: ScanResponse): Partial<DraftLine> => {
  const f = scan.extracted ?? {};
  const out: Partial<DraftLine> = {};
  if (f.brand)          out.brand          = f.brand as string;
  if (f.capacity)       out.capacity       = f.capacity as string;
  if (f.type)           out.type           = f.type as string;
  if (f.generation)     out.generation     = f.generation as string;
  if (f.classification) out.classification = f.classification as string;
  if (f.rank)           out.rank           = f.rank as string;
  if (f.speed)          out.speed          = f.speed as string;
  if (f.interface)      out.interface      = f.interface as string;
  if (f.formFactor)     out.formFactor     = f.formFactor as string;
  if (f.description)    out.description    = f.description as string;
  if (f.partNumber)     out.partNumber     = f.partNumber as string;
  out.scanImageId = scan.imageId ?? null;
  out.scanConfidence = scan.confidence ?? null;
  return out;
};

const aiDefaults = (category: Category, scan: ScanResponse): DraftLine => {
  const f = scan.extracted ?? {};
  return {
    _cid: crypto.randomUUID(),
    category,
    brand:          (f.brand as string)          ?? null,
    capacity:       (f.capacity as string)       ?? null,
    type:           (f.type as string)           ?? null,
    generation:     (f.generation as string)     ?? null,
    classification: (f.classification as string) ?? null,
    rank:           (f.rank as string)           ?? null,
    speed:          (f.speed as string)          ?? null,
    interface:      (f.interface as string)      ?? null,
    formFactor:     (f.formFactor as string)     ?? null,
    description:    (f.description as string)    ?? null,
    partNumber:     (f.partNumber as string)     ?? '',
    qty: 0,
    unitCost: 0,
    sellPrice: null,
    condition: undefined,
    scanImageId: scan.imageId ?? null,
    scanConfidence: scan.confidence ?? null,
  };
};

export function SubmitForm({ category, detected, lineCount, editingLineIdx, existingLine, onSaveLine, onCancel, onBack, onRescan, rescanDraft }: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const isEditing = editingLineIdx != null;
  const aiFilled = !!detected;
  const isFirst = lineCount === 0 && !isEditing;

  // Initial form values:
  //   - Editing an existing line → start from that line's values, optionally
  //     patched by AI-extracted fields (when re-scanning). The patch only
  //     includes keys the scan actually returned, so user-entered data
  //     (qty/cost/sell/condition and any field the scan missed) is preserved.
  //   - New line + AI scan → fields from the scan, scalars left at sensible
  //     blanks.
  //   - New line, manual → all blank.
  // When returning from a rescan, merge the new scan into the draft the user
  // was editing (rescanDraft) — even for a brand-new, unsaved line — so typed
  // values survive the trip through the Camera page.
  // Filter out AI extractions whose values aren't in the catalog before they
  // hit the form. A <select> whose value isn't an <option> renders empty, so
  // unrecognized values would silently disappear; the warning banner below
  // surfaces them instead so the user can verify or pick from the dropdown.
  const validation = validateScan(category, detected?.extracted);
  const cleanDetected: ScanResponse | null = detected
    ? { ...detected, extracted: stripUnmatched(detected.extracted ?? {}, validation.unmatched) }
    : null;
  const mergeBase = rescanDraft ?? (isEditing ? existingLine : undefined);
  const initial: DraftLine = mergeBase
    ? (cleanDetected ? { ...mergeBase, ...aiPatch(cleanDetected) } : mergeBase)
    : (cleanDetected ? aiDefaults(category, cleanDetected) : blankDefaults(category));

  const [line, setLine] = useState<DraftLine>(initial);
  const [lightbox, setLightbox] = useState(false);
  const [thumbBroken, setThumbBroken] = useState(false);
  // Tracks which fields the user has touched since the AI populated them.
  // An AI-filled field stays red-bordered (low-confidence cue) until the user
  // edits it, at which point the red clears — "you've verified this one".
  const [edited, setEdited] = useState<ReadonlySet<keyof DraftLine>>(() => new Set());
  // Cleared by tapping "Enter manually" in the unreadable banner so the user
  // can type values without the warning hovering over them.
  const [unreadableDismissed, setUnreadableDismissed] = useState(false);

  // Prefer the freshest scan (a new/re-scan's delivery URL) over the existing
  // line's stored image. Stub/dev placeholders are not real images.
  const scanUrl = detected?.deliveryUrl ?? existingLine?.scanImageUrl ?? null;
  const showThumb =
    !!scanUrl &&
    !scanUrl.startsWith('data:image/placeholder') &&
    !thumbBroken;

  const set = <K extends keyof DraftLine>(k: K, v: DraftLine[K]) => {
    setLine(prev => ({ ...prev, [k]: v }));
    setEdited(prev => {
      if (prev.has(k)) return prev;
      const next = new Set(prev);
      next.add(k);
      return next;
    });
  };

  // Per-field red-border set for "AI low confidence — please verify".
  // Active when overall confidence falls below the verify threshold (covers
  // both the amber 0.3–0.6 band and the red <0.3 unreadable band). Only fields
  // the AI actually populated get red; user-edited fields are cleared.
  const detectedConf = detected?.confidence ?? 1;
  const detectedIsStub = detected?.provider === 'stub';
  const showLowConfBorders = !!detected && !detectedIsStub && detectedConf < AI_CONFIDENCE_FLOOR;
  const aiPopulatedKeys: (keyof DraftLine)[] = Object.entries(cleanDetected?.extracted ?? {})
    .filter(([, v]) => v != null && v !== '')
    .map(([k]) => k as keyof DraftLine);
  const aiLowConfFields: ReadonlySet<keyof DraftLine> | undefined = showLowConfBorders
    ? new Set(aiPopulatedKeys.filter(k => !edited.has(k)))
    : undefined;

  const buildLabel = (): string => {
    if (line.category === 'RAM') return [line.brand, line.capacity, line.generation].filter(Boolean).join(' ');
    if (line.category === 'SSD') return [line.brand, line.capacity, line.interface].filter(Boolean).join(' ');
    if (line.category === 'HDD') return [line.brand, line.capacity, line.rpm ? line.rpm + 'rpm' : null].filter(Boolean).join(' ');
    return line.description ?? 'Item';
  };

  const save = () => onSaveLine({ ...line, label: buildLabel(), partNumber: line.partNumber || '—' });

  // Header text:
  //   - Edit mode:  "Edit RAM item" / sub = existing label
  //   - First-item new order: "New RAM order" / sub = AI-review or fill-in
  //   - Nth-item new order:  "Add RAM item" / sub = "Item N · adding..."
  const title = isEditing
    ? (category === 'RAM' ? t('editRamItem') : category === 'SSD' ? t('editSsdItem') : category === 'HDD' ? t('editHddItem') : t('editOtherItem'))
    : isFirst
      ? (category === 'RAM' ? t('newRamOrder') : category === 'SSD' ? t('newSsdOrder') : category === 'HDD' ? t('newHddOrder') : t('newOtherOrder'))
      : (category === 'RAM' ? t('addRamItem')  : category === 'SSD' ? t('addSsdItem')  : category === 'HDD' ? t('addHddItem')  : t('addOtherItem'));

  const sub = isEditing
    ? buildLabel()
    : isFirst
      ? (aiFilled ? t('aiReview') : t('fillIn'))
      : t('addingItem', { n: lineCount + 1 });

  return (
    <div className="phone-app">
      <PhHeader
        title={title}
        sub={sub}
        leading={
          <button className="ph-icon-btn" onClick={onBack ?? onCancel}>
            <Icon name="chevronLeft" size={16} />
          </button>
        }
      />
      <div className="ph-scroll" style={{ paddingBottom: 110 }}>
        {category === 'RAM' && (
          <button
            type="button"
            className="ph-ai-capture"
            onClick={() => onRescan(line)}
            aria-label={t('aiLabelCapture')}
          >
            <span className="ph-ai-capture-badge">
              <Icon name="camera" size={20} />
            </span>
            <span className="ph-ai-capture-body">
              <span className="ph-ai-capture-title-row">
                <span className="ph-ai-capture-title">{t('aiLabelCapture')}</span>
                <span className="ph-ai-capture-tag">{t('aiDropzoneTag')}</span>
              </span>
              <span className="ph-ai-capture-sub">
                {aiFilled ? t('aiCaptureRetake') : t('aiCaptureTapToScan')}
              </span>
            </span>
            <span className="ph-ai-capture-arrow">
              <Icon name="chevronRight" size={14} />
            </span>
          </button>
        )}
        {aiFilled && (() => {
          // Banner has four severities, escalating:
          //   stub      → demo data, not a real reading        (amber)
          //   unreadable → conf < 0.3 or no fields returned    (red, alert role) + Retake/Manual CTAs
          //   lowConf    → 0.3 ≤ conf < 0.6                    (amber, alert role)
          //   ok         → conf ≥ 0.6                          (neutral)
          const conf = detected!.confidence;
          const pct = Math.round(conf * 100);
          const isStub = detected!.provider === 'stub';
          const noFields = Object.keys(detected!.extracted ?? {}).length === 0;
          const unreadable = !isStub && (conf < AI_UNREADABLE_FLOOR || noFields);
          const lowConf = !isStub && !unreadable && conf < AI_CONFIDENCE_FLOOR;
          if (unreadable && unreadableDismissed) return null;
          const severe = unreadable;
          const warn = isStub || lowConf;
          return (
            <div
              className="ph-ai-banner"
              role={severe || warn ? 'alert' : undefined}
              style={{
                borderRadius: 12, marginTop: 6,
                ...(severe
                  ? {
                      background: 'var(--neg-soft, #fee2e2)',
                      color: 'var(--neg-strong, #991b1b)',
                      border: '1px solid var(--neg, #dc2626)',
                      display: 'block', padding: '10px 12px',
                    }
                  : warn
                    ? {
                        background: 'var(--warn-soft, #fef3c7)',
                        color: 'var(--warn-strong, #92400e)',
                        border: '1px solid var(--warn, #f59e0b)',
                      }
                    : {}),
              }}
            >
              {severe ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="pill-ai">AI</span>
                    <span style={{ flex: 1 }}>{t('unreadableLabel')}</span>
                    <Icon name="alert" size={13} />
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button
                      type="button"
                      className="ph-btn dark"
                      style={{ flex: 1, padding: '10px 12px', fontSize: 13 }}
                      onClick={() => onRescan(line)}
                    >
                      <Icon name="camera" size={14} /> {t('retakePhoto')}
                    </button>
                    <button
                      type="button"
                      className="ph-btn ghost"
                      style={{ flex: 1, padding: '10px 12px', fontSize: 13 }}
                      onClick={() => setUnreadableDismissed(true)}
                    >
                      {t('enterManually')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <span className="pill-ai">AI</span>
                  <span>
                    {isStub
                      ? t('stubScanWarn')
                      : lowConf
                        ? t('lowConfVerify', { pct })
                        : t('extractedConf', { pct })}
                  </span>
                  <Icon name={warn ? 'alert' : 'sparkles'} size={13} style={{ marginLeft: 'auto' }} />
                </>
              )}
            </div>
          );
        })()}
        {aiFilled && validation.unmatched.length > 0 && (
          <div
            role="alert"
            className="ph-ai-banner"
            style={{
              borderRadius: 12, marginTop: 6,
              display: 'block', padding: '10px 12px',
              background: 'var(--warn-soft, #fef3c7)',
              color: 'var(--warn-strong, #92400e)',
              border: '1px solid var(--warn, #f59e0b)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, fontSize: 12.5 }}>
              <Icon name="alert" size={13} />
              <span>{t('scanUnmatchedTitle', { n: validation.unmatched.length })}</span>
            </div>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
              {validation.unmatched.map(u => (
                <li key={u.field}>
                  <span style={{ fontWeight: 600 }}>{u.field}</span>: “{u.value}”
                </li>
              ))}
            </ul>
            <div style={{ fontSize: 11.5, marginTop: 6, opacity: 0.8 }}>
              {t('scanUnmatchedHint')}
            </div>
          </div>
        )}
        {showThumb && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginTop: 8,
            }}
          >
            <button
              type="button"
              onClick={() => setLightbox(true)}
              style={{
                width: 72,
                height: 72,
                borderRadius: 12,
                border: '1px solid var(--border)',
                overflow: 'hidden',
                padding: 0,
                background: 'var(--bg-soft)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <img
                src={scanUrl!}
                alt={t('aiPhotoLabel')}
                onError={() => setThumbBroken(true)}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              />
            </button>
            <span style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>{t('aiPhotoLabel')}</span>
          </div>
        )}

        <PhCategoryFields category={category} value={line} onChange={set} aiFilled={aiFilled} aiLowConfFields={aiLowConfFields} />

        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('quantity')}<span style={{ color: 'var(--neg)', marginLeft: 2 }}>*</span></label>
            <input className="input" type="number" min={1} value={line.qty} onChange={e => set('qty', parseInt(e.target.value, 10) || 0)} />
          </div>
          <div className="ph-field">
            <label>{t('condition')}<span style={{ color: 'var(--neg)', marginLeft: 2 }}>*</span></label>
            <select className="select" value={line.condition ?? 'Pulled — Tested'} onChange={e => set('condition', e.target.value)}>
              {/* Orphan-safe: if the stored value isn't in the live catalog
                  (renamed or removed), render it as a one-off option so the
                  user still sees what was saved instead of an empty select. */}
              {line.condition && !CONDITIONS.includes(line.condition) && (
                <option value={line.condition}>{line.condition}</option>
              )}
              {CONDITIONS.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {/* Pricing row mirrors desktop LineDrawer: qty → unit → total
            (always shown so a purchaser can enter the negotiated bulk total
            instead of computing per-unit). Sell price only appears in edit
            mode, matching the desktop drawer. */}
        <div className="ph-field-row" style={{ gridTemplateColumns: isEditing ? '1fr 1fr 1fr' : '1fr 1fr' }}>
          <div className="ph-field">
            <label>{t('unitCost')}<span style={{ color: 'var(--neg)', marginLeft: 2 }}>*</span></label>
            <input className="input mono" type="number" step="0.01" min={0} value={line.unitCost} onChange={e => set('unitCost', parseFloat(e.target.value) || 0)} />
          </div>
          <div className="ph-field">
            <label>{t('totalCost')}</label>
            <input
              className="input mono"
              type="number"
              step="0.01"
              min={0}
              inputMode="decimal"
              value={(line.qty * line.unitCost).toFixed(2)}
              onChange={e => {
                const newTotal = parseFloat(e.target.value);
                if (!Number.isFinite(newTotal) || line.qty <= 0) return;
                set('unitCost', +(newTotal / line.qty).toFixed(2));
              }}
            />
          </div>
          {isEditing && (
            <div className="ph-field">
              <label>{t('sellPrice')}</label>
              <input
                className="input mono"
                type="number"
                step="0.01"
                min={0}
                value={line.sellPrice ?? ''}
                placeholder="—"
                onChange={e => set('sellPrice', e.target.value === '' ? null : parseFloat(e.target.value) || 0)}
              />
            </div>
          )}
        </div>

        {isEditing && (() => {
          const qty = line.qty || 0;
          const cost = line.unitCost || 0;
          const sell = line.sellPrice ?? 0;
          const revenue = qty * sell;
          const profit = qty * (sell - cost);
          const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
          const lossy = sell > 0 && sell < cost;
          return (
            <div
              style={{
                display: 'flex', flexWrap: 'wrap', gap: 14, rowGap: 6,
                padding: '10px 12px', marginTop: 8,
                background: 'var(--bg-soft)', border: '1px solid var(--border)',
                borderRadius: 10, fontSize: 12, color: 'var(--fg-subtle)',
              }}
            >
              <span>{t('revenue')} <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>{fmtUSD(revenue, locale)}</span></span>
              <span>{t('profit')} <span className="mono" style={{ color: profit >= 0 ? 'var(--pos)' : 'var(--warn)', fontWeight: 600 }}>{fmtUSD(profit, locale)}</span></span>
              <span>{t('margin')} <span className="mono" style={{ color: 'var(--fg)', fontWeight: 600 }}>{margin.toFixed(1)}%</span></span>
              {lossy && <span style={{ color: 'var(--warn)', fontWeight: 600 }}>⚠ {t('drawerLossyWarn')}</span>}
            </div>
          );
        })()}
      </div>

      <div className="ph-action-bar">
        <button className="ph-btn ghost" onClick={onBack ?? onCancel}>{t('cancel')}</button>
        <button className="ph-btn dark" onClick={save}>
          <Icon name="check" size={16} /> {isEditing ? t('saveChanges') : (isFirst ? t('addToOrder') : t('addItem'))}
        </button>
      </div>
      {lightbox && scanUrl && (
        <ImageLightbox url={scanUrl} alt={t('aiPhotoLabel')} onClose={() => setLightbox(false)} />
      )}
    </div>
  );
}
