import { AttachmentDropzone } from '../../components/AttachmentDropzone';
import { Icon } from '../../components/Icon';
import { CARRIERS } from '../../lib/carrierDetect';
import { PACKAGE_SOURCES, packageSourceLabelKey } from '../../lib/packageSource';
import { useT } from '../../lib/i18n';
import { navigate } from '../../lib/route';
import { FMT_HINT_KEY, useAddPackageForm } from '../../lib/useAddPackageForm';

// Add an existing label (bought outside the system): paste the tracking
// number, the carrier lights up from the number's shape, and the package joins
// the inbound stream. A PO is created later, when the box arrives.
// The form's state machine lives in lib/useAddPackageForm, shared with the
// phone screen.

type ToastKind = 'success' | 'error';
type Props = { showToast: (msg: string, kind?: ToastKind) => void };

export function ShippingAddLabel({ showToast }: Props) {
  const { t } = useT();
  const f = useAddPackageForm(({ carrier, tn }) => {
    showToast(t('shipAddAdded', { carrier, tn }));
    navigate('/shipping');
  });

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
          value={f.raw}
          onChange={(e) => f.setRaw(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void f.submit(); }}
          placeholder={t('shipAddTrackingPh')}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          aria-label={t('shipAddTrackingLabel')}
        />
        <div className="ship-carrier-tiles" role="radiogroup" aria-label={t('shipAddCarrierTitle')}>
          {CARRIERS.map((c) => {
            const lit = f.detected.includes(c);
            const selected = f.carrier === c;
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={selected}
                className={'ship-carrier-tile' + (lit ? ' lit' : '') + (selected ? ' selected' : '')}
                data-carrier={c}
                onClick={() => f.setPick(c)}
              >
                <span className="ship-carrier-name">{c}</span>
                <span className="ship-carrier-fmt mono">{t(FMT_HINT_KEY[c])}</span>
                {selected && <Icon name="check" size={14} />}
              </button>
            );
          })}
        </div>
        <div className="ship-add-hint" aria-live="polite">
          {f.hintKey ? t(f.hintKey) : ' '}
        </div>
      </section>

      <section className="ship-wizard-section">
        <div className="ship-sec-title">{t('shipSource')}</div>
        <div className="field">
          <select
            className="input"
            value={f.source ?? ''}
            onChange={(e) => f.setSource(e.target.value as typeof PACKAGE_SOURCES[number])}
            aria-label={t('shipSource')}
          >
            <option value="" disabled>{t('shipSourcePick')}</option>
            {PACKAGE_SOURCES.map((src) => (
              <option key={src} value={src}>{t(packageSourceLabelKey(src))}</option>
            ))}
          </select>
        </div>
      </section>

      <section className="ship-wizard-section">
        <div className="ship-sec-title">{t('shipAddDetailsTitle')}</div>
        <div className="field-row">
          <div className="field">
            <label className="label">{t('shipSellerName')}</label>
            <input className="input" value={f.sellerName} onChange={(e) => f.setSellerName(e.target.value)} autoComplete="off" />
          </div>
          <div className="field">
            <label className="label">{t('shipAddNote')}</label>
            <input className="input" value={f.note} onChange={(e) => f.setNote(e.target.value)} autoComplete="off" />
          </div>
        </div>
      </section>

      <section className="ship-wizard-section">
        <div className="ship-sec-title">{t('shipPayTitle')}</div>
        <div className="ship-add-hint" style={{ marginBottom: 8 }}>{t('shipPaySub')}</div>
        {f.screenshot ? (
          <div className="ship-pay-shot">
            <img src={f.screenshot.preview} alt={t('shipPayTitle')} />
            <button className="btn ghost sm" onClick={f.removeScreenshot}>
              {t('shipPayRemoveShot')}
            </button>
          </div>
        ) : (
          <AttachmentDropzone
            onFiles={(files) => void f.handlePaymentFile(files)}
            uploading={f.scanBusy}
            accept="image/*"
            multiple={false}
            compact
            boxHint={t('shipPayBoxHint')}
          />
        )}
        {f.scanNoticeKey && (
          <div className="ship-add-hint" role="status">{t(f.scanNoticeKey)}</div>
        )}
        {f.scanError && (
          <div className="ship-add-hint" role="alert">
            {'text' in f.scanError ? f.scanError.text : t(f.scanError.key)}
          </div>
        )}
        <div className="field" style={{ marginTop: 10 }}>
          <label className="label">{t('shipPayTxnLabel')} <span className="req">*</span></label>
          <input
            className="input mono"
            value={f.paypalTxnId}
            onChange={(e) => f.setPaypalTxnId(e.target.value)}
            placeholder={t('shipPayTxnPh')}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="ship-add-hint" aria-live="polite">
            {f.txnLooksOdd ? t('shipPayTxnFormatHint') : ' '}
          </div>
        </div>
      </section>

      <div className="ship-wizard-foot">
        <span />
        <div className="ship-foot-right">
          <button className="btn accent" disabled={!f.canSubmit} onClick={() => void f.submit()}>
            {f.busy ? '…' : t('shipAddSubmit')}
          </button>
        </div>
      </div>
    </div>
  );
}
