import { Icon } from '../../../components/Icon';
import { CARRIERS } from '../../../lib/carrierDetect';
import { useT } from '../../../lib/i18n';
import { PACKAGE_SOURCES, packageSourceLabelKey, type PackageSource } from '../../../lib/packageSource';
import type { HandoffDelivery } from '../../../lib/handoff';
import { STATUS_CHIP } from '../../../lib/shippingList';
import type { OrderPackage, Warehouse } from '../../../lib/types';
import { FMT_HINT_KEY } from '../../../lib/useAddPackageForm';
import type { TrackingInput } from '../../../lib/useTrackingInput';
import { relTime } from '../../../lib/format';

// Where the goods came from and how they get here — the hand-off's facts, now
// the page's to edit until Ready to Pay. Same tiles and carrier chips as the
// checkpoint (they share the CSS and the tracking recipe), so a number pasted
// here is recognised exactly as it would be there.

type Props = {
  source: PackageSource | null; onSource: (s: PackageSource | null) => void;
  warehouseId: string; onWarehouse: (id: string) => void;
  warehouses: Warehouse[]; warehouseFallback: string;
  delivery: HandoffDelivery | null; onDelivery: (d: HandoffDelivery) => void;
  byUserId: string; onByUser: (id: string) => void;
  members: { id: string; name: string }[];
  tracking: TrackingInput;
  /** The linked box as the server knows it — the live line under the fields. */
  pkg: OrderPackage | null | undefined;
  disabled: boolean;
  locale: string;
};

export function DeliveryTab(p: Props) {
  const { t } = useT();
  const { tracking } = p;
  const chip = p.pkg ? STATUS_CHIP[p.pkg.status] : null;
  return (
    <div className="oe-tabpad">
      <div className="oe-fields oe-fields-3">
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label" htmlFor="oe-source">{t('hoSource')}</label>
          <select
            id="oe-source"
            className="select"
            value={p.source ?? ''}
            onChange={e => p.onSource((e.target.value || null) as PackageSource | null)}
            disabled={p.disabled}
            style={{ width: '100%' }}
          >
            <option value="">{t('hoSourcePick')}</option>
            {PACKAGE_SOURCES.map(s => <option key={s} value={s}>{t(packageSourceLabelKey(s))}</option>)}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label" htmlFor="oe-warehouse">{t('hoWarehouse')}</label>
          <div style={{ position: 'relative' }}>
            <Icon name="warehouse" size={13} style={{
              position: 'absolute', left: 10, top: '50%',
              transform: 'translateY(-50%)', color: 'var(--fg-subtle)', pointerEvents: 'none',
            }} />
            <select
              id="oe-warehouse"
              className="select"
              value={p.warehouseId}
              onChange={e => p.onWarehouse(e.target.value)}
              disabled={p.disabled}
              style={{ paddingLeft: 30, width: '100%' }}
            >
              {p.warehouses.length === 0 && <option value={p.warehouseId}>{p.warehouseFallback}</option>}
              {p.warehouses.map(w => <option key={w.id} value={w.id}>{w.name ?? w.short}</option>)}
            </select>
          </div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label">{t('poDeliveryHow')}</label>
          <div className="seg oe-seg" role="radiogroup" aria-label={t('poDeliveryHow')}>
            {(['label', 'pickup'] as const).map(d => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={p.delivery === d}
                className={p.delivery === d ? 'on' : ''}
                onClick={() => p.onDelivery(d)}
                disabled={p.disabled}
              >
                {t(d === 'pickup' ? 'hoPickup' : 'hoLabel')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {p.delivery === 'pickup' && (
        <div className="oe-fields oe-fields-3" style={{ marginTop: 14 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="oe-by">{t('hoPickedBy')}</label>
            <select
              id="oe-by"
              className="select"
              value={p.byUserId}
              onChange={e => p.onByUser(e.target.value)}
              disabled={p.disabled}
              style={{ width: '100%' }}
            >
              <option value="">{t('poCollectorPick')}</option>
              {p.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </div>
      )}

      {p.delivery === 'label' && (
        <div className="oe-fields" style={{ marginTop: 14, gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 3fr)' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="oe-tracking">{t('shipAddTrackingLabel')}</label>
            <input
              id="oe-tracking"
              className="input mono"
              value={tracking.raw}
              onChange={e => tracking.setRaw(e.target.value)}
              placeholder={t('shipAddTrackingPh')}
              autoComplete="off"
              spellCheck={false}
              disabled={p.disabled}
            />
            <div className="ship-add-hint" aria-live="polite">{tracking.hintKey ? t(tracking.hintKey) : ' '}</div>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label">{t('shipAddCarrierTitle')}</label>
            <div className="ho-carriers" role="radiogroup" aria-label={t('shipAddCarrierTitle')}>
              {CARRIERS.map(c => {
                const lit = tracking.detected.includes(c);
                const selected = tracking.carrier === c;
                return (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={'ho-carrier' + (lit ? ' lit' : '') + (selected ? ' selected' : '')}
                    data-carrier={c}
                    onClick={() => tracking.setPick(c)}
                    disabled={p.disabled}
                  >
                    <span className="ho-carrier-name">{c}</span>
                    <span className="ho-carrier-fmt mono">{t(FMT_HINT_KEY[c])}</span>
                    {selected && <Icon name="check" size={13} />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {p.delivery === 'label' && p.pkg && chip && (
        <div className="oe-pkg-line">
          <Icon name="truck" size={13} />
          <span className={'chip dot ' + chip.cls} style={{ fontSize: 10.5 }}>{t(chip.key)}</span>
          {p.pkg.trackingStatus && <span>{p.pkg.trackingStatus}</span>}
          {p.pkg.lastTrackedAt && (
            <span className="muted">· {t('poPkgLastReport', { when: relTime(p.pkg.lastTrackedAt, p.locale) })}</span>
          )}
          <span className="muted" style={{ marginLeft: 'auto' }}>{t('eoPkgSeeStatus')}</span>
        </div>
      )}

      <div className="oe-tab-note">{p.disabled ? t('eoDeliveryFrozen') : t('eoDeliveryEditableUntil')}</div>
    </div>
  );
}
