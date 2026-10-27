import { useId } from 'react';
import type { Category, DraftLine } from '../lib/types';
import { useT } from '../lib/i18n';
import { allowedOptions, chipMarkingCanon, synthesizePartNumber } from '@recycle-erp/shared';
import { Combobox } from './Combobox';
import { PartNumberField } from './PartNumberField';
import { ItemTypePicker } from './ItemTypePicker';
import { RamShortCode } from './RamShortCode';
import { RamPartReadout } from './RamPartCheck';
import { ramFieldRequired } from '../lib/ramRequired';
import { ssdBrandRequired, SSD_BRAND_REQUIRED_OVER_GB } from '../lib/lineRequirements';
import {
  RAM_BRANDS, RAM_GENERATIONS, RAM_DEVICE_TYPES, RAM_CLASS, RAM_RANK, RAM_CAP,
  SSD_BRANDS, SSD_INTERFACE, SSD_FORM, SSD_CAP,
  HDD_BRANDS, HDD_INTERFACE, HDD_FORM, HDD_CAP, HDD_RPM,
} from '../lib/catalog';

type Props = {
  category: Category;
  value: DraftLine;
  onChange: <K extends keyof DraftLine>(key: K, v: DraftLine[K]) => void;
  aiFilled?: boolean;
  // Field keys whose AI-extracted value is suspect (overall confidence below
  // the verify threshold) AND not yet edited by the user. Red-bordered until
  // the user touches them, signalling "verify this".
  aiLowConfFields?: ReadonlySet<keyof DraftLine>;
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
  value, options, onChange, className, id,
}: {
  value: string | null | undefined;
  options: readonly string[];
  onChange: (v: string) => void;
  className: string;
  id?: string;
}) {
  const { t } = useT();
  const hasValue = value != null && value !== '';
  const orphan = hasValue && !options.includes(value as string);
  return (
    <select id={id} className={className} value={value ?? ''} onChange={e => onChange(e.target.value)}>
      <option value="">{t('selectPlaceholder')}</option>
      {orphan && <option value={value as string}>{value}</option>}
      {options.map(o => <option key={o}>{o}</option>)}
    </select>
  );
}

/**
 * Catalog field that also accepts a custom value (drive capacity / brand —
 * their real-world set outruns the catalog). Single field: type anything, or
 * pick a preset. Styled like the sell-order Customer picker.
 */
function PhCatCombo({
  value, options, onChange, className, id,
}: {
  value: string | null | undefined;
  options: readonly string[];
  onChange: (v: string) => void;
  className: string;
  id?: string;
}) {
  const { t } = useT();
  return <Combobox id={id} value={value} options={options} onChange={onChange} placeholder={t('selectPlaceholder')} className={className} />;
}

/**
 * Per-category form fields (brand, capacity, type, etc.). Used by SubmitForm
 * in both "new line" and "edit line" modes — the wrapping page provides the
 * header, AI banner, action bar, and any other category-agnostic surrounding.
 */
export function PhCategoryFields({ category, value, onChange, aiFilled, aiLowConfFields }: Props) {
  const { t } = useT();
  // Every label names its control: the labels sat beside the fields with no
  // association, so a screen reader read each select and input as unnamed.
  const idBase = useId();
  const fid = (k: string) => `${idBase}-${k}`;
  const baseInputCls = 'input' + (aiFilled ? ' ai-filled' : '');
  const baseSelectCls = 'select' + (aiFilled ? ' ai-filled' : '');
  const lowConf = (k: keyof DraftLine) => !!aiLowConfFields && aiLowConfFields.has(k);
  const inputClsFor = (k: keyof DraftLine) => baseInputCls + (lowConf(k) ? ' ai-low-conf' : '');
  const selectClsFor = (k: keyof DraftLine) => baseSelectCls + (lowConf(k) ? ' ai-low-conf' : '');

  if (category === 'RAM') {
    return (
      <>
        <div className="ph-field-row">
          <div className="ph-field">
            <label htmlFor={fid('brand')}>{t('brand')}{ramFieldRequired(value, 'brand') && <Req />}</label>
            <PhCatSelect id={fid('brand')} className={selectClsFor('brand')} value={value.brand} options={RAM_BRANDS} onChange={v => onChange('brand', v)} />
          </div>
          <div className="ph-field">
            <label htmlFor={fid('generation')}>{t('generation')}{ramFieldRequired(value, 'generation') && <Req />}</label>
            <PhCatSelect id={fid('generation')} className={selectClsFor('generation')} value={value.generation} options={RAM_GENERATIONS} onChange={v => onChange('generation', v)} />
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label htmlFor={fid('capacity')}>{t('capacity')}{ramFieldRequired(value, 'capacity') && <Req />}</label>
            <PhCatSelect id={fid('capacity')} className={selectClsFor('capacity')} value={value.capacity} options={RAM_CAP} onChange={v => onChange('capacity', v)} />
          </div>
          <div className="ph-field">
            <label htmlFor={fid('speed')}>{t('speedMhz')}{ramFieldRequired(value, 'speed') && <Req />}</label>
            <input id={fid('speed')}
              className={inputClsFor('speed')}
              value={value.speed ?? ''}
              onChange={e => onChange('speed', e.target.value)}
            />
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label htmlFor={fid('classification')}>{t('klass')}{ramFieldRequired(value, 'classification') && <Req />}</label>
            <PhCatSelect id={fid('classification')} className={selectClsFor('classification')} value={value.classification} options={allowedOptions('RAM', 'classification', value, RAM_CLASS)} onChange={v => onChange('classification', v)} />
          </div>
          <div className="ph-field">
            <label htmlFor={fid('rank')}>{t('rank')}{ramFieldRequired(value, 'rank') && <Req />}</label>
            <PhCatSelect id={fid('rank')} className={selectClsFor('rank')} value={value.rank} options={allowedOptions('RAM', 'rank', value, RAM_RANK)} onChange={v => onChange('rank', v)} />
          </div>
        </div>
        <div className="ph-field">
          <label htmlFor={fid('type')}>{t('type')}{ramFieldRequired(value, 'type') && <Req />}</label>
          <PhCatSelect id={fid('type')} className={selectClsFor('type')} value={value.type} options={RAM_DEVICE_TYPES} onChange={v => onChange('type', v)} />
        </div>
        <div className="ph-field">
          <label htmlFor={fid('chipNumber')}>{t('chipNumber')}{ramFieldRequired(value, 'chipNumber') && <Req />}</label>
          <input id={fid('chipNumber')}
            className={inputClsFor('chipNumber') + ' mono'}
            value={value.chipNumber ?? ''}
            onChange={e => onChange('chipNumber', e.target.value.toUpperCase())}
            onBlur={e => {
              const canon = chipMarkingCanon(e.target.value, value.brand);
              if (canon !== (value.chipNumber ?? '')) onChange('chipNumber', canon);
            }}
          />
        </div>
        <div className="ph-field">
          <label htmlFor={fid('partNumber')}>{t('partNumber')}{ramFieldRequired(value, 'partNumber') && <Req />}</label>
          <PartNumberField id={fid('partNumber')} className={inputClsFor('partNumber') + ' mono'} value={value.partNumber} placeholder={synthesizePartNumber('RAM', value) ?? undefined} onChange={v => onChange('partNumber', v)} />
          <RamShortCode line={value} />
          <RamPartReadout
            line={{ ...value, category }}
            onUse={patch => {
              for (const [k, v] of Object.entries(patch)) onChange(k as keyof DraftLine, v);
            }}
            onUsePart={v => onChange('partNumber', v)}
          />
        </div>
      </>
    );
  }

  if (category === 'SSD') {
    const brandRequired = ssdBrandRequired(value.capacity);
    const brandMissing = brandRequired && !(value.brand ?? '').trim();
    return (
      <>
        <div className="ph-field-row">
          <div className="ph-field">
            <label htmlFor={fid('brand')}>{t('brand')}{brandRequired && <Req />}</label>
            <PhCatCombo id={fid('brand')} className={inputClsFor('brand')} value={value.brand} options={SSD_BRANDS} onChange={v => onChange('brand', v)} />
            {brandMissing && (
              <div style={{ fontSize: 11, color: 'var(--neg)', marginTop: 4 }}>
                {t('ssdBrandNeededOverGb', { gb: SSD_BRAND_REQUIRED_OVER_GB })}
              </div>
            )}
          </div>
          <div className="ph-field">
            <label htmlFor={fid('capacity')}>{t('capacity')}<Req /></label>
            <PhCatSelect id={fid('capacity')} className={selectClsFor('capacity')} value={value.capacity} options={SSD_CAP} onChange={v => onChange('capacity', v)} />
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label htmlFor={fid('interface')}>{t('interfaceLbl')}<Req /></label>
            <PhCatSelect id={fid('interface')} className={selectClsFor('interface')} value={value.interface} options={SSD_INTERFACE} onChange={v => onChange('interface', v)} />
          </div>
          <div className="ph-field">
            <label htmlFor={fid('formFactor')}>{t('formFactor')}</label>
            <PhCatSelect id={fid('formFactor')} className={selectClsFor('formFactor')} value={value.formFactor} options={allowedOptions('SSD', 'formFactor', value, SSD_FORM)} onChange={v => onChange('formFactor', v)} />
          </div>
        </div>
        <div className="ph-field">
          <label htmlFor={fid('partNumber')}>{t('partNumber')}</label>
          <PartNumberField id={fid('partNumber')} className={inputClsFor('partNumber') + ' mono'} value={value.partNumber} placeholder={synthesizePartNumber('SSD', value) ?? undefined} onChange={v => onChange('partNumber', v)} />
        </div>
      </>
    );
  }

  if (category === 'HDD') {
    return (
      <>
        <div className="ph-field-row">
          <div className="ph-field">
            <label htmlFor={fid('brand')}>{t('brand')}<Req /></label>
            <PhCatCombo id={fid('brand')} className={inputClsFor('brand')} value={value.brand} options={HDD_BRANDS} onChange={v => onChange('brand', v)} />
          </div>
          <div className="ph-field">
            <label htmlFor={fid('capacity')}>{t('capacity')}<Req /></label>
            <PhCatCombo id={fid('capacity')} className={inputClsFor('capacity')} value={value.capacity} options={HDD_CAP} onChange={v => onChange('capacity', v)} />
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label htmlFor={fid('interface')}>{t('interfaceLbl')}<Req /></label>
            <PhCatSelect id={fid('interface')} className={selectClsFor('interface')} value={value.interface} options={HDD_INTERFACE} onChange={v => onChange('interface', v)} />
          </div>
          <div className="ph-field">
            <label htmlFor={fid('formFactor')}>{t('formFactor')}</label>
            <PhCatSelect id={fid('formFactor')} className={selectClsFor('formFactor')} value={value.formFactor} options={HDD_FORM} onChange={v => onChange('formFactor', v)} />
          </div>
        </div>
        <div className="ph-field-row">
          <div className="ph-field">
            <label htmlFor={fid('rpm')}>{t('rpm')}<Req /></label>
            <PhCatSelect id={fid('rpm')}
              className={selectClsFor('rpm')}
              value={value.rpm == null ? undefined : String(value.rpm)}
              options={HDD_RPM}
              onChange={v => onChange('rpm', v === '' ? null : Number(v))}
            />
          </div>
          <div className="ph-field">
            <label htmlFor={fid('health')}>{t('health')} (%)</label>
            <input id={fid('health')}
              type="number"
              min={0}
              max={100}
              step={0.1}
              className={inputClsFor('health')}
              value={value.health ?? ''}
              onChange={e => onChange('health', e.target.value === '' ? null : Number(e.target.value))}
            />
          </div>
        </div>
        <div className="ph-field">
          <label htmlFor={fid('partNumber')}>{t('partNumber')}</label>
          <PartNumberField id={fid('partNumber')} className={inputClsFor('partNumber') + ' mono'} value={value.partNumber} onChange={v => onChange('partNumber', v)} />
        </div>
      </>
    );
  }

  // Other
  return (
    <>
      <div className="ph-field">
        <label htmlFor={fid('itemType')}>{t('lfItemType')}<Req /></label>
        <ItemTypePicker id={fid('itemType')} value={value.itemType} onChange={v => onChange('itemType', v)} />
      </div>
      <div className="ph-field">
        <label htmlFor={fid('description')}>{t('description')}</label>
        <input id={fid('description')} className={inputClsFor('description')} value={value.description ?? ''} onChange={e => onChange('description', e.target.value)} />
      </div>
      <div className="ph-field">
        {/* Named as the drawer names it, since it's the field the "still
            needed" toast lists for an Other line. */}
        <label htmlFor={fid('partNumber')}>{t('lfPartSku')}<Req /></label>
        <PartNumberField id={fid('partNumber')} className={inputClsFor('partNumber') + ' mono'} value={value.partNumber} onChange={v => onChange('partNumber', v)} />
      </div>
    </>
  );
}
