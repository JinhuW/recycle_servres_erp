// The bank paid something other than what the PO says it cost. Shown to the
// manager reviewing it — Review mode and the desktop PO page — and asked about
// once more at the door that approves it for payment. Warns, never blocks: a
// gap can be a fee nobody entered yet, and the manager is the one to judge.

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { RouteLink } from './RouteLink';
import { fmtUSD } from '../lib/format';
import { useT } from '../lib/i18n';
import type { PaymentGap } from '../lib/paymentGap';
import { paymentsForOrderPath } from '../lib/route';
import { useFixedPopover } from '../pages/desktop/popoverPlacement';

function useGapText(): (g: PaymentGap) => { paid: string; total: string; gap: string } {
  const { t, locale } = useT();
  return g => ({
    paid: fmtUSD(g.paid, locale),
    total: fmtUSD(g.total, locale),
    gap: t(g.diff > 0 ? 'payGapMore' : 'payGapLess', { amt: fmtUSD(Math.abs(g.diff), locale) }),
  });
}

export function PaymentMismatchBanner({ orderId, gap, className }: {
  orderId: string;
  gap: PaymentGap;
  className?: string;
}) {
  const { t } = useT();
  const text = useGapText()(gap);
  return (
    <div className={'oe-banner warn' + (className ? ' ' + className : '')} role="status">
      <Icon name="alert" size={13} />
      <span>{t('payGapBanner', text)} ({text.gap})</span>
      <RouteLink to={paymentsForOrderPath(orderId)} className="rec-link" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
        {t('payLedgerOpen')}
      </RouteLink>
    </div>
  );
}

// `confirm` resolves true at once when there is no gap, and otherwise asks;
// false on Cancel or Escape. Cancel holds focus: Review mode is driven by
// label scanners, and each read ends in an Enter.
export function usePaymentMismatchConfirm(): {
  confirm: (orderId: string, gap: PaymentGap | null) => Promise<boolean>;
  asking: boolean;
  dialog: ReactNode;
} {
  const { t } = useT();
  const gapText = useGapText();
  const [pending, setPending] = useState<{ orderId: string; gap: PaymentGap } | null>(null);
  // Held outside state so a second ask settles the first instead of stranding
  // the move awaiting it.
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const answer = (ok: boolean) => {
    const resolve = resolver.current;
    resolver.current = null;
    setPending(null);
    resolve?.(ok);
  };

  const confirm = (orderId: string, gap: PaymentGap | null): Promise<boolean> => {
    if (!gap) return Promise.resolve(true);
    resolver.current?.(false);
    return new Promise<boolean>(resolve => {
      resolver.current = resolve;
      setPending({ orderId, gap });
    });
  };

  const text = pending && gapText(pending.gap);
  const dialog = pending && text && (
    <Modal onClose={() => answer(false)} shellStyle={{ maxWidth: 460 }} ariaLabel={t('payGapConfirmTitle', { id: pending.orderId })}>
      <div className="modal-head">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 8,
            background: 'var(--warn-soft)', color: 'var(--warn-strong)',
            display: 'grid', placeItems: 'center', flexShrink: 0,
          }}>
            <Icon name="alert" size={18} />
          </div>
          <div>
            <div className="modal-title">{t('payGapConfirmTitle', { id: pending.orderId })}</div>
            <div className="modal-sub">{t('payGapConfirmMsg', text)}</div>
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={() => answer(false)} autoFocus>{t('cancel')}</button>
        <button className="btn accent" onClick={() => answer(true)}>{t('payGapContinue')}</button>
      </div>
    </Modal>
  );

  return { confirm, asking: pending !== null, dialog };
}

// The PO list's red `!`: the banner's warning folded to one glyph, with the
// banner's text as a note that opens the moment the pointer or focus lands.
// Not a `title` — the browser shows that late and never on touch or focus,
// and the figures beside the mark are whole dollars, so a cents gap looks
// like no gap until the note says otherwise.
export function PaymentGapMark({ orderId, gap }: { orderId: string; gap: PaymentGap }) {
  const { t } = useT();
  const text = useGapText()(gap);
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  // Leaving the mark for the note crosses a gap of a few pixels; the close
  // waits long enough for that, and a re-enter cancels it.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setOpen(true);
  };
  const hide = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  const label = `${t('payGapBanner', text)} (${text.gap})`;
  return (
    <span
      ref={anchor}
      className="pay-gap-mark"
      role="img"
      tabIndex={0}
      aria-label={label}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      // The row's click toggles its line drawer.
      onClick={e => e.stopPropagation()}
    >
      !
      {open && (
        <PaymentGapNote anchor={anchor} orderId={orderId} label={label} onEnter={show} onLeave={hide} onClose={() => setOpen(false)} />
      )}
    </span>
  );
}

// Mounted only while open: the placement hook re-measures every frame.
function PaymentGapNote({ anchor, orderId, label, onEnter, onLeave, onClose }: {
  anchor: RefObject<HTMLSpanElement | null>;
  orderId: string;
  label: string;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const ref = useRef<HTMLDivElement>(null);
  // Fixed because the list sits in `.table-scroll`, which clips anything that
  // hangs past the table's edge — see popoverPlacement.ts.
  const pos = useFixedPopover(anchor, ref, { align: 'left', gap: 6 }, onClose);
  return (
    <div
      ref={ref}
      role="tooltip"
      className="pay-gap-note"
      style={{
        position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0,
        visibility: pos && !pos.hidden ? 'visible' : 'hidden',
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={e => e.stopPropagation()}
    >
      <Icon name="alert" size={13} style={{ flexShrink: 0 }} />
      <span>{label}</span>
      <RouteLink to={paymentsForOrderPath(orderId)} className="rec-link" style={{ whiteSpace: 'nowrap' }}>
        {t('payLedgerOpen')}
      </RouteLink>
    </div>
  );
}
