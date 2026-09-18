import { Icon } from './Icon';
import { PaymentFields } from './PaymentFields';
import { useT } from '../lib/i18n';
import { PACKAGE_SOURCES, packageSourceLabelKey } from '../lib/packageSource';
import { CARRIERS } from '../lib/carrierDetect';
import { FMT_HINT_KEY } from '../lib/useAddPackageForm';
import { useHandoffForm, type HandoffInit } from '../lib/useHandoffForm';
import { useEscapeKey } from '../lib/useEscapeKey';

// The Draft → In Transit hand-off. One body (`HandoffFields`) for both shells,
// wrapped here in the desktop modal and in PhHandoffSheet on the phone. Every
// rule lives in lib/handoff.ts + lib/useHandoffForm.ts; this file is markup.

type Props = {
  init: HandoffInit;
  onCancel: () => void;
  onDone: (r: { packageId: string | null }) => void;
};

export function HandoffFields({ f, phone = false }: { f: ReturnType<typeof useHandoffForm>; phone?: boolean }) {
  const { t } = useT();
  const selectCls = phone ? 'input' : 'select';

  return (
    <div className="ho-body">
      <section className="ho-sec">
        <div className="ho-row">
          <div className="field">
            <label className="label" htmlFor="ho-warehouse">{t('hoWarehouse')}</label>
            <select id="ho-warehouse" className={selectCls} value={f.warehouseId} onChange={e => f.setWarehouseId(e.target.value)}>
              {f.warehouses.length === 0 && <option value={f.warehouseId}>{f.warehouseId || '—'}</option>}
              {f.warehouses.map(w => <option key={w.id} value={w.id}>{w.short} — {w.region}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="ho-source">{t('hoSource')} <span className="req">*</span></label>
            <select id="ho-source" className={selectCls} value={f.source ?? ''} onChange={e => f.setSource((e.target.value || null) as typeof f.source)}>
              <option value="" disabled>{t('hoSourcePick')}</option>
              {PACKAGE_SOURCES.map(s => <option key={s} value={s}>{t(packageSourceLabelKey(s))}</option>)}
            </select>
          </div>
        </div>
      </section>

      <section className="ho-sec">
        <div className="ho-sec-title">{t('hoDelivery')}</div>
        <div className="ho-tiles" role="radiogroup" aria-label={t('hoDelivery')}>
          {(['pickup', 'label'] as const).map(d => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={f.delivery === d}
              className={'ho-tile' + (f.delivery === d ? ' selected' : '')}
              onClick={() => f.setDelivery(d)}
            >
              <span className="ho-radio" aria-hidden="true" />
              <span className="ho-tile-name">{t(d === 'pickup' ? 'hoPickup' : 'hoLabel')}</span>
              <span className="ho-tile-desc">{t(d === 'pickup' ? 'hoPickupDesc' : 'hoLabelDesc')}</span>
            </button>
          ))}
        </div>

        {f.delivery === 'pickup' && (
          <div className="field">
            <label className="label" htmlFor="ho-by">{t('hoPickedBy')}</label>
            <select id="ho-by" className={selectCls} value={f.byUserId} onChange={e => f.setByUserId(e.target.value)}>
              {f.members.length === 0 && <option value={f.byUserId}>…</option>}
              {f.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        )}

        {f.delivery === 'label' && (
          <>
            <div className="field">
              <label className="label" htmlFor="ho-tracking">{t('shipAddTrackingLabel')} <span className="req">*</span></label>
              <input
                id="ho-tracking"
                className="input mono"
                value={f.raw}
                onChange={e => f.setRaw(e.target.value)}
                placeholder={t('shipAddTrackingPh')}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="ho-carriers" role="radiogroup" aria-label={t('shipAddCarrierTitle')}>
              {CARRIERS.map(c => {
                const lit = f.detected.includes(c);
                const selected = f.carrier === c;
                return (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={'ho-carrier' + (lit ? ' lit' : '') + (selected ? ' selected' : '')}
                    data-carrier={c}
                    onClick={() => f.setPick(c)}
                  >
                    <span className="ho-carrier-name">{c}</span>
                    <span className="ho-carrier-fmt mono">{t(FMT_HINT_KEY[c])}</span>
                    {selected && <Icon name="check" size={13} />}
                  </button>
                );
              })}
            </div>
            <div className="ship-add-hint" aria-live="polite">{f.hintKey ? t(f.hintKey) : ' '}</div>
          </>
        )}
      </section>

      <section className="ho-sec">
        <div className="ho-sec-title">{t('hoPayment')}</div>
        <PaymentFields
          paidBy={f.paidBy} onPaidBy={f.setPaidBy}
          method={f.method} onMethod={f.setMethod}
          txnId={f.txnId} onTxnId={f.setTxnId}
          txnRequired
          phone={phone}
          proof={f.proof}
          idPrefix="ho"
        />
      </section>
    </div>
  );
}

export function HandoffManagerFields({ f, phone = false }: { f: ReturnType<typeof useHandoffForm>; phone?: boolean }) {
  const { t } = useT();
  const selectCls = phone ? 'input' : 'select';
  return (
    <section className="ho-sec">
      <div className="ho-sec-title">{t('hoManager')} <small>{t('hoManagerOnly')}</small></div>
      <div className="ho-row">
        <div className="field">
          <label className="label" htmlFor="ho-owner">{t('poOnBehalfLabel')}</label>
          <select id="ho-owner" className={selectCls} value={f.ownerId} onChange={e => f.setOwnerId(e.target.value)}>
            {!f.members.some(m => m.id === f.ownerId) && <option value={f.ownerId}>…</option>}
            {f.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="ho-rate">{t('commissionRate')}</label>
          <input
            id="ho-rate"
            className="input tabular"
            type="number"
            min={0}
            max={100}
            step="0.1"
            value={f.commissionPct}
            onChange={e => f.setCommissionPct(e.target.value)}
          />
        </div>
      </div>
    </section>
  );
}

export function HandoffBlockers({ keys }: { keys: string[] }) {
  const { t } = useT();
  if (!keys.length) return null;
  return (
    <div className="ho-blockers" aria-live="polite">
      {keys.map(k => (
        <div key={k}><Icon name="alert" size={13} /><span>{t(k)}</span></div>
      ))}
    </div>
  );
}

export function HandoffDialog({ init, onCancel, onDone }: Props) {
  const { t } = useT();
  const f = useHandoffForm(init, onDone);
  useEscapeKey(onCancel, !f.busy);

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !f.busy) onCancel(); }}>
      <div className="modal-shell ho-shell" role="dialog" aria-modal="true" aria-labelledby="ho-title">
        <div className="modal-head">
          <div>
            <div className="modal-title" id="ho-title">{t('hoTitle')}</div>
            <div className="modal-sub">{t('hoSub')}</div>
          </div>
          <button type="button" className="btn ghost sm" onClick={onCancel} disabled={f.busy} aria-label={t('cancel')}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="modal-body">
          <HandoffFields f={f} />
          {init.isManager && <HandoffManagerFields f={f} />}
        </div>
        <div className="modal-foot ho-foot">
          <HandoffBlockers keys={f.blockerKeys} />
          <div className="ho-actions">
            <button type="button" className="btn" onClick={onCancel} disabled={f.busy}>{t('cancel')}</button>
            <button type="button" className="btn accent" onClick={() => void f.submit()} disabled={!f.canSubmit}>
              {f.busy ? t('hoWorking') : t('hoConfirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
