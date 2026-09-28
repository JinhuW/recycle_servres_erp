import { useState } from 'react';
import { Icon } from '../components/Icon';
import { PhHeader } from '../components/PhHeader';
import { LineSpecChips } from '../components/LineSpecChips';
import { SerialNumbers } from '../components/SerialNumbers';
import { useT } from '../lib/i18n';
import { showErrorDialog } from '../lib/errorToast';
import { fmtUSD, fmtUSD0 } from '../lib/format';
import type { Category, DraftLine } from '../lib/types';
import { addableCategories, categoryTone } from '../lib/lookups';

// The last step of capturing a NEW purchase order: the product lines, and
// nothing else. Warehouse, payment, notes and fees are the PO page's folds'
// to ask once the order exists — here the purchaser is scanning items, and
// the screen stays out of the way of that.
type Props = {
  lines: DraftLine[];
  /** Called with the kind of line to add — the add row always names one. */
  onAddItem: (cat: Category) => void;
  onEditLine: (idx: number) => void;
  onRemoveLine: (idx: number) => void;
  onSubmit: () => Promise<void>;
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
  lines, onAddItem, onEditLine, onRemoveLine, onSubmit, onCancel,
}: Props) {
  const { t, locale } = useT();
  const [submitting, setSubmitting] = useState(false);
  const totalQty = lines.reduce((a, l) => a + l.qty, 0);

  const submit = async () => {
    setSubmitting(true);
    try {
      await onSubmit();
    } finally {
      setSubmitting(false);
    }
  };

  // What Submit is waiting on. The button stays live while these exist:
  // clicking it opens a dialog with the list, rather than sitting dead behind
  // a hint the user has to hunt for.
  const submitBlockers: string[] =
    submitting         ? []
  : lines.length === 0 ? [t('reviewNoLinesHint')]
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
      <div className="ph-scroll" style={{ paddingBottom: 230 }}>
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

      </div>

      {/* The add row is docked, not in flow: the list it appends to grows
          every time it is used, so in flow it only ever got further away —
          and it is the whole point of the screen. Same bar as the PO
          products screen's dock. */}
      <div className="ph-action-bar stacked">
        <div>
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '0.09em',
            textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 8,
          }}>
            {t('addToThisOrder')}
          </div>
          <CategoryGrid onPick={onAddItem} />
        </div>
        <div className="ph-action-row">
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
      </div>
    </div>
  );
}
