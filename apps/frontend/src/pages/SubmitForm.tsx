import { useState } from 'react';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { PhCategoryFields } from '../components/PhCategoryFields';
import { useT } from '../lib/i18n';
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
  category,
  brand: null,
  capacity: null,
  type: null,
  classification: null,
  rank: null,
  speed: null,
  interface: null,
  formFactor: null,
  description: null,
  partNumber: '',
  qty: 1,
  unitCost: 0,
  sellPrice: null,
  condition: 'Pulled — Tested',
  scanImageId: null,
  scanConfidence: null,
});

const aiPatch = (scan: ScanResponse): Partial<DraftLine> => {
  const f = scan.extracted ?? {};
  const out: Partial<DraftLine> = {};
  if (f.brand)          out.brand          = f.brand as string;
  if (f.capacity)       out.capacity       = f.capacity as string;
  if (f.type)           out.type           = f.type as string;
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
    category,
    brand:          (f.brand as string)          ?? null,
    capacity:       (f.capacity as string)       ?? null,
    type:           (f.type as string)           ?? null,
    classification: (f.classification as string) ?? null,
    rank:           (f.rank as string)           ?? null,
    speed:          (f.speed as string)          ?? null,
    interface:      (f.interface as string)      ?? null,
    formFactor:     (f.formFactor as string)     ?? null,
    description:    (f.description as string)    ?? null,
    partNumber:     (f.partNumber as string)     ?? '',
    qty: 1,
    unitCost: 0,
    sellPrice: null,
    condition: 'Pulled — Tested',
    scanImageId: scan.imageId ?? null,
    scanConfidence: scan.confidence ?? null,
  };
};

export function SubmitForm({ category, detected, lineCount, editingLineIdx, existingLine, onSaveLine, onCancel, onBack, onRescan, rescanDraft }: Props) {
  const { t } = useT();
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
  const mergeBase = rescanDraft ?? (isEditing ? existingLine : undefined);
  const initial: DraftLine = mergeBase
    ? (detected ? { ...mergeBase, ...aiPatch(detected) } : mergeBase)
    : (detected ? aiDefaults(category, detected) : blankDefaults(category));

  const [line, setLine] = useState<DraftLine>(initial);
  const [lightbox, setLightbox] = useState(false);
  const [thumbBroken, setThumbBroken] = useState(false);

  const scanUrl = existingLine?.scanImageUrl ?? null;
  const showThumb =
    isEditing &&
    !!scanUrl &&
    !scanUrl.startsWith('data:image/placeholder') &&
    !thumbBroken;

  const set = <K extends keyof DraftLine>(k: K, v: DraftLine[K]) => setLine(prev => ({ ...prev, [k]: v }));

  const buildLabel = (): string => {
    if (line.category === 'RAM') return [line.brand, line.capacity, line.type].filter(Boolean).join(' ');
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
        trailing={category === 'RAM' && (
          <button className="ph-icon-btn" onClick={() => onRescan(line)} title={t('rescanWithAi')}>
            <Icon name="camera" size={16} />
          </button>
        )}
      />
      <div className="ph-scroll" style={{ paddingBottom: 110 }}>
        {category === 'RAM' && line.scanImageUrl && (
          <img src={line.scanImageUrl} alt="Captured label"
               style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid var(--border)', margin: '8px 0' }} />
        )}
        {aiFilled && (
          <div className="ph-ai-banner" style={{ borderRadius: 12, marginTop: 6 }}>
            <span className="pill-ai">AI</span>
            <span>{t('extractedConf', { pct: Math.round((detected!.confidence) * 100) })}</span>
            <Icon name="sparkles" size={13} style={{ marginLeft: 'auto' }} />
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

        <PhCategoryFields category={category} value={line} onChange={set} aiFilled={aiFilled} />

        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('quantity')}</label>
            <input className="input" type="number" min={1} value={line.qty} onChange={e => set('qty', parseInt(e.target.value, 10) || 0)} />
          </div>
          <div className="ph-field">
            <label>{t('condition')}</label>
            <select className="select" value={line.condition ?? 'Pulled — Tested'} onChange={e => set('condition', e.target.value)}>
              <option>New</option><option>Pulled — Tested</option><option>Pulled — Untested</option><option>Used</option>
            </select>
          </div>
        </div>

        <div className={isEditing ? 'ph-field-row' : undefined}>
          <div className="ph-field">
            <label>{t('unitCost')}</label>
            <input className="input mono" type="number" step="0.01" min={0} value={line.unitCost} onChange={e => set('unitCost', parseFloat(e.target.value) || 0)} />
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
