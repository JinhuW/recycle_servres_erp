import { useState } from 'react';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { useT } from '../lib/i18n';
import type { Category, DraftLine, ScanResponse } from '../lib/types';

type Props = {
  category: Category;
  detected: ScanResponse | null;
  lineCount: number;
  editingLineIdx?: number | null;
  existingLine?: DraftLine;
  onSaveLine: (line: DraftLine) => void;
  onCancel: () => void;
  onBack?: () => void;
  onRescan: () => void;
};

// Per-line form. The category-specific fields mirror the prototype's
// PhSubmitForm; we use controlled inputs here so the values bubble back to
// the order-review screen as a fully formed line.
export function SubmitForm({ category, detected, lineCount, onSaveLine, onCancel, onRescan, onBack: _onBack, editingLineIdx: _editingLineIdx, existingLine: _existingLine }: Props) {
  const { t } = useT();
  const aiFilled = !!detected;
  const isFirst = lineCount === 0;
  const f = detected?.extracted ?? {};

  const defaults: DraftLine = {
    category,
    brand: (f.brand as string) ?? (category === 'RAM' ? 'Samsung' : category === 'SSD' ? 'Samsung' : null),
    capacity: (f.capacity as string) ?? (category === 'RAM' ? '32GB' : category === 'SSD' ? '1.92TB' : null),
    type: (f.type as string) ?? (category === 'RAM' ? 'DDR4' : null),
    classification: (f.classification as string) ?? (category === 'RAM' ? 'RDIMM' : null),
    rank: (f.rank as string) ?? (category === 'RAM' ? '2Rx4' : null),
    speed: (f.speed as string) ?? (category === 'RAM' ? '3200' : null),
    interface: (f.interface as string) ?? (category === 'SSD' ? 'NVMe' : null),
    formFactor: (f.formFactor as string) ?? (category === 'SSD' ? 'M.2 22110' : null),
    description: (f.description as string) ?? (category === 'Other' ? 'Intel Xeon Gold 6248' : null),
    partNumber: (f.partNumber as string) ?? '',
    qty: 4,
    unitCost: 78,
    sellPrice: null,
    condition: 'Pulled — Tested',
    scanImageId: detected?.imageId ?? null,
    scanConfidence: detected?.confidence ?? null,
  };

  const [line, setLine] = useState<DraftLine>(defaults);
  const set = <K extends keyof DraftLine>(k: K, v: DraftLine[K]) => setLine(prev => ({ ...prev, [k]: v }));

  const buildLabel = (): string => {
    if (line.category === 'RAM') return [line.brand, line.capacity, line.type].filter(Boolean).join(' ');
    if (line.category === 'SSD') return [line.brand, line.capacity, line.interface].filter(Boolean).join(' ');
    return line.description ?? 'Item';
  };

  const save = () => onSaveLine({ ...line, label: buildLabel(), partNumber: line.partNumber || '—' });

  return (
    <div className="phone-app">
      <PhHeader
        title={isFirst
          ? (category === 'RAM' ? t('newRamOrder') : category === 'SSD' ? t('newSsdOrder') : t('newOtherOrder'))
          : (category === 'RAM' ? t('addRamItem') : category === 'SSD' ? t('addSsdItem') : t('addOtherItem'))}
        sub={isFirst
          ? (aiFilled ? t('aiReview') : t('fillIn'))
          : t('addingItem', { n: lineCount + 1 })}
        leading={<button className="ph-icon-btn" onClick={onCancel}><Icon name="chevronLeft" size={16} /></button>}
        trailing={category === 'RAM' && <button className="ph-icon-btn" onClick={onRescan}><Icon name="camera" size={16} /></button>}
      />
      <div className="ph-scroll" style={{ paddingBottom: 110 }}>
        {aiFilled && (
          <div className="ph-ai-banner" style={{ borderRadius: 12, marginTop: 6 }}>
            <span className="pill-ai">AI</span>
            <span>{t('extractedConf', { pct: Math.round((detected!.confidence) * 100) })}</span>
            <Icon name="sparkles" size={13} style={{ marginLeft: 'auto' }} />
          </div>
        )}

        {category === 'RAM' && (
          <>
            <div className="ph-field-row">
              <div className="ph-field">
                <label>{t('brand')}</label>
                <input className={'input' + (aiFilled ? ' ai-filled' : '')} value={line.brand ?? ''} onChange={e => set('brand', e.target.value)} />
              </div>
              <div className="ph-field">
                <label>{t('type')}</label>
                <select className={'select' + (aiFilled ? ' ai-filled' : '')} value={line.type ?? 'DDR4'} onChange={e => set('type', e.target.value)}>
                  <option>DDR3</option><option>DDR4</option><option>DDR5</option>
                </select>
              </div>
            </div>
            <div className="ph-field-row">
              <div className="ph-field">
                <label>{t('capacity')}</label>
                <select className={'select' + (aiFilled ? ' ai-filled' : '')} value={line.capacity ?? '32GB'} onChange={e => set('capacity', e.target.value)}>
                  <option>4GB</option><option>8GB</option><option>16GB</option><option>32GB</option><option>64GB</option><option>128GB</option>
                </select>
              </div>
              <div className="ph-field">
                <label>{t('speedMhz')}</label>
                <input className={'input' + (aiFilled ? ' ai-filled' : '')} value={line.speed ?? ''} onChange={e => set('speed', e.target.value)} />
              </div>
            </div>
            <div className="ph-field-row">
              <div className="ph-field">
                <label>{t('klass')}</label>
                <select className={'select' + (aiFilled ? ' ai-filled' : '')} value={line.classification ?? 'RDIMM'} onChange={e => set('classification', e.target.value)}>
                  <option>UDIMM</option><option>RDIMM</option><option>LRDIMM</option><option>SODIMM</option>
                </select>
              </div>
              <div className="ph-field">
                <label>{t('rank')}</label>
                <select className={'select' + (aiFilled ? ' ai-filled' : '')} value={line.rank ?? '2Rx4'} onChange={e => set('rank', e.target.value)}>
                  <option>1Rx4</option><option>1Rx8</option><option>2Rx4</option><option>2Rx8</option><option>4Rx4</option>
                </select>
              </div>
            </div>
            <div className="ph-field">
              <label>{t('partNumber')}</label>
              <input className={'input mono' + (aiFilled ? ' ai-filled' : '')} value={line.partNumber ?? ''} onChange={e => set('partNumber', e.target.value)} />
            </div>
          </>
        )}

        {category === 'SSD' && (
          <>
            <div className="ph-field-row">
              <div className="ph-field"><label>{t('brand')}</label><input className="input" value={line.brand ?? ''} onChange={e => set('brand', e.target.value)} /></div>
              <div className="ph-field"><label>{t('capacity')}</label><input className="input" value={line.capacity ?? ''} onChange={e => set('capacity', e.target.value)} /></div>
            </div>
            <div className="ph-field-row">
              <div className="ph-field">
                <label>{t('interfaceLbl')}</label>
                <select className="select" value={line.interface ?? 'NVMe'} onChange={e => set('interface', e.target.value)}>
                  <option>SATA</option><option>SAS</option><option>NVMe</option><option>U.2</option>
                </select>
              </div>
              <div className="ph-field">
                <label>{t('formFactor')}</label>
                <select className="select" value={line.formFactor ?? 'M.2 2280'} onChange={e => set('formFactor', e.target.value)}>
                  <option>2.5"</option><option>M.2 2280</option><option>M.2 22110</option><option>U.2</option><option>AIC</option>
                </select>
              </div>
            </div>
            <div className="ph-field"><label>{t('partNumber')}</label><input className="input mono" value={line.partNumber ?? ''} onChange={e => set('partNumber', e.target.value)} /></div>
          </>
        )}

        {category === 'Other' && (
          <>
            <div className="ph-field"><label>{t('description')}</label><input className="input" value={line.description ?? ''} onChange={e => set('description', e.target.value)} /></div>
            <div className="ph-field"><label>{t('partNumber')}</label><input className="input mono" value={line.partNumber ?? ''} onChange={e => set('partNumber', e.target.value)} /></div>
          </>
        )}

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

        <div className="ph-field">
          <label>{t('unitCost')}</label>
          <input className="input mono" type="number" step="0.01" min={0} value={line.unitCost} onChange={e => set('unitCost', parseFloat(e.target.value) || 0)} />
        </div>
      </div>

      <div className="ph-action-bar">
        <button className="ph-btn ghost" onClick={onCancel}>{t('cancel')}</button>
        <button className="ph-btn dark" onClick={save}>
          <Icon name="check" size={16} /> {isFirst ? t('addToOrder') : t('addItem')}
        </button>
      </div>
    </div>
  );
}
