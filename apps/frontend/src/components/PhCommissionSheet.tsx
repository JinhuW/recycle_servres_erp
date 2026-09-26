import { Icon } from './Icon';
import { fmtUSD } from '../lib/format';
import { useT } from '../lib/i18n';
import { PhSheet } from './PhSheet';

// Who the order is for and what they earn — the desktop Commission tab's
// facts, on the phone. The fields render twice: in the PO page's Commission
// fold, and in the sheet a manager confirms on the way to Ready to Pay, the
// stage that fixes them. One component so the two can't drift.

export type CommissionMath = {
  payment: 'company' | 'self';
  revenue: number;
  totalCost: number;
  pricedCount: number;
  lineCount: number;
};

type FieldsProps = {
  ownerId: string; onOwner: (id: string) => void;
  ownerOptions: { id: string; name: string }[];
  commissionPct: string; onCommissionPct: (v: string) => void;
  /** False shows the values as read-back rows instead of inputs. */
  editable: boolean;
  math: CommissionMath;
  locale: string;
  /** Under the fields: why they are read-only, or what editing costs. */
  note?: string;
  /** The fold and the sheet are mounted at once (the fold only hides), so
   *  their inputs need distinct ids or a label focuses the wrong one. */
  idPrefix?: string;
};

function commissionPreview(pct: string, m: CommissionMath) {
  const parsed = pct.trim() === '' ? null : Number(pct);
  const rate = parsed !== null && Number.isFinite(parsed) ? parsed / 100 : 0;
  const profit = m.revenue - m.totalCost;
  const onProfit = profit * rate;
  return { rate, profit, onProfit, earns: (m.payment === 'self' ? m.totalCost : 0) + onProfit };
}

export function PhCommissionFields(p: FieldsProps) {
  const { t } = useT();
  const idp = p.idPrefix ?? 'ph';
  const owner = p.ownerOptions.find(o => o.id === p.ownerId)?.name ?? '—';
  const pv = commissionPreview(p.commissionPct, p.math);
  const row = (k: string, v: string, strong = false) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, gap: 10 }}>
      <span style={{ color: 'var(--fg-subtle)' }}>{k}</span>
      <span className="mono" style={{ fontWeight: strong ? 600 : 400 }}>{v}</span>
    </div>
  );
  return (
    <>
      {p.editable ? (
        <div className="ph-fold-ro">
          <div className="ph-field">
            <label htmlFor={`${idp}-owner`}>{t('poOnBehalfLabel')}</label>
            <select id={`${idp}-owner`} className="select" value={p.ownerId} onChange={e => p.onOwner(e.target.value)}>
              {p.ownerOptions.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div className="ph-field">
            <label htmlFor={`${idp}-rate`}>{t('commissionRate')}</label>
            <input
              id={`${idp}-rate`}
              className="input mono"
              type="number"
              min={0}
              max={100}
              step="0.1"
              inputMode="decimal"
              value={p.commissionPct}
              placeholder={t('eoSetRate')}
              onChange={e => p.onCommissionPct(e.target.value)}
            />
          </div>
        </div>
      ) : (
        <div className="ph-fold-ro">
          <div className="ph-field"><label>{t('poOnBehalfLabel')}</label><div className="v">{owner}</div></div>
          <div className="ph-field"><label>{t('commissionRate')}</label><div className="v mono">{p.commissionPct.trim() === '' ? '—' : `${p.commissionPct}%`}</div></div>
        </div>
      )}
      <div style={{ display: 'grid', gap: 6, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
        {row(t('revenue'), fmtUSD(p.math.revenue, p.locale))}
        {row(t('eoCost'), fmtUSD(p.math.totalCost, p.locale))}
        {row(t('eoCommissionOnProfit'), fmtUSD(pv.onProfit, p.locale))}
        {p.math.payment === 'self' && row(t('eoSelfPay'), fmtUSD(p.math.totalCost, p.locale))}
        {row(t('eoPurchaserEarns'), fmtUSD(pv.earns, p.locale), true)}
        {p.math.pricedCount < p.math.lineCount && (
          <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>
            {t('eoUnpricedLinesHint', { n: p.math.lineCount - p.math.pricedCount })}
          </div>
        )}
      </div>
      {p.note && <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', lineHeight: 1.45 }}>{p.note}</div>}
    </>
  );
}

type SheetProps = FieldsProps & {
  deliverySummary: string;
  paymentSummary: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

/** The manager's Reviewing → Ready to Pay checkpoint: the two settled
 *  sections read back as ✓ rows, and the one this stage fixes as a form. */
export function PhCommissionSheet(p: SheetProps) {
  const { t } = useT();
  const done = (title: string, sum: string) => (
    <div className="ho-sec ho-sec-met">
      <div className="ho-sec-head">
        <span className="ho-check ok" aria-hidden="true"><Icon name="check" size={11} /></span>
        <span className="ho-sec-title">{title}</span>
        <span className="ho-sec-sum">{sum}</span>
      </div>
    </div>
  );
  return (
    <PhSheet onBackdrop={() => { if (!p.busy) p.onClose(); }} className="ph-ho-sheet" role="dialog" aria-modal="true" aria-labelledby="ph-cs-title">
      <div className="ph-ho-head">
        <div>
          <div id="ph-cs-title" className="ph-ho-title">{t('lifecycleMarkReadyToPay')}</div>
          <div className="ph-ho-sub">{t('phCsSub')}</div>
        </div>
        <button type="button" className="ph-ho-close" onClick={p.onClose} disabled={p.busy}>{t('cancel')}</button>
      </div>
      <div className="ho-body">
        {done(t('poReadyDelivery'), p.deliverySummary)}
        {done(t('hoPayment'), p.paymentSummary)}
        <div className="ho-sec">
          <div className="ho-sec-head">
            <span className="ho-check miss" aria-hidden="true">!</span>
            <span className="ho-sec-title">{t('poReadyCommission')}</span>
          </div>
          <div style={{ display: 'grid', gap: 12, paddingTop: 10 }}>
            <PhCommissionFields {...p} idPrefix="phs" />
          </div>
        </div>
      </div>
      <button
        type="button"
        className="ph-btn dark"
        style={{ width: '100%', marginTop: 14, height: 46 }}
        onClick={p.onConfirm}
        disabled={p.busy}
      >
        {p.busy ? t('hoWorking') : t('phCsConfirm')}
      </button>
    </PhSheet>
  );
}
