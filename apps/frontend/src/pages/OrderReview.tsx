import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { LineSpecChips } from '../components/LineSpecChips';
import { SerialNumbers } from '../components/SerialNumbers';
import { useT } from '../lib/i18n';
import { api } from '../lib/api';
import { handleFetchError, showErrorToast } from '../lib/errorToast';
import { fmtUSD, fmtUSD0 } from '../lib/format';
import { parseFeeInput, splitGoodsOverflow, GOODS_EPSILON } from '../lib/poTotals';
import type { Category, DraftLine, Warehouse } from '../lib/types';
import { addableCategories } from '../lib/lookups';

// Matches the chip tones used for categories elsewhere in the app.
const CAT_TINT: Record<string, string> = {
  RAM: 'var(--info)',
  SSD: 'var(--pos)',
  HDD: 'var(--cool, oklch(0.58 0.13 305))',
  Other: 'var(--warn)',
};

/** Strip thousands-separator commas, then parse — handles "1,234.56" correctly. */
const parseDecimal = (s: string) => {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

type Props = {
  lines: DraftLine[];
  editingId?: string | null;
  /** Called with the kind of line to add — the add row always names one. */
  onAddItem: (cat: Category) => void;
  onEditLine: (idx: number) => void;
  onRemoveLine: (idx: number) => void;
  onSubmit: (payload: {
    warehouseId: string; payment: 'company' | 'self'; notes: string;
    totalCost: number; otherFees: number; otherFeesNote: string | null;
  }) => Promise<void>;
  onCancel: () => void;
};

export function OrderReview({
  lines, editingId,
  onAddItem, onEditLine, onRemoveLine,
  onSubmit, onCancel,
}: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [payment, setPayment] = useState<'company' | 'self'>('company');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get<{ items: Warehouse[] }>('/api/warehouses')
      .then(r => {
        if (!alive) return;
        setWarehouses(r.items);
        if (r.items[0]) setWarehouseId(r.items[0].id);
      })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, []);

  const computedCost = lines.reduce((a, l) => a + l.qty * l.unitCost, 0);
  const totalQty = lines.reduce((a, l) => a + l.qty, 0);
  const [totalCost, setTotalCost] = useState(computedCost.toFixed(2));
  useEffect(() => { setTotalCost(computedCost.toFixed(2)); }, [computedCost]);
  const [otherFees, setOtherFees] = useState('');
  const [otherFeesNote, setOtherFeesNote] = useState('');
  const feesValue = parseFeeInput(otherFees);

  // A purchaser types the one number off the supplier's invoice. Anything above
  // the line sum is a fee, so on blur it moves there and the goods total returns
  // to the line sum — the all-in total is untouched, the money is just
  // classified. On blur rather than on change: the first keystroke of
  // "11610.30" is "1", which would read as a huge negative gap.
  const [movedToFees, setMovedToFees] = useState<number | null>(null);
  const applyGoodsOverflow = () => {
    const { goods, overflow } = splitGoodsOverflow(parseDecimal(totalCost), computedCost);
    if (overflow <= 0) return;
    setTotalCost(goods.toFixed(2));
    setOtherFees((feesValue + overflow).toFixed(2));
    setMovedToFees(overflow);
  };

  const submit = async () => {
    const parsed = parseDecimal(totalCost);
    if (Number.isNaN(parsed)) {
      showErrorToast(t('totalCostInvalid'));
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({
        warehouseId, payment, notes, totalCost: parsed,
        otherFees: feesValue,
        otherFeesNote: otherFeesNote.trim() || null,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const submitDisabledReason: string | null =
    submitting             ? null
  : lines.length === 0     ? t('reviewNoLinesHint')
  : warehouses.length === 0 ? t('reviewWarehousesLoadingHint')
  : !warehouseId           ? t('reviewPickWarehouseHint')
  : null;

  return (
    <div className="phone-app">
      <PhHeader
        title={editingId ? t('editOrderId', { id: editingId }) : t('reviewOrder')}
        sub={t('itemCount', { n: lines.length, label: lines.length === 1 ? t('item') : t('items'), q: totalQty })}
        leading={<button className="ph-icon-btn" onClick={onCancel}><Icon name="chevronLeft" size={16} /></button>}
      />
      <div className="ph-scroll" style={{ paddingBottom: 110 }}>
        <div className="ph-section-h" style={{ paddingTop: 10 }}>
          <span>{t('products')}</span>
        </div>

        {/* A new PO now opens here rather than in a form, so the empty list has
            to say what to do rather than look broken. */}
        {lines.length === 0 && (
          <div style={{ textAlign: 'center', padding: '26px 12px 6px' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{t('reviewEmptyTitle')}</div>
            <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', marginTop: 4 }}>
              {t('reviewEmptySub')}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {lines.map((l, i) => (
            <div
              key={l.id ?? l._cid ?? i}
              className="ph-line"
              onClick={() => onEditLine(i)}
              style={{ cursor: 'pointer' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="lb-rank" style={{ width: 22, height: 22, fontSize: 11 }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.label || '—'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontFamily: 'JetBrains Mono, monospace', marginTop: 2 }}>{l.partNumber || '—'}</div>
                  <LineSpecChips line={l} />
                  {l.serialNumber && (
                    <div style={{ marginTop: 4 }}>
                      <SerialNumbers raw={l.serialNumber} max={3} size={10} />
                    </div>
                  )}
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); onEditLine(i); }}
                  className="ph-icon-btn"
                  style={{ width: 28, height: 28, color: 'var(--fg-subtle)' }}
                  aria-label={t('edit')}
                >
                  <Icon name="edit" size={13} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onRemoveLine(i); }}
                  className="ph-icon-btn"
                  style={{ width: 28, height: 28, color: 'var(--fg-subtle)' }}
                  aria-label={t('delete')}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11.5, color: 'var(--fg-subtle)' }}>
                <span>Qty <span style={{ color: 'var(--accent-strong)', fontWeight: 700, background: 'var(--accent-soft)', padding: '0 6px', borderRadius: 6, fontVariantNumeric: 'tabular-nums' }}>{l.qty}</span> · unit {fmtUSD(l.unitCost, locale)}</span>
                <span className="mono" style={{ fontWeight: 600 }}>{fmtUSD0(l.unitCost * l.qty, locale)}</span>
              </div>
            </div>
          ))}
        </div>

        {/* One target per category. A single "Add another RAM" button would put
            the old category lock back in the user's head — the PO is not in a
            mode, and every kind has to look equally available. */}
        <div style={{ marginTop: 14 }}>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '0.09em',
            textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 8,
          }}>
            {t('addToThisOrder')}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 7 }}>
            {addableCategories().map(cat => (
              <button
                key={cat}
                onClick={() => onAddItem(cat as Category)}
                aria-label={t('subAddCatLine', { cat })}
                style={{
                  minHeight: 54, borderRadius: 13,
                  border: '1.5px dashed ' + (CAT_TINT[cat] ?? 'var(--border-strong)'),
                  background: 'var(--bg-elev)', color: CAT_TINT[cat] ?? 'var(--fg-muted)',
                  fontFamily: 'inherit', fontSize: 12.5, fontWeight: 650,
                  display: 'grid', placeItems: 'center', alignContent: 'center', gap: 1,
                  padding: '6px 2px', cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: 15, lineHeight: 1, opacity: 0.75 }}>+</span>
                <span>{cat}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="ph-section-h"><span>{t('orderDetails')}</span></div>
        <div className="ph-field" style={{ marginTop: 0 }}>
          <label>{t('warehouse')}</label>
          <div style={{ position: 'relative' }}>
            <select
              value={warehouseId}
              onChange={e => setWarehouseId(e.target.value)}
              style={{
                width: '100%',
                appearance: 'none',
                WebkitAppearance: 'none',
                MozAppearance: 'none',
                border: '1px solid var(--border)',
                background: 'var(--bg-elev)',
                color: 'var(--fg)',
                padding: '11px 36px 11px 12px',
                borderRadius: 10,
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.short} — {w.region}</option>)}
            </select>
            <div style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--fg-subtle)', display: 'flex' }}>
              <Icon name="chevronDown" size={14} />
            </div>
          </div>
        </div>

        <div className="ph-field">
          <label>{t('payment')}</label>
          <div className="seg" style={{ width: '100%', display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
            <button className={payment === 'company' ? 'active' : ''} onClick={() => setPayment('company')}>{t('payCompany')}</button>
            <button className={payment === 'self'    ? 'active' : ''} onClick={() => setPayment('self')}>{t('paySelf')}</button>
          </div>
        </div>

        <div className="ph-field">
          <label>{t('orderNotes')}</label>
          <textarea
            className="input"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder={t('orderNotesPh')}
            rows={3}
            style={{ width: '100%', resize: 'vertical', minHeight: 70, fontFamily: 'inherit', fontSize: 13, lineHeight: 1.45, padding: '10px 12px' }}
          />
        </div>

        {(() => {
          // One shared threshold for "differs from the line sum" — this used to
          // be an exact compare here and > 0.01 on desktop.
          const edited = Math.abs(parseDecimal(totalCost) - computedCost) > GOODS_EPSILON;
          return (
            <div className="ph-card" style={{ marginTop: 16, background: 'var(--accent-soft)', borderColor: 'color-mix(in oklch, var(--accent) 30%, transparent)', overflow: 'hidden' }}>
              <div style={{ padding: '14px 14px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--accent-strong)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    {t('goodsTotal')}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--accent-strong)', opacity: 0.75, fontVariantNumeric: 'tabular-nums' }}>
                    {totalQty} {totalQty === 1 ? t('unit') : t('units2')} · {lines.length} {lines.length === 1 ? t('item') : t('items')}
                  </div>
                </div>

                <div style={{
                  display: 'flex', alignItems: 'baseline', gap: 4, marginTop: 14,
                  borderBottom: '1.5px solid color-mix(in oklch, var(--accent) 35%, transparent)',
                  paddingBottom: 10,
                }}>
                  <span style={{ fontSize: 22, fontWeight: 600, color: 'var(--accent-strong)', opacity: 0.7 }}>$</span>
                  <input
                    className="mono"
                    value={totalCost}
                    onChange={e => { setTotalCost(e.target.value); setMovedToFees(null); }}
                    onBlur={applyGoodsOverflow}
                    onKeyDown={e => { if (e.key === 'Enter') applyGoodsOverflow(); }}
                    inputMode="decimal"
                    style={{
                      flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent',
                      fontSize: 32, fontWeight: 700, color: 'var(--accent-strong)',
                      fontFamily: 'JetBrains Mono, monospace', letterSpacing: '-0.01em',
                      padding: 0, lineHeight: 1.1,
                    }}
                  />
                  {edited && (
                    <button
                      onClick={() => setTotalCost(computedCost.toFixed(2))}
                      style={{
                        background: 'white', border: '1px solid color-mix(in oklch, var(--accent) 35%, transparent)',
                        color: 'var(--accent-strong)', fontSize: 11, fontWeight: 600,
                        cursor: 'pointer', padding: '5px 10px', borderRadius: 999,
                        display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
                      }}
                    >
                      <Icon name="rotate" size={10} /> {t('reset')}
                    </button>
                  )}
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, fontSize: 11.5, color: 'var(--accent-strong)' }}>
                  <span style={{ opacity: 0.75 }}>{t('calculated')}</span>
                  <span className="mono" style={{ opacity: 0.85, fontVariantNumeric: 'tabular-nums' }}>{fmtUSD(computedCost, locale)}</span>
                </div>
                {edited && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, fontSize: 11.5, color: 'var(--accent-strong)' }}>
                    <span style={{ opacity: 0.75 }}>{t('adjustment')}</span>
                    <span className="mono" style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      {(parseDecimal(totalCost) - computedCost) >= 0 ? '+' : '−'}{fmtUSD(Math.abs(parseDecimal(totalCost) - computedCost), locale)}
                    </span>
                  </div>
                )}

                {/* The hero number just changed under them — say why. */}
                {movedToFees != null && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, fontSize: 11.5, color: 'var(--accent-strong)' }}>
                    <span style={{ opacity: 0.75 }}>↓ {t('otherFees')}</span>
                    <span className="mono" style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      +{fmtUSD(movedToFees, locale)}
                    </span>
                  </div>
                )}

                {/* Fees are money the supplier charged on top of the goods, so
                    they sit below the goods hero and roll into a separate
                    total rather than editing the number above. */}
                <div style={{
                  marginTop: 12, paddingTop: 12,
                  borderTop: '1px solid color-mix(in oklch, var(--accent) 22%, transparent)',
                }}>
                  <div className="ph-field-row" style={{ gridTemplateColumns: '110px 1fr', marginTop: 0 }}>
                    <div className="ph-field" style={{ marginTop: 0 }}>
                      <label style={{ color: 'var(--accent-strong)', opacity: 0.85 }}>{t('otherFees')}</label>
                      <input
                        className="input mono"
                        type="number"
                        min={0}
                        step="0.01"
                        inputMode="decimal"
                        value={otherFees}
                        placeholder="0.00"
                        onChange={e => { setOtherFees(e.target.value); setMovedToFees(null); }}
                      />
                    </div>
                    <div className="ph-field" style={{ marginTop: 0 }}>
                      <label style={{ color: 'var(--accent-strong)', opacity: 0.85 }}>{t('otherFeesNote')}</label>
                      <input
                        className="input"
                        maxLength={280}
                        value={otherFeesNote}
                        placeholder={t('otherFeesPh')}
                        onChange={e => setOtherFeesNote(e.target.value)}
                      />
                    </div>
                  </div>
                  {feesValue > 0 && (
                    <div style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      marginTop: 12, paddingTop: 8,
                      borderTop: '1px dashed color-mix(in oklch, var(--accent) 30%, transparent)',
                      fontSize: 12.5, fontWeight: 700, color: 'var(--accent-strong)',
                    }}>
                      <span>{t('totalCost')}</span>
                      <span className="mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {fmtUSD(parseDecimal(totalCost) + feesValue, locale)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <div style={{
                padding: '10px 14px',
                background: 'color-mix(in oklch, var(--accent) 8%, white)',
                borderTop: '1px solid color-mix(in oklch, var(--accent) 18%, transparent)',
                fontSize: 11, color: 'var(--accent-strong)', opacity: 0.85,
                display: 'flex', alignItems: 'flex-start', gap: 8,
              }}>
                <Icon name="info" size={12} style={{ marginTop: 1, flexShrink: 0 }} />
                <span>{t('adjustHint')}</span>
              </div>
            </div>
          );
        })()}
      </div>

      {submitDisabledReason && (
        <div
          role="status"
          style={{
            position: 'absolute', left: 16, right: 16, bottom: 76,
            padding: '8px 12px', borderRadius: 10,
            background: 'var(--bg-elev)', border: '1px solid var(--border)',
            color: 'var(--fg-subtle)', fontSize: 12, textAlign: 'center',
            boxShadow: '0 2px 8px rgba(15,23,42,0.06)', zIndex: 5,
          }}
        >
          {submitDisabledReason}
        </div>
      )}
      <div className="ph-action-bar">
        <button className="ph-btn ghost" onClick={onCancel}>{t('cancel')}</button>
        <button
          className="ph-btn dark"
          onClick={submit}
          disabled={submitting || lines.length === 0 || !warehouseId}
          title={submitDisabledReason ?? undefined}
        >
          <Icon name="check" size={16} /> {submitting ? '…' : t('submitOrder')}
        </button>
      </div>
    </div>
  );
}
