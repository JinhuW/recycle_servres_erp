import {
  RAM_BRANDS, RAM_GENERATIONS, RAM_DEVICE_TYPES, RAM_CLASS, RAM_RANK, RAM_CAP,
  SSD_BRANDS, SSD_INTERFACE, SSD_FORM, SSD_CAP,
  HDD_BRANDS, HDD_INTERFACE, HDD_FORM, HDD_CAP, HDD_RPM,
  CONDITIONS,
} from '../../../lib/catalog';
import { useT } from '../../../lib/i18n';
import { chipNumberRequired } from '../../../lib/ramRequired';
import { ssdBrandRequired, SSD_BRAND_REQUIRED_OVER_GB } from '../../../lib/lineRequirements';
import { synthesizePartNumber } from '@recycle-erp/shared';
import { Combobox } from '../../../components/Combobox';
import { PartNumberField } from '../../../components/PartNumberField';
import { ItemTypePicker } from '../../../components/ItemTypePicker';
import type { Line } from '../DesktopSubmit';

// ─── Field groups ────────────────────────────────────────────────────────────
// `missing` carries the i18n label keys lib/lineRequirements reports blank, so
// the drawer's "still needed" list and the fields it names are driven by one
// answer — a named field the eye then has to hunt for is only half a prompt.
type FieldsProps = {
  line: Line;
  set: (patch: Partial<Line>) => void;
  missing?: ReadonlySet<string>;
};

/** Wrapper class and control flag for a field, by its label key. */
function gapMarks(missing: ReadonlySet<string> | undefined) {
  return {
    cls: (key: string) => 'field' + (missing?.has(key) ? ' is-missing' : ''),
    bad: (key: string) => missing?.has(key) || undefined,
  };
}

// Catalog dropdowns must never silently swallow the stored value. If the
// catalog hasn't finished loading yet, or the value pre-dates a catalog
// edit (renamed/removed option), include it as a one-off option so the
// user still sees what was actually saved instead of an empty select.
function CatSelect({ value, options, onChange, invalid }: { value: string | undefined; options: readonly string[]; onChange: (v: string) => void; invalid?: boolean }) {
  const { t } = useT();
  const hasValue = value != null && value !== '';
  const orphan = hasValue && !options.includes(value);
  return (
    <select className="select" value={value ?? ''} aria-invalid={invalid} onChange={e => onChange(e.target.value)}>
      <option value="">{t('selectPlaceholder')}</option>
      {orphan && <option value={value}>{value}</option>}
      {options.map(o => <option key={o}>{o}</option>)}
    </select>
  );
}

// Catalog field that also accepts a custom value (drive capacity / brand —
// their real-world set outruns the catalog). Single field: type anything, or
// pick a preset. Styled like the sell-order Customer picker.
function CatCombo({ value, options, onChange, invalid }: { value: string | undefined; options: readonly string[]; onChange: (v: string) => void; invalid?: boolean }) {
  const { t } = useT();
  return <Combobox value={value} options={options} onChange={onChange} invalid={invalid} placeholder={t('selectPlaceholder')} />;
}

export function RamFields({ line, set, missing }: FieldsProps) {
  const { t } = useT();
  const { cls, bad } = gapMarks(missing);
  return (
    <div className="grid-2">
      <div className={cls('brand')}>
        <label className="label">{t('brand')} <span className="req">*</span></label>
        <CatSelect value={line.brand} options={RAM_BRANDS} invalid={bad('brand')} onChange={v => set({ brand: v })} />
      </div>
      <div className={cls('capacity')}>
        <label className="label">{t('capacity')} <span className="req">*</span></label>
        <CatSelect value={line.capacity} options={RAM_CAP} invalid={bad('capacity')} onChange={v => set({ capacity: v })} />
      </div>
      <div className={cls('generation')}>
        <label className="label">{t('generation')} <span className="req">*</span></label>
        <CatSelect value={line.generation} options={RAM_GENERATIONS} invalid={bad('generation')} onChange={v => set({ generation: v })} />
      </div>
      <div className={cls('type')}>
        <label className="label">{t('type')} <span className="req">*</span></label>
        <CatSelect value={line.type} options={RAM_DEVICE_TYPES} invalid={bad('type')} onChange={v => set({ type: v })} />
      </div>
      <div className={cls('klass')}>
        <label className="label">{t('klass')} <span className="req">*</span></label>
        <CatSelect value={line.classification} options={RAM_CLASS} invalid={bad('klass')} onChange={v => set({ classification: v })} />
      </div>
      <div className={cls('rank')}>
        <label className="label">{t('rank')} <span className="req">*</span></label>
        <CatSelect value={line.rank} options={RAM_RANK} invalid={bad('rank')} onChange={v => set({ rank: v })} />
      </div>
      <div className={cls('speedMhz')}>
        <label className="label">{t('speedMhz')} <span className="req">*</span></label>
        <input
          className="input"
          value={line.speed ?? ''}
          aria-invalid={bad('speedMhz')}
          onChange={e => set({ speed: e.target.value })}
        />
      </div>
      <div className={cls('chipNumber')}>
        <label className="label">{t('chipNumber')} {chipNumberRequired(line.brand) && <span className="req">*</span>}</label>
        <input
          className="input mono"
          value={line.chipNumber ?? ''}
          aria-invalid={bad('chipNumber')}
          onChange={e => set({ chipNumber: e.target.value.toUpperCase() })}
        />
      </div>
      <div className={cls('partNumber')} style={{ gridColumn: 'span 2' }}>
        <label className="label">{t('partNumber')} <span className="req">*</span></label>
        <PartNumberField
          value={line.partNumber}
          invalid={bad('partNumber')}
          onChange={v => set({ partNumber: v })}
          placeholder="M393A4K40DB3-CWE"
        />
      </div>
      <div className="field" style={{ gridColumn: 'span 2' }}>
        <label className="label">{t('condition')} <span className="req">*</span></label>
        <CatSelect value={line.condition} options={CONDITIONS} onChange={v => set({ condition: v })} />
      </div>
    </div>
  );
}

export function SsdFields({ line, set }: FieldsProps) {
  const { t } = useT();
  const brandRequired = ssdBrandRequired(line.capacity);
  const brandMissing = brandRequired && !(line.brand ?? '').trim();
  return (
    <div className="grid-2">
      <div className="field">
        <label className="label">{t('brand')} {brandRequired && <span className="req">*</span>}</label>
        <CatCombo value={line.brand} options={SSD_BRANDS} invalid={brandMissing || undefined} onChange={v => set({ brand: v })} />
        {brandMissing && (
          <div style={{ fontSize: 11, color: 'var(--neg)', marginTop: 4 }}>
            {t('ssdBrandNeededOverGb', { gb: SSD_BRAND_REQUIRED_OVER_GB })}
          </div>
        )}
      </div>
      <div className="field">
        <label className="label">{t('capacity')} <span className="req">*</span></label>
        <CatSelect value={line.capacity} options={SSD_CAP} onChange={v => set({ capacity: v })} />
      </div>
      <div className="field">
        <label className="label">{t('interfaceLbl')} <span className="req">*</span></label>
        <CatSelect value={line.interface} options={SSD_INTERFACE} onChange={v => set({ interface: v })} />
      </div>
      <div className="field">
        <label className="label">{t('formFactor')}</label>
        <CatSelect value={line.formFactor} options={SSD_FORM} onChange={v => set({ formFactor: v })} />
      </div>
      <div className="field" style={{ gridColumn: 'span 2' }}>
        <label className="label">{t('partNumber')}</label>
        <PartNumberField
          value={line.partNumber}
          placeholder={synthesizePartNumber('SSD', line) ?? undefined}
          onChange={v => set({ partNumber: v })}
        />
      </div>
      <div className="field" style={{ gridColumn: 'span 2' }}>
        <label className="label">{t('condition')} <span className="req">*</span></label>
        <CatSelect value={line.condition} options={CONDITIONS} onChange={v => set({ condition: v })} />
      </div>
    </div>
  );
}

export function HddFields({ line, set }: FieldsProps) {
  const { t } = useT();
  return (
    <div className="grid-2">
      <div className="field">
        <label className="label">{t('brand')} <span className="req">*</span></label>
        <CatCombo value={line.brand} options={HDD_BRANDS} onChange={v => set({ brand: v })} />
      </div>
      <div className="field">
        <label className="label">{t('capacity')} <span className="req">*</span></label>
        <CatCombo value={line.capacity} options={HDD_CAP} onChange={v => set({ capacity: v })} />
      </div>
      <div className="field">
        <label className="label">{t('interfaceLbl')} <span className="req">*</span></label>
        <CatSelect value={line.interface} options={HDD_INTERFACE} onChange={v => set({ interface: v })} />
      </div>
      <div className="field">
        <label className="label">{t('formFactor')}</label>
        <CatSelect value={line.formFactor} options={HDD_FORM} onChange={v => set({ formFactor: v })} />
      </div>
      <div className="field">
        <label className="label">{t('rpm')} <span className="req">*</span></label>
        <CatSelect
          value={line.rpm == null ? undefined : String(line.rpm)}
          options={HDD_RPM}
          onChange={v => set({ rpm: v === '' ? null : Number(v) })}
        />
      </div>
      <div className="field">
        <label className="label">{t('healthPct')}</label>
        <input
          type="number" min={0} max={100} step={0.1}
          className="input"
          value={line.health ?? ''}
          onChange={e => set({ health: e.target.value === '' ? null : Number(e.target.value) })}
        />
      </div>
      <div className="field" style={{ gridColumn: 'span 2' }}>
        <label className="label">{t('partNumber')}</label>
        <PartNumberField
          value={line.partNumber}
          onChange={v => set({ partNumber: v })}
        />
      </div>
      <div className="field" style={{ gridColumn: 'span 2' }}>
        <label className="label">{t('condition')} <span className="req">*</span></label>
        <CatSelect value={line.condition} options={CONDITIONS} onChange={v => set({ condition: v })} />
      </div>
    </div>
  );
}

export function OtherFields({ line, set }: FieldsProps) {
  const { t } = useT();
  return (
    <div className="grid-2">
      {/* Type first, then the specific detail — the same broad-to-narrow order
          the spec'd categories read in (brand → capacity → …). */}
      <div className="field" style={{ gridColumn: 'span 2' }}>
        <label className="label">{t('lfItemType')} <span className="req">*</span></label>
        <ItemTypePicker value={line.itemType} onChange={v => set({ itemType: v })} />
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{t('lfItemTypeHint')}</div>
      </div>
      <div className="field" style={{ gridColumn: 'span 2' }}>
        <label className="label">{t('lfItemDescription')}</label>
        <input
          className="input"
          value={line.description ?? ''}
          onChange={e => set({ description: e.target.value })}
          placeholder={t('lfItemDescriptionPh')}
        />
      </div>
      <div className="field">
        <label className="label">{t('lfPartSku')} <span className="req">*</span></label>
        <PartNumberField
          value={line.partNumber}
          onChange={v => set({ partNumber: v })}
        />
      </div>
      <div className="field">
        <label className="label">{t('condition')} <span className="req">*</span></label>
        <CatSelect value={line.condition} options={CONDITIONS} onChange={v => set({ condition: v })} />
      </div>
    </div>
  );
}
