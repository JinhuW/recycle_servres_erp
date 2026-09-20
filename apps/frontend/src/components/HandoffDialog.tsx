import { useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { PaymentFields } from './PaymentFields';
import { fmtUSD } from '../lib/format';
import { useT } from '../lib/i18n';
import { PACKAGE_SOURCES, packageSourceLabelKey } from '../lib/packageSource';
import { CARRIERS } from '../lib/carrierDetect';
import { poEffectiveCost } from '../lib/poTotals';
import type { ReadinessItem, ReadinessTab } from '../lib/poReadiness';
import { FMT_HINT_KEY } from '../lib/useAddPackageForm';
import { useHandoffForm, type HandoffInit } from '../lib/useHandoffForm';
import { useEscapeKey } from '../lib/useEscapeKey';

// The Draft → In Transit checkpoint. One body (`HandoffFields`) for both
// shells, wrapped here in the desktop modal and in PhHandoffSheet on the phone.
// Each section folds to a ✓ row when the order already answers it and opens
// only when it doesn't — a page that holds everything is one click — with a
// "Change" affordance for the person who wants to look anyway. Every rule
// lives in lib/poReadiness.ts + lib/useHandoffForm.ts; this file is markup.

type Props = {
  init: HandoffInit;
  onCancel: () => void;
  onDone: (r: { packageId: string | null }) => void;
};

type Form = ReturnType<typeof useHandoffForm>;

function itemFor(f: Form, tab: ReadinessTab): ReadinessItem | undefined {
  return f.readiness.find(r => r.tab === tab);
}

/** A section that is a ✓ row while met and a form while not. Once someone
 *  opens a met section it stays open — a fold that snaps shut mid-edit
 *  because the answer became valid would be maddening. */
function HandoffSection({ item, title, summary, children, phone }: {
  item: ReadinessItem | undefined; title: string; summary: string; children: ReactNode; phone: boolean;
}) {
  const { t } = useT();
  const [opened, setOpened] = useState(false);
  const ok = item?.ok ?? false;
  const open = !ok || opened;
  return (
    <section className={'ho-sec' + (ok ? ' ho-sec-met' : '')} data-tab={item?.tab}>
      <div className="ho-sec-head">
        <span className={'ho-check ' + (ok ? 'ok' : item?.blocking === false ? 'soft' : 'miss')} aria-hidden="true">
          {ok ? <Icon name="check" size={11} /> : '!'}
        </span>
        <span className="ho-sec-title">{title}</span>
        {/* An unmet section's fields are open right below and the footer names
            what is missing; saying it a third time here only crowds a phone. */}
        {ok && <span className="ho-sec-sum">{summary}</span>}
        {ok && !opened && (
          <button type="button" className={phone ? 'ph-btn ghost' : 'btn ghost sm'} onClick={() => setOpened(true)}>
            {t('hoChange')}
          </button>
        )}
      </div>
      {open && children}
    </section>
  );
}

export function HandoffFields({ f, phone = false }: { f: Form; phone?: boolean }) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const selectCls = phone ? 'input' : 'select';
  const order = f.order;

  const units = order.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const goods = poEffectiveCost({
    lineSubtotal: order.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0),
    totalCostOverride: order.totalCost,
  }).goods;
  const products = itemFor(f, 'products');

  const wh = f.warehouses.find(w => w.id === f.warehouseId);
  const collector = f.members.find(m => m.id === f.byUserId)?.name ?? order.handoffBy?.name ?? null;
  const deliverySummary = [
    f.source ? t(packageSourceLabelKey(f.source)) : null,
    wh?.short ?? null,
    f.delivery === 'pickup' ? [t('hoPickup'), collector].filter(Boolean).join(' · ')
      : f.delivery === 'label' ? [f.carrier, f.tn].filter(Boolean).join(' ') : null,
  ].filter(Boolean).join(' · ');
  const proofN = f.paidBy === 'self' ? f.proof.chatAtts.length
    : f.method === 'cash' ? f.proof.proofAtts.length : (f.proof.screenshot ? 1 : 0);
  const paymentSummary = [
    f.paidBy === 'self' ? t('paySelfShort') : t('payCompanyShort'),
    f.paidBy === 'company' ? (f.method === 'cash' ? t('hoMethodCash') : f.method === 'paypal' ? t('hoMethodPaypal') : null) : null,
    f.paidBy === 'company' && f.method === 'paypal' ? f.txnId.trim() || null : null,
    proofN > 0 ? t('payProofOnFile', { n: proofN }) : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="ho-body">
      {/* Products are the page's, not the checkpoint's: a row that says so,
          never a form. */}
      <section className={'ho-sec' + (products?.ok ? ' ho-sec-met' : '')} data-tab="products">
        <div className="ho-sec-head">
          <span className={'ho-check ' + (products?.ok ? 'ok' : 'miss')} aria-hidden="true">
            {products?.ok ? <Icon name="check" size={11} /> : '!'}
          </span>
          <span className="ho-sec-title">{t('poReadyProducts')}</span>
          <span className={'ho-sec-sum' + (products?.ok ? '' : ' miss')}>
            {products?.ok
              ? t('subUnitsCost', { n: units, cost: fmtUSD(goods, locale) })
              : (products?.needKeys ?? []).map(k => t(k)).join(' ')}
          </span>
        </div>
      </section>

      <HandoffSection item={itemFor(f, 'delivery')} title={t('poReadyDelivery')} summary={deliverySummary} phone={phone}>
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
      </HandoffSection>

      <HandoffSection item={itemFor(f, 'payment')} title={t('hoPayment')} summary={paymentSummary} phone={phone}>
        <PaymentFields
          paidBy={f.paidBy} onPaidBy={f.setPaidBy}
          method={f.method} onMethod={f.setMethod}
          txnId={f.txnId} onTxnId={f.setTxnId}
          txnRequired
          phone={phone}
          proof={f.proof}
          idPrefix="ho"
        />
      </HandoffSection>
    </div>
  );
}

export function HandoffManagerFields({ f, phone = false }: { f: Form; phone?: boolean }) {
  const { t } = useT();
  const selectCls = phone ? 'input' : 'select';
  const owner = f.members.find(m => m.id === f.ownerId)?.name ?? f.order.userName;
  const pct = f.commissionPct.trim();
  return (
    <div className="ho-body ho-body-manager">
      <HandoffSection
        item={itemFor(f, 'commission')}
        title={`${t('poReadyCommission')} · ${t('hoManagerOnly')}`}
        summary={[owner, pct !== '' ? `${pct}%` : null].filter(Boolean).join(' · ')}
        phone={phone}
      >
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
      </HandoffSection>
    </div>
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
  const missing = f.blockerKeys.length;

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget && !f.busy) onCancel(); }}>
      <div className="modal-shell ho-shell" role="dialog" aria-modal="true" aria-labelledby="ho-title">
        <div className="modal-head">
          <div>
            <div className="modal-title" id="ho-title">{t('hoTitle')}</div>
            <div className="modal-sub">{missing ? t('hoNeedsN', { n: missing }) : t('hoAllSet')}</div>
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
