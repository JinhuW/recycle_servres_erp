import { useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { CARRIERS, detectCarriers, normalizeTracking, type Carrier } from '../../lib/carrierDetect';
import { handleFetchError } from '../../lib/errorToast';
import { useT } from '../../lib/i18n';
import { addPackage } from '../../lib/packages';
import { navigate } from '../../lib/route';

// Add an existing label (bought outside the system): paste the tracking
// number, the carrier lights up from the number's shape, and the package joins
// the inbound stream. A PO is created later, when the box arrives.

type ToastKind = 'success' | 'error';
type Props = { showToast: (msg: string, kind?: ToastKind) => void };

const FMT_HINT_KEY: Record<Carrier, string> = {
  UPS: 'shipFmtUps',
  FedEx: 'shipFmtFedex',
  USPS: 'shipFmtUsps',
};

export function ShippingAddLabel({ showToast }: Props) {
  const { t } = useT();
  const [raw, setRaw] = useState('');
  const [pick, setPick] = useState<Carrier | null>(null);
  const [sellerName, setSellerName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const tn = normalizeTracking(raw);
  const detected = useMemo(() => detectCarriers(raw), [raw]);
  // A single detection selects itself; ambiguity or no match leaves the pick
  // to the user. A manual pick always wins.
  const carrier = pick ?? (detected.length === 1 ? detected[0] : null);
  const unknownShape = tn.length >= 10 && detected.length === 0;
  const canSubmit = tn.length >= 8 && carrier != null && !busy;

  // setBusy hasn't rendered yet when Enter fires twice in one tick — the ref
  // is the same-tick guard the state can't be.
  const submitting = useRef(false);
  const submit = async () => {
    if (!canSubmit || carrier == null || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      await addPackage({ trackingNumber: tn, carrier, sellerName, note });
      showToast(t('shipAddAdded', { carrier, tn }));
      navigate('/shipping');
    } catch (e) {
      handleFetchError(e);
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="ship-wizard ship-add">
      <div className="ship-wizard-head">
        <button className="btn ghost sm" onClick={() => navigate('/shipping')}>
          ← {t('shipBackToShipping')}
        </button>
      </div>
      <h1 className="ship-wizard-title">{t('shipAddTitle')}</h1>
      <div className="ship-add-sub">{t('shipAddSub')}</div>

      <section className="ship-wizard-section">
        <div className="ship-sec-title">{t('shipAddTrackingLabel')}</div>
        <input
          className="input mono ship-tn-input"
          value={raw}
          onChange={(e) => { setRaw(e.target.value); setPick(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          placeholder={t('shipAddTrackingPh')}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-label={t('shipAddTrackingLabel')}
        />
        <div className="ship-carrier-tiles" role="radiogroup" aria-label={t('shipAddCarrierTitle')}>
          {CARRIERS.map((c) => {
            const lit = detected.includes(c);
            const selected = carrier === c;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={selected}
                className={'ship-carrier-tile' + (lit ? ' lit' : '') + (selected ? ' selected' : '')}
                data-carrier={c}
                onClick={() => setPick(c)}
              >
                <span className="ship-carrier-name">{c}</span>
                <span className="ship-carrier-fmt mono">{t(FMT_HINT_KEY[c])}</span>
                {selected && <Icon name="check" size={14} />}
              </button>
            );
          })}
        </div>
        <div className="ship-add-hint" aria-live="polite">
          {carrier != null && detected.length === 1 && !pick
            ? t('shipAddCarrierAuto')
            : detected.length > 1 && !pick
              ? t('shipAddCarrierPick')
              : unknownShape && !pick
                ? t('shipAddCarrierUnknown')
                : ' '}
        </div>
      </section>

      <section className="ship-wizard-section">
        <div className="ship-sec-title">{t('shipAddDetailsTitle')}</div>
        <div className="field-row">
          <div className="field">
            <label className="label">{t('shipSellerName')}</label>
            <input className="input" value={sellerName} onChange={(e) => setSellerName(e.target.value)} autoComplete="off" />
          </div>
          <div className="field">
            <label className="label">{t('shipAddNote')}</label>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} autoComplete="off" />
          </div>
        </div>
      </section>

      <div className="ship-wizard-foot">
        <span className="ship-add-demo-note">
          <span className="chip muted" style={{ fontSize: 10 }}>{t('shipDemoTag')}</span> {t('shipAddDemoNote')}
        </span>
        <div className="ship-foot-right">
          <button className="btn accent" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? '…' : t('shipAddSubmit')}
          </button>
        </div>
      </div>
    </div>
  );
}
