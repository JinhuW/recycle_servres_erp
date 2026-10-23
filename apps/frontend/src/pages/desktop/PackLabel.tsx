import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../components/Icon';
import { fmtDate } from '../../lib/format';
import { useT } from '../../lib/i18n';
import type { PrefMap } from '../../lib/preferences';
import type { BoxCounts } from '../../lib/sellOrderPack';
import { useEscapeKey } from '../../lib/useEscapeKey';

// Pack mode's box label: the order, what is in the box and who it is for, so
// the receiver can check the box by it. It goes through the browser's print
// dialog, which every label printer with a driver or AirPrint takes, on the
// desktop and on the iPad alike.

export type LabelSize = PrefMap['pack.labelSize'];

// Inches, width × height as the stock feeds.
export const LABEL_SIZES: Record<LabelSize, readonly [number, number]> = {
  '4x6': [4, 6],
  '4x3': [4, 3],
  '2.25x1.25': [2.25, 1.25],
};

export type LabelContent = {
  orderId: string;
  customer: string;
  // The warehouse whose lots are in the box, when only one's are.
  warehouse: string | null;
  counts: BoxCounts;
};

// Mounted only to print, and then the only thing printed: the app goes out of
// the flow (`body.printing-label`) and the page is the stock's own size, so a
// label printer feeds one label, with no blank one after it. Each mount
// prints once.
export function PackLabel({ content, size, onDone }: { content: LabelContent; size: LabelSize; onDone: () => void }) {
  const { t, locale } = useT();
  const done = useRef(onDone);
  useEffect(() => { done.current = onDone; });
  useEffect(() => {
    document.body.classList.add('printing-label');
    const after = () => done.current();
    window.addEventListener('afterprint', after);
    // A frame for the label to lay out before the dialog takes its picture.
    const frame = requestAnimationFrame(() => window.print());
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('afterprint', after);
      document.body.classList.remove('printing-label');
    };
  }, []);

  const [w, h] = LABEL_SIZES[size];
  const { orderId, customer, warehouse, counts } = content;
  return createPortal(
    <div className="pk-label-sheet">
      <style>{`@page { size: ${w}in ${h}in; margin: 0; }`}</style>
      <div className="pk-label" style={{ width: `${w}in`, height: `${h}in` }}>
        <div className="pk-label-in">
          <div className="pk-label-top">
            <span>{t('pkLabelKind')}{warehouse && ` · ${t('pkLabelFrom', { wh: warehouse })}`}</span>
            <span>{fmtDate(new Date(), locale)}</span>
          </div>
          <div className="pk-label-id mono">{orderId}</div>
          <div className="pk-label-who">
            <div className="pk-label-cap">{t('pkLabelCustomer')}</div>
            <div className="pk-label-name">{customer}</div>
          </div>
          <div className="pk-label-counts">
            <span><b>{counts.products}</b> {t('pkLabelProducts', { n: counts.products })}</span>
            <span><b>{counts.units}</b> {t('pkLabelUnits', { n: counts.units })}</span>
            {/* Only small stock shows this: it drops the top row, which names it. */}
            {warehouse && <span className="pk-label-wh">{t('pkLabelFrom', { wh: warehouse })}</span>}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type MenuProps = {
  auto: boolean;
  size: LabelSize;
  // What the label would say now, for the Print row's hint.
  summary: string;
  disabled: boolean;
  onAuto: (on: boolean) => void;
  onSize: (s: LabelSize) => void;
  onPrint: () => void;
};

// The page head's Label control: print now, print by itself once packed, and
// the stock.
export function PackLabelMenu({ auto, size, summary, disabled, onAuto, onSize, onPrint }: MenuProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    return () => document.removeEventListener('pointerdown', onDoc);
  }, [open]);

  return (
    <div className="so-download pk-label-menu" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="btn pk-label-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <Icon name="printer" size={15} />
        {t('pkLabelMenu')}
        <span className={'pk-label-state' + (auto ? ' on' : '')}>{t(auto ? 'pkLabelAutoOn' : 'pkLabelAutoOff')}</span>
        <Icon name="chevronDown" size={13} />
      </button>
      {open && (
        <LabelPop
          onClose={() => { setOpen(false); trigger.current?.focus(); }}
          {...{ auto, size, summary, disabled, onAuto, onSize }}
          onPrint={() => { setOpen(false); onPrint(); }}
        />
      )}
    </div>
  );
}

// Its own component so its Escape sits above the page's, which leaves Pack mode.
function LabelPop({ auto, size, summary, disabled, onAuto, onSize, onPrint, onClose }: MenuProps & { onClose: () => void }) {
  const { t } = useT();
  useEscapeKey(onClose);
  return (
    <div className="so-download-pop pk-label-pop" role="menu">
      <button type="button" role="menuitem" className="so-download-row" disabled={disabled} onClick={onPrint}>
        <Icon name="printer" size={15} />
        <span>
          <span className="so-download-label">{t('pkLabelPrint')}</span>
          <span className="so-download-hint">{summary}</span>
        </span>
      </button>
      <label className="so-download-row pk-label-auto">
        <input type="checkbox" checked={auto} onChange={e => onAuto(e.target.checked)} />
        <span>
          <span className="so-download-label">{t('pkLabelAuto')}</span>
          <span className="so-download-hint">{t('pkLabelAutoHint')}</span>
        </span>
      </label>
      <div className="so-download-warehouse">
        <span>{t('pkLabelStock')}</span>
        <div className="seg" role="group" aria-label={t('pkLabelStock')}>
          {(Object.keys(LABEL_SIZES) as LabelSize[]).map(s => (
            <button key={s} type="button" className={s === size ? 'active' : ''} aria-pressed={s === size} onClick={() => onSize(s)}>
              {LABEL_SIZES[s].join('×')}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
