import {
  RAM_BRANDS, RAM_GENERATIONS, RAM_DEVICE_TYPES, RAM_CLASS, RAM_RANK, RAM_CAP,
  SSD_BRANDS, SSD_INTERFACE, SSD_FORM, SSD_CAP,
  HDD_BRANDS, HDD_INTERFACE, HDD_FORM, HDD_CAP, HDD_RPM,
  CONDITIONS,
} from '../../../lib/catalog';
import { useT } from '../../../lib/i18n';
import type { Line } from '../DesktopSubmit';

// ─── Field groups ────────────────────────────────────────────────────────────
type FieldsProps = { line: Line; set: (patch: Partial<Line>) => void };

// Catalog dropdowns must never silently swallow the stored value. If the
// catalog hasn't finished loading yet, or the value pre-dates a catalog
// edit (renamed/removed option), include it as a one-off option so the
// user still sees what was actually saved instead of an empty select.
function CatSelect({ value, options, onChange }: { value: string | undefined; options: readonly string[]; onChange: (v: string) => void }) {
  const { t } = useT();
  const hasValue = value != null && value !== '';
  const orphan = hasValue && !options.includes(value);
  return (
    <select className="select" value={value ?? ''} onChange={e => onChange(e.target.value)}>
      <option value="">{t('selectPlaceholder')}</option>
      {orphan && <option value={value}>{value}</option>}
      {options.map(o => <option key={o}>{o}</option>)}
    </select>
  );
}

export function RamFields({ line, set }: FieldsProps) {
  const { t } = useT();
  return (
    <div className="grid-2">
      <div className="field">
        <label className="label">{t('brand')} <span className="req">*</span></label>
        <CatSelect value={line.brand} options={RAM_BRANDS} onChange={v => set({ brand: v })} />
      </div>
      <div className="field">
        <label className="label">{t('capacity')} <span className="req">*</span></label>
        <CatSelect value={line.capacity} options={RAM_CAP} onChange={v => set({ capacity: v })} />
      </div>
      <div className="field">
        <label className="label">{t('generation')}</label>
        <CatSelect value={line.generation} options={RAM_GENERATIONS} onChange={v => set({ generation: v })} />
      </div>
      <div className="field">
        <label className="label">{t('type')}</label>
        <CatSelect value={line.type} options={RAM_DEVICE_TYPES} onChange={v => set({ type: v })} />
      </div>
      <div className="field">
        <label className="label">{t('klass')}</label>
        <CatSelect value={line.classification} options={RAM_CLASS} onChange={v => set({ classification: v })} />
      </div>
      <div className="field">
        <label className="label">{t('rank')}</label>
        <CatSelect value={line.rank} options={RAM_RANK} onChange={v => set({ rank: v })} />
      </div>
      <div className="field">
        <label className="label">{t('speedMhz')}</label>
        <input
          className="input"
          value={line.speed ?? ''}
          onChange={e => set({ speed: e.target.value })}
        />
      </div>
      <div className="field" style={{ gridColumn: 'span 2' }}>
        <label className="label">{t('partNumber')}</label>
        <input
          className="input mono"
          value={line.partNumber ?? ''}
          onChange={e => set({ partNumber: e.target.value })}
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
  return (
    <div className="grid-2">
      <div className="field">
        <label className="label">{t('brand')} <span className="req">*</span></label>
        <CatSelect value={line.brand} options={SSD_BRANDS} onChange={v => set({ brand: v })} />
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
        <input
          className="input mono"
          value={line.partNumber ?? ''}
          onChange={e => set({ partNumber: e.target.value })}
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
      <div className="field">
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
        <CatSelect value={line.brand} options={HDD_BRANDS} onChange={v => set({ brand: v })} />
      </div>
      <div className="field">
        <label className="label">{t('capacity')} <span className="req">*</span></label>
        <CatSelect value={line.capacity} options={HDD_CAP} onChange={v => set({ capacity: v })} />
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
        <input
          className="input mono"
          value={line.partNumber ?? ''}
          onChange={e => set({ partNumber: e.target.value })}
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
      <div className="field" style={{ gridColumn: 'span 2' }}>
        <label className="label">{t('lfItemDescription')} <span className="req">*</span></label>
        <input
          className="input"
          value={line.description ?? ''}
          onChange={e => set({ description: e.target.value })}
          placeholder={t('lfItemDescriptionPh')}
        />
      </div>
      <div className="field">
        <label className="label">{t('lfPartSku')}</label>
        <input
          className="input mono"
          value={line.partNumber ?? ''}
          onChange={e => set({ partNumber: e.target.value })}
        />
      </div>
      <div className="field">
        <label className="label">{t('condition')} <span className="req">*</span></label>
        <CatSelect value={line.condition} options={CONDITIONS} onChange={v => set({ condition: v })} />
      </div>
    </div>
  );
}
