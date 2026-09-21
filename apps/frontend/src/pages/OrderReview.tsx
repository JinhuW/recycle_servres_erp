import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { PaymentFields } from '../components/PaymentFields';
import { PhFold } from '../components/PhFold';
import type { HandoffMethod } from '../lib/handoff';
import { PhHeader } from '../components/PhHeader';
import { LineSpecChips } from '../components/LineSpecChips';
import { SerialNumbers } from '../components/SerialNumbers';
import { useT } from '../lib/i18n';
import { handleFetchError, showErrorDialog } from '../lib/errorToast';
import { fmtUSD, fmtUSD0 } from '../lib/format';
import { parseFeeInput, poEffectiveCost } from '../lib/poTotals';
import type { Category, DraftLine, Warehouse } from '../lib/types';
import { addableCategories, categoryTone } from '../lib/lookups';
import { loadWarehouses } from '../lib/warehouses';

// The last step of capturing a NEW purchase order. An order that already
// exists is edited on its detail screen — this one asks for a warehouse, a
// payment type and notes, which is only a fair question before those are set.
type Props = {
  lines: DraftLine[];
  /** A resumed draft's saved meta. Null for an order being started here. */
  initialMeta?: {
    warehouseId: string; payment: 'company' | 'self'; paymentMethod: HandoffMethod | null; notes: string;
  } | null;
  /** Called with the kind of line to add — the add row always names one. */
  onAddItem: (cat: Category) => void;
  // A draft reopened from the camera button asks which kind of item is going
  // in before showing anything else: the user pressed a camera, not a list.
  askCategory?: boolean;
  onDismissCategory: () => void;
  // Fees live in the session, not this component: it unmounts every time the
  // user steps into a line form, and an existing order opens carrying the fee
  // it was saved with — which a blank field would silently zero on save.
  fees: { amount: string; note: string };
  onFeesChange: (fees: { amount: string; note: string }) => void;
  onEditLine: (idx: number) => void;
  onRemoveLine: (idx: number) => void;
  onSubmit: (payload: {
    warehouseId: string; payment: 'company' | 'self'; paymentMethod: HandoffMethod | null; notes: string;
    otherFees: number; otherFeesNote: string | null;
  }) => Promise<void>;
  onCancel: () => void;
};

// One target per category. A single "Add another RAM" button would put the
// old category lock back in the user's head — the PO is not in a mode, and
// every kind has to look equally available.
function CategoryGrid({ onPick }: { onPick: (cat: Category) => void }) {
  const { t } = useT();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 7 }}>
      {addableCategories().map(cat => (
        <button
          key={cat}
          onClick={() => onPick(cat as Category)}
          aria-label={t('subAddCatLine', { cat })}
          style={{
            minHeight: 54, borderRadius: 13,
            // The dash is a fill and may stay `tone`; the label is read,
            // so it takes the tone that clears contrast against the card.
            border: '1.5px dashed ' + categoryTone(cat).tone,
            background: 'var(--bg-elev)', color: categoryTone(cat).strong,
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
  );
}

export function OrderReview({
  lines, initialMeta,
  onAddItem, askCategory, onDismissCategory, onEditLine, onRemoveLine,
  fees, onFeesChange,
  onSubmit, onCancel,
}: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState(initialMeta?.warehouseId ?? '');
  const [payment, setPayment] = useState<'company' | 'self'>(initialMeta?.payment ?? 'company');
  const [paymentMethod, setPaymentMethod] = useState<HandoffMethod | null>(initialMeta?.paymentMethod ?? null);
  const [notes, setNotes] = useState(initialMeta?.notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  // The same folds as the PO page. Delivery and Payment start open — they are
  // what this step exists to ask — and Notes closed; each toggles on its own.
  const [open, setOpen] = useState({ delivery: true, payment: true, notes: false });
  const toggle = (k: keyof typeof open) => setOpen(o => ({ ...o, [k]: !o[k] }));

  useEffect(() => {
    let alive = true;
    loadWarehouses()
      .then(items => {
        if (!alive) return;
        setWarehouses(items);
        // Only default a draft that has never named one. A resumed draft
        // arrives with its own, and the first warehouse in the list is not it.
        setWarehouseId(prev => prev || items[0]?.id || '');
      })
      .catch(handleFetchError);
    return () => { alive = false; };
  }, []);

  // Goods is the line sum and nothing else — the only editable money on this
  // screen is what the supplier charged on top of it. The purchaser reads the
  // hero against what they actually paid, so it states goods + fees.
  const computedCost = lines.reduce((a, l) => a + l.qty * l.unitCost, 0);
  const totalQty = lines.reduce((a, l) => a + l.qty, 0);
  const feesValue = parseFeeInput(fees.amount);
  const allIn = poEffectiveCost({ lineSubtotal: computedCost, otherFees: feesValue }).total;
  const wh = warehouses.find(w => w.id === warehouseId);
  const warehouseLabel = wh ? `${wh.short} — ${wh.region}` : t('reviewPickWarehouseHint');
  const paymentSummary = payment === 'self'
    ? t('paySelfShort')
    : [t('payCompanyShort'), paymentMethod === 'cash' ? t('hoMethodCash') : paymentMethod === 'paypal' ? t('hoMethodPaypal') : null]
        .filter(Boolean).join(' · ');

  const submit = async () => {
    setSubmitting(true);
    try {
      await onSubmit({
        warehouseId, payment, paymentMethod, notes,
        otherFees: feesValue,
        otherFeesNote: fees.note.trim() || null,
      });
    } finally {
      setSubmitting(false);
    }
  };

  // What Submit is waiting on. The button stays live while these exist:
  // clicking it opens a dialog with the list, rather than sitting dead behind
  // a hint the user has to hunt for.
  const submitBlockers: string[] =
    submitting              ? []
  : lines.length === 0      ? [t('reviewNoLinesHint')]
  : warehouses.length === 0 ? [t('reviewWarehousesLoadingHint')]
  : !warehouseId            ? [t('reviewPickWarehouseHint')]
  : [];

  const onSubmitClick = () => {
    if (submitBlockers.length) {
      showErrorDialog(t('errCantSubmitMsg'), submitBlockers, t('errCantSubmitTitle'));
      return;
    }
    void submit();
  };

  return (
    <div className="phone-app">
      <PhHeader
        title={t('reviewOrder')}
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
                  {l.partNumber && (
                    <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontFamily: 'JetBrains Mono, monospace', marginTop: 2 }}>{l.partNumber}</div>
                  )}
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
                <span>{t('qty')} <span style={{ color: 'var(--accent-strong)', fontWeight: 700, background: 'var(--accent-soft)', padding: '0 6px', borderRadius: 6, fontVariantNumeric: 'tabular-nums' }}>{l.qty}</span> · {t('perUnit')} {fmtUSD(l.unitCost, locale)}</span>
                <span className="mono" style={{ fontWeight: 600 }}>{fmtUSD0(l.unitCost * l.qty, locale)}</span>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '0.09em',
            textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 8,
          }}>
            {t('addToThisOrder')}
          </div>
          <CategoryGrid onPick={onAddItem} />
        </div>

        {/* The card adds up downward: goods (the line sum), then whatever the
            supplier charged on top, then the total they make. The only money
            typed here is the fee — the total is stated, never entered. Same
            card as the PO page's, so the number looks the same before and
            after the order exists. */}
        <div className="ph-card" style={{ marginTop: 16, padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {t('costBreakdown')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontVariantNumeric: 'tabular-nums' }}>
              {totalQty} {totalQty === 1 ? t('unit') : t('units2')} · {lines.length} {lines.length === 1 ? t('item') : t('items')}
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginTop: 10 }}>
            <span style={{ color: 'var(--fg-subtle)' }}>{t('goodsTotal')}</span>
            <span className="mono">{fmtUSD(computedCost, locale)}</span>
          </div>

          <div className="ph-field-row" style={{ gridTemplateColumns: '110px 1fr', marginTop: 8 }}>
            <div className="ph-field" style={{ marginTop: 0 }}>
              <label>{t('otherFees')}</label>
              <input
                className="input mono"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={fees.amount}
                placeholder="0.00"
                onChange={e => onFeesChange({ ...fees, amount: e.target.value })}
              />
            </div>
            <div className="ph-field" style={{ marginTop: 0 }}>
              <label>{t('otherFeesNote')}</label>
              <input
                className="input"
                maxLength={280}
                value={fees.note}
                placeholder={t('otherFeesPh')}
                onChange={e => onFeesChange({ ...fees, note: e.target.value })}
              />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
            <span>{t('totalCost')}</span>
            <span className="mono" style={{ fontWeight: 600 }}>{fmtUSD(allIn, locale)}</span>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--fg-subtle)', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <Icon name="info" size={12} style={{ marginTop: 1, flexShrink: 0 }} />
            <span>{t('feesHint')}</span>
          </div>
        </div>

        <div className="ph-section-h"><span>{t('orderDetails')}</span></div>

        {/* The PO page's folds, the ones a new order can answer: where it is
            going, who paid, and a note. Source, tracking and files come with
            the hand-off, once the order exists. */}
        <PhFold
          id="delivery"
          title={t('eoTabDelivery')}
          summary={<span className={warehouseId ? '' : 'miss'}>{warehouseLabel}</span>}
          open={open.delivery}
          onToggle={() => toggle('delivery')}
          mark={warehouseId ? null : 'need'}
        >
          <div className="ph-field">
            <label htmlFor="rv-warehouse">{t('warehouse')}</label>
            <select
              id="rv-warehouse"
              className="select"
              value={warehouseId}
              onChange={e => setWarehouseId(e.target.value)}
            >
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.short} — {w.region}</option>)}
            </select>
          </div>
        </PhFold>

        <PhFold
          id="payment"
          title={t('eoTabPayment')}
          summary={paymentSummary}
          open={open.payment}
          onToggle={() => toggle('payment')}
          bodyClassName="ph-pay"
        >
          <PaymentFields
            paidBy={payment} onPaidBy={setPayment}
            method={paymentMethod} onMethod={setPaymentMethod}
            txnId="" onTxnId={() => {}}
            phone
            idPrefix="rv"
          />
        </PhFold>

        <PhFold
          id="notes"
          title={t('orderNotes')}
          summary={notes.trim() ? notes.trim().split('\n')[0] : t('phNoNotes')}
          open={open.notes}
          onToggle={() => toggle('notes')}
        >
          <div className="ph-field">
            <label htmlFor="rv-notes">{t('orderNotes')}</label>
            <textarea
              id="rv-notes"
              className="input"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder={t('orderNotesPh')}
              rows={3}
              style={{ width: '100%', resize: 'vertical', minHeight: 70, fontFamily: 'inherit', fontSize: 13, lineHeight: 1.45, padding: '10px 12px' }}
            />
          </div>
        </PhFold>
      </div>

      <div className="ph-action-bar">
        <button className="ph-btn ghost" onClick={onCancel}>{t('cancel')}</button>
        <button
          className="ph-btn dark"
          onClick={onSubmitClick}
          disabled={submitting}
          title={submitBlockers[0]}
        >
          <Icon name="check" size={16} /> {submitting ? '…' : t('submitOrder')}
        </button>
      </div>

      {askCategory && (
        <>
          <div className="ph-sheet-backdrop" onClick={onDismissCategory} />
          <div className="ph-sheet">
            <div className="ph-sheet-grabber" />
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, padding: '0 4px 4px' }}>
              {t('addToThisOrder')}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', padding: '0 4px 12px' }}>
              {t('pickCategoryHint')}
            </div>
            <CategoryGrid onPick={onAddItem} />
          </div>
        </>
      )}
    </div>
  );
}
