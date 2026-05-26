import type { Category, DraftLine } from '../lib/types';
import { useT } from '../lib/i18n';
import {
  RAM_BRANDS, RAM_GENERATIONS, RAM_DEVICE_TYPES, RAM_CLASS, RAM_RANK, RAM_CAP, RAM_SPEED,
  SSD_BRANDS, SSD_INTERFACE, SSD_FORM, SSD_CAP,
  HDD_BRANDS, HDD_INTERFACE, HDD_FORM, HDD_CAP, HDD_RPM,
} from '../lib/catalog';

type Props = {
  category: Category;
  value: DraftLine;
  onChange: <K extends keyof DraftLine>(key: K, v: DraftLine[K]) => void;
  aiFilled?: boolean;
};

// Mark required fields with the same color token used on desktop (.label .req).
const Req = () => <span style={{ color: 'var(--neg)', marginLeft: 2 }}>*</span>;

/**
 * Catalog-backed select that survives the value not appearing in the
 * catalog yet — same orphan-safe pattern as desktop's `CatSelect`. Without
 * this, a stored value that's no longer (or not yet) in the catalog
 * silently renders as blank.
 */
function PhCatSelect({
  value, options, onChange, className,
}: {
  value: string | null | undefined;
  options: readonly string[];
  onChange: (v: string) => void;
  className: string;
}) {
  const { t } = useT();
  const hasValue = value != null && value !== '';
  const orphan = hasValue && !options.includes(value as string);
  return (
    <select className={className} value={value ?? ''} onChange={e => onChange(e.target.value)}>
      <option value="">{t('selectPlaceholder')}</option>
      {orphan && <option value={value as string}>{value}</option>}
      {options.map(o => <option key={o}>{o}</option>)}
    </select>
  );
}

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
            <label>{t('brand')}<Req /></label>
            <PhCatSelect className={selectCls} value={value.brand} options={RAM_BRANDS} onChange={v => onChange('brand', v)} />
          </div>
          <div className="ph-field">
            <label>{t('generation')}</label>
            <PhCatSelect className={selectCls} value={value.generation} options={RAM_GENERATIONS} onChange={v => onChange('generation', v)} />
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('capacity')}<Req /></label>
            <PhCatSelect className={selectCls} value={value.capacity} options={RAM_CAP} onChange={v => onChange('capacity', v)} />
          </div>
          <div className="ph-field">
            <label>{t('speedMhz')}</label>
            <PhCatSelect className={selectCls} value={value.speed} options={RAM_SPEED} onChange={v => onChange('speed', v)} />
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('klass')}</label>
            <PhCatSelect className={selectCls} value={value.classification} options={RAM_CLASS} onChange={v => onChange('classification', v)} />
          </div>
          <div className="ph-field">
            <label>{t('rank')}</label>
            <PhCatSelect className={selectCls} value={value.rank} options={RAM_RANK} onChange={v => onChange('rank', v)} />
          </div>
        </div>
        <div className="ph-field">
          <label>{t('type')}</label>
          <PhCatSelect className={selectCls} value={value.type} options={RAM_DEVICE_TYPES} onChange={v => onChange('type', v)} />
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
            <label>{t('brand')}<Req /></label>
            <PhCatSelect className={selectCls} value={value.brand} options={SSD_BRANDS} onChange={v => onChange('brand', v)} />
          </div>
          <div className="ph-field">
            <label>{t('capacity')}<Req /></label>
            <PhCatSelect className={selectCls} value={value.capacity} options={SSD_CAP} onChange={v => onChange('capacity', v)} />
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('interfaceLbl')}<Req /></label>
            <PhCatSelect className={selectCls} value={value.interface} options={SSD_INTERFACE} onChange={v => onChange('interface', v)} />
          </div>
          <div className="ph-field">
            <label>{t('formFactor')}</label>
            <PhCatSelect className={selectCls} value={value.formFactor} options={SSD_FORM} onChange={v => onChange('formFactor', v)} />
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('partNumber')}</label>
            <input className={inputCls + ' mono'} value={value.partNumber ?? ''} onChange={e => onChange('partNumber', e.target.value)} />
          </div>
          <div className="ph-field">
            <label>{t('health')} (%)</label>
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              className={inputCls}
              value={value.health ?? ''}
              onChange={e => onChange('health', e.target.value === '' ? null : Number(e.target.value))}
            />
          </div>
        </div>
      </>
    );
  }

  if (category === 'HDD') {
    return (
      <>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('brand')}<Req /></label>
            <PhCatSelect className={selectCls} value={value.brand} options={HDD_BRANDS} onChange={v => onChange('brand', v)} />
          </div>
          <div className="ph-field">
            <label>{t('capacity')}<Req /></label>
            <PhCatSelect className={selectCls} value={value.capacity} options={HDD_CAP} onChange={v => onChange('capacity', v)} />
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('interfaceLbl')}<Req /></label>
            <PhCatSelect className={selectCls} value={value.interface} options={HDD_INTERFACE} onChange={v => onChange('interface', v)} />
          </div>
          <div className="ph-field">
            <label>{t('formFactor')}</label>
            <PhCatSelect className={selectCls} value={value.formFactor} options={HDD_FORM} onChange={v => onChange('formFactor', v)} />
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label>{t('rpm')}<Req /></label>
            <PhCatSelect
              className={selectCls}
              value={value.rpm == null ? undefined : String(value.rpm)}
              options={HDD_RPM}
              onChange={v => onChange('rpm', v === '' ? null : Number(v))}
            />
          </div>
          <div className="ph-field">
            <label>{t('health')} (%)</label>
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              className={inputCls}
              value={value.health ?? ''}
              onChange={e => onChange('health', e.target.value === '' ? null : Number(e.target.value))}
            />
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
        <label>{t('description')}<Req /></label>
        <input className={inputCls} value={value.description ?? ''} onChange={e => onChange('description', e.target.value)} />
      </div>
      <div className="ph-field">
        <label>{t('partNumber')}</label>
        <input className={inputCls + ' mono'} value={value.partNumber ?? ''} onChange={e => onChange('partNumber', e.target.value)} />
      </div>
    </>
  );
}
