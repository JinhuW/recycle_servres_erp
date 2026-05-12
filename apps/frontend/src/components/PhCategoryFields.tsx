import type { Category, DraftLine } from '../lib/types';
import { useT } from '../lib/i18n';

type Props = {
  category: Category;
  value: DraftLine;
  onChange: <K extends keyof DraftLine>(key: K, v: DraftLine[K]) => void;
  aiFilled?: boolean;
};

/**
 * Per-category form fields (brand, capacity, type, etc.). Used by SubmitForm
 * in both "new line" and "edit line" modes — the wrapping page provides the
 * header, AI banner, action bar, and any other category-agnostic surrounding.
 */
export function PhCategoryFields({ category, value, onChange, aiFilled }: Props) {
  const { t } = useT();
  const inputCls = 'input' + (aiFilled ? ' ai-filled' : '');
  const selectCls = 'select' + (aiFilled ? ' ai-filled' : '');

  if (category === 'RAM') {
    return (
      <>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('brand')}</label>
            <input className={inputCls} value={value.brand ?? ''} onChange={e => onChange('brand', e.target.value)} />
          </div>
          <div className="ph-field">
            <label>{t('type')}</label>
            <select className={selectCls} value={value.type ?? 'DDR4'} onChange={e => onChange('type', e.target.value)}>
              <option>DDR3</option><option>DDR4</option><option>DDR5</option>
            </select>
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('capacity')}</label>
            <select className={selectCls} value={value.capacity ?? '32GB'} onChange={e => onChange('capacity', e.target.value)}>
              <option>4GB</option><option>8GB</option><option>16GB</option><option>32GB</option><option>64GB</option><option>128GB</option>
            </select>
          </div>
          <div className="ph-field">
            <label>{t('speedMhz')}</label>
            <input className={inputCls} value={value.speed ?? ''} onChange={e => onChange('speed', e.target.value)} />
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('klass')}</label>
            <select className={selectCls} value={value.classification ?? 'RDIMM'} onChange={e => onChange('classification', e.target.value)}>
              <option>UDIMM</option><option>RDIMM</option><option>LRDIMM</option><option>SODIMM</option>
            </select>
          </div>
          <div className="ph-field">
            <label>{t('rank')}</label>
            <select className={selectCls} value={value.rank ?? '2Rx4'} onChange={e => onChange('rank', e.target.value)}>
              <option>1Rx4</option><option>1Rx8</option><option>2Rx4</option><option>2Rx8</option><option>4Rx4</option>
            </select>
          </div>
        </div>
        <div className="ph-field">
          <label>{t('partNumber')}</label>
          <input className={inputCls + ' mono'} value={value.partNumber ?? ''} onChange={e => onChange('partNumber', e.target.value)} />
        </div>
      </>
    );
  }

  if (category === 'SSD') {
    return (
      <>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('brand')}</label>
            <input className={inputCls} value={value.brand ?? ''} onChange={e => onChange('brand', e.target.value)} />
          </div>
          <div className="ph-field">
            <label>{t('capacity')}</label>
            <input className={inputCls} value={value.capacity ?? ''} onChange={e => onChange('capacity', e.target.value)} />
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('interfaceLbl')}</label>
            <select className={selectCls} value={value.interface ?? 'NVMe'} onChange={e => onChange('interface', e.target.value)}>
              <option>SATA</option><option>SAS</option><option>NVMe</option><option>U.2</option>
            </select>
          </div>
          <div className="ph-field">
            <label>{t('formFactor')}</label>
            <select className={selectCls} value={value.formFactor ?? 'M.2 2280'} onChange={e => onChange('formFactor', e.target.value)}>
              <option>2.5"</option><option>M.2 2280</option><option>M.2 22110</option><option>U.2</option><option>AIC</option>
            </select>
          </div>
        </div>
        <div className="ph-field">
          <label>{t('partNumber')}</label>
          <input className={inputCls + ' mono'} value={value.partNumber ?? ''} onChange={e => onChange('partNumber', e.target.value)} />
        </div>
      </>
    );
  }

  // Other
  return (
    <>
      <div className="ph-field">
        <label>{t('description')}</label>
        <input className={inputCls} value={value.description ?? ''} onChange={e => onChange('description', e.target.value)} />
      </div>
      <div className="ph-field">
        <label>{t('partNumber')}</label>
        <input className={inputCls + ' mono'} value={value.partNumber ?? ''} onChange={e => onChange('partNumber', e.target.value)} />
      </div>
    </>
  );
}
