import { CommissionPaymentFields } from '../../../components/CommissionPaymentFields';
import { Icon } from '../../../components/Icon';
import { fmtUSD } from '../../../lib/format';
import { useT } from '../../../lib/i18n';
import type { CommissionPayment } from '../../../lib/useCommissionPayment';

// Who the order is for and what they earn from it. The purchaser and rate
// inputs used to sit under "Order details" and the maths in an aside titled
// "Payment detail" — two homes for one fact, and a title that meant
// commission while "Payment" meant the vendor. One tab now.

type Props = {
  ownerId: string; onOwner: (id: string) => void;
  ownerOptions: { id: string; name: string }[];
  commissionPct: string; onCommissionPct: (v: string) => void;
  isPurchaser: boolean;
  orderLocked: boolean;
  isArchived: boolean;
  payment: 'company' | 'self';
  purchaserEarn: number;
  effectiveTotalCost: number;
  revenue: number;
  fees: number;
  otherFeesNote: string;
  effectiveProfit: number;
  commissionRateApplied: number;
  commissionOnProfit: number;
  lineCount: number;
  pricedCount: number;
  firstName: string;
  locale: string;
  /** How the purchaser was paid — live-saved, a manager's at any stage. */
  commissionPayment: CommissionPayment;
  canEditCommissionPayment: boolean;
};

export function CommissionTab(p: Props) {
  const { t } = useT();
  return (
    <div className="oe-tabpad">
      <div className="oe-fields oe-fields-3">
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label" htmlFor="eo-owner">{t('poOnBehalfLabel')}</label>
          {p.isPurchaser ? (
            <div className="input" style={{ background: 'var(--bg-soft)', color: 'var(--fg-muted)' }}>
              {p.ownerOptions.find(o => o.id === p.ownerId)?.name ?? '—'}
            </div>
          ) : (
            <select
              id="eo-owner"
              className="select"
              value={p.ownerId}
              onChange={e => p.onOwner(e.target.value)}
              // A Done PO is a closed book — ownership (commission,
              // "my orders") is part of the record and stays put.
              disabled={p.orderLocked}
              title={p.isArchived ? t('saveBlockedArchived') : p.orderLocked ? t('eoOwnerLockedDone') : undefined}
              style={{ width: '100%' }}
            >
              {p.ownerOptions.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label" htmlFor="eo-rate">{t('commissionRate')}</label>
          <input
            id="eo-rate"
            className="input"
            type="number"
            min={0}
            max={100}
            step="0.1"
            disabled={p.isPurchaser}
            value={p.commissionPct}
            placeholder={p.isPurchaser ? '—' : t('eoSetRate')}
            onChange={e => p.onCommissionPct(e.target.value)}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label className="label">{t('eoPurchaserEarns')}</label>
          <div
            className="mono"
            style={{
              fontSize: 26, fontWeight: 600, lineHeight: 1.1, paddingTop: 2,
              color: p.purchaserEarn >= 0 ? 'var(--pos)' : 'var(--neg)',
            }}
          >
            {fmtUSD(p.purchaserEarn, p.locale)}
          </div>
        </div>
      </div>

      <div className="oe-fields" style={{ marginTop: 16, gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
        {/* Formula — symbolic then numeric, so the breakdown explains the
            number above. The self-pay term only appears when the purchaser
            fronted the cost themselves. */}
        <div style={{
          padding: '10px 12px', alignSelf: 'start',
          background: 'var(--bg-soft)', border: '1px solid var(--border)',
          borderRadius: 6, fontSize: 11.5, lineHeight: 1.55,
        }}>
          <div style={{ color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, fontSize: 10 }}>
            {t('eoFormula')}
          </div>
          <div style={{ marginTop: 4 }}>
            {p.payment === 'self' ? t('eoFormulaSelf') : t('eoFormulaCompany')}
          </div>
          <div className="mono" style={{ marginTop: 4, color: 'var(--fg)' }}>
            {p.payment === 'self' ? `${fmtUSD(p.effectiveTotalCost, p.locale)} + ` : ''}
            ({fmtUSD(p.revenue, p.locale)} − {fmtUSD(p.effectiveTotalCost, p.locale)}) × {(p.commissionRateApplied * 100).toFixed(2)}%
          </div>
          <div className="mono" style={{ marginTop: 2, color: 'var(--fg-subtle)' }}>
            = {p.payment === 'self' ? `${fmtUSD(p.effectiveTotalCost, p.locale)} + ` : ''}{fmtUSD(p.commissionOnProfit, p.locale)} = <span style={{ color: 'var(--fg)', fontWeight: 600 }}>{fmtUSD(p.purchaserEarn, p.locale)}</span>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--fg-subtle)' }}>
            {t('eoWhatEarnsOnPO', { name: p.firstName })}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 8, fontSize: 12.5, alignContent: 'start' }}>
          {p.payment === 'self' && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--fg-subtle)' }}>{t('eoSelfPay')}</span>
              <span className="mono">{fmtUSD(p.effectiveTotalCost, p.locale)}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--fg-subtle)' }}>{t('revenue')}</span>
            <span className="mono">{fmtUSD(p.revenue, p.locale)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--fg-subtle)' }}>{t('eoCost')}</span>
            <span className="mono">{fmtUSD(p.effectiveTotalCost, p.locale)}</span>
          </div>
          {/* Cost above is all-in. Break the fee out beneath it so the number
              is never an unexplained jump — indented, so it reads as part of
              the row above rather than a fourth peer figure. */}
          {p.fees > 0 && (
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              marginTop: -3, paddingLeft: 10, fontSize: 11.5, color: 'var(--fg-subtle)',
            }}>
              <span>{t('otherFees')}{p.otherFeesNote.trim() ? ` · ${p.otherFeesNote.trim()}` : ''}</span>
              <span className="mono">{fmtUSD(p.fees, p.locale)}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--fg-subtle)' }}>{t('eoProfitAllLines', { n: p.lineCount })}</span>
            <span className="mono">{fmtUSD(p.effectiveProfit, p.locale)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--fg-subtle)' }}>{t('eoRate')}</span>
            <span className="mono">{(p.commissionRateApplied * 100).toFixed(2)}%</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--fg-subtle)' }}>{t('eoCommissionOnProfit')}</span>
            <span className="mono">{fmtUSD(p.commissionOnProfit, p.locale)}</span>
          </div>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            paddingTop: 6, borderTop: '1px dashed var(--border)', fontWeight: 600,
          }}>
            <span>{t('eoTotal')}</span>
            <span className="mono">{fmtUSD(p.purchaserEarn, p.locale)}</span>
          </div>
          {p.pricedCount < p.lineCount && (
            <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>
              {t('eoUnpricedLinesHint', { n: p.lineCount - p.pricedCount })}
            </div>
          )}
        </div>
      </div>

      {/* The second payment on the order: what the purchaser was paid, as
          opposed to what the supplier was (the Cost Payment tab). */}
      <div style={{ marginTop: 20 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 11, fontWeight: 600, color: 'var(--fg-subtle)',
          textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4,
        }}>
          <Icon name="paperclip" size={12} /> {t('cpTitle')}
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginBottom: 10 }}>
          {t('cpHint', { name: p.firstName })}
        </div>
        <CommissionPaymentFields cp={p.commissionPayment} editable={p.canEditCommissionPayment} idPrefix="eo-cp" />
      </div>
    </div>
  );
}
