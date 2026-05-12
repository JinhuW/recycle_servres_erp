import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { useT } from '../lib/i18n';
import { api } from '../lib/api';
import { fmtUSD, fmtUSD0 } from '../lib/format';
import type { Category, DraftLine, Warehouse } from '../lib/types';

type Props = {
  category: Category;
  lines: DraftLine[];
  editingId?: string | null;
  onAddItem: () => void;
  onEditLine: (idx: number) => void;
  onRemoveLine: (idx: number) => void;
  onSubmit: (payload: { warehouseId: string; payment: 'company' | 'self'; notes: string; totalCost: number }) => Promise<void>;
  onCancel: () => void;
};

export function OrderReview({
  category, lines, editingId,
  onAddItem, onEditLine, onRemoveLine,
  onSubmit, onCancel,
}: Props) {
  const { t } = useT();

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [payment, setPayment] = useState<'company' | 'self'>('company');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get<{ items: Warehouse[] }>('/api/warehouses').then(r => {
      setWarehouses(r.items);
      if (r.items[0]) setWarehouseId(r.items[0].id);
    });
  }, []);

  const computedCost = lines.reduce((a, l) => a + l.qty * l.unitCost, 0);
  const totalQty = lines.reduce((a, l) => a + l.qty, 0);
  const [totalCost, setTotalCost] = useState(computedCost.toFixed(2));
  useEffect(() => { setTotalCost(computedCost.toFixed(2)); }, [computedCost]);

  const submit = async () => {
    setSubmitting(true);
    try {
      await onSubmit({ warehouseId, payment, notes, totalCost: parseFloat(totalCost) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="phone-app">
      <PhHeader
        title={editingId ? t('editOrderId', { id: editingId }) : t('reviewOrder')}
        sub={t('itemCount', { n: lines.length, label: lines.length === 1 ? t('item') : t('items'), q: totalQty })}
        leading={<button className="ph-icon-btn" onClick={onCancel}><Icon name="chevronLeft" size={16} /></button>}
      />
      <div className="ph-scroll" style={{ paddingBottom: 110 }}>
        <div className="ph-section-h" style={{ paddingTop: 10 }}>
          <span>{t('lineItems', { cat: category })}</span>
          <span className="more" onClick={onAddItem} style={{ cursor: 'pointer' }}>{t('addAnother')}</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {lines.map((l, i) => (
            <div
              key={i}
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
                <span>Qty {l.qty} · unit {fmtUSD(l.unitCost)}</span>
                <span className="mono" style={{ fontWeight: 600 }}>{fmtUSD0(l.unitCost * l.qty)}</span>
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={onAddItem}
          style={{
            width: '100%', marginTop: 10, padding: 12,
            background: 'transparent',
            border: '1.5px dashed var(--border-strong)',
            borderRadius: 12, color: 'var(--fg-muted)',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 500,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}
        >
          <Icon name="plus" size={14} /> {t('addAnotherCat', { cat: category })}
        </button>

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
          const edited = parseFloat(totalCost) !== computedCost;
          return (
            <div className="ph-card" style={{ marginTop: 16, background: 'var(--accent-soft)', borderColor: 'color-mix(in oklch, var(--accent) 30%, transparent)', overflow: 'hidden' }}>
              <div style={{ padding: '14px 14px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--accent-strong)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    {t('totalCost')}
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
                    onChange={e => setTotalCost(e.target.value)}
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
                  <span className="mono" style={{ opacity: 0.85, fontVariantNumeric: 'tabular-nums' }}>{fmtUSD(computedCost)}</span>
                </div>
                {edited && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, fontSize: 11.5, color: 'var(--accent-strong)' }}>
                    <span style={{ opacity: 0.75 }}>{t('adjustment')}</span>
                    <span className="mono" style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      {(parseFloat(totalCost) - computedCost) >= 0 ? '+' : '−'}{fmtUSD(Math.abs(parseFloat(totalCost) - computedCost))}
                    </span>
                  </div>
                )}
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

      <div className="ph-action-bar">
        <button className="ph-btn ghost" onClick={onCancel}>{t('cancel')}</button>
        <button className="ph-btn dark" onClick={submit} disabled={submitting || lines.length === 0 || !warehouseId}>
          <Icon name="check" size={16} /> {submitting ? '…' : t('submitOrder')}
        </button>
      </div>
    </div>
  );
}
