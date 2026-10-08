// The bank paid something other than what the PO says it cost. Shown to the
// manager reviewing it — Review mode and the desktop PO page — and asked about
// once more at the door that approves it for payment. Warns, never blocks: a
// gap can be a fee nobody entered yet, and the manager is the one to judge.

import { useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { RouteLink } from './RouteLink';
import { fmtUSD } from '../lib/format';
import { useT } from '../lib/i18n';
import type { PaymentGap } from '../lib/paymentGap';
import { paymentsForOrderPath } from '../lib/route';

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
