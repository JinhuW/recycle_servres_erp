import { useEffect, useState } from 'react';
import { api } from '../../../lib/api';
import { fmtUSD, fmtDateShort } from '../../../lib/format';
import { useT } from '../../../lib/i18n';
import { paymentsForOrderPath, paymentsForSellOrderPath } from '../../../lib/route';
import { RouteLink } from '../../../components/RouteLink';

// Which of a bank row's three link targets this ledger reads: a PO's cost
// (what the supplier was paid), a PO's commission (what the purchaser was),
// or a sell order (what the buyer sent).
export type LedgerScope =
  | { orderId: string; kind: 'cost' | 'commission' }
  | { sellOrderId: string };

type LinkKind = 'payment' | 'refund' | 'commission' | null;

// Read-only ledger of bank transactions linked to an order on the Payments
// page. Renders nothing until a payment is linked, so most orders pay no cost.
// Manager-only by its API (everyone else 403s), so the host gates it.
export function PoPaymentsLedger({ scope, locale, className }: {
  scope: LedgerScope; locale: string; className?: string;
}) {
  const { t } = useT();
  const [ledger, setLedger] = useState<{
    payments: {
      id: string; source: string; postedAt: string; amount: number;
      counterparty: string | null; linkKind: LinkKind; linkAuto: boolean;
      // Added in v1.127.0; optional because the SPA and the API deploy on
      // independent pipelines. Absent means settled — nothing else used to be
      // ingested at all.
      settleStatus?: 'settled' | 'pending' | 'failed' | 'reversed';
    }[];
    net: number;
  } | null>(null);

  const url = 'sellOrderId' in scope
    ? `/api/bank-transactions/by-sell-order/${encodeURIComponent(scope.sellOrderId)}`
    : `/api/bank-transactions/by-order/${encodeURIComponent(scope.orderId)}`
      + (scope.kind === 'commission' ? '?kind=commission' : '');
  const openPath = (txnId?: string) => 'sellOrderId' in scope
    ? paymentsForSellOrderPath(scope.sellOrderId, txnId)
    : paymentsForOrderPath(scope.orderId, txnId);
  // A sell order's money comes in, so its net reads as received.
  const netKey = 'sellOrderId' in scope ? 'payLedgerNetReceived' : 'payLedgerNet';

  useEffect(() => {
    let alive = true;
    api.get<NonNullable<typeof ledger>>(url)
      .then(r => { if (alive) setLedger(r); })
      // Silent: the ledger is a side panel, not the page — a fetch hiccup
      // must not throw a dialog over an otherwise working order edit.
      .catch(() => {});
    return () => { alive = false; };
  }, [url]);

  if (!ledger || ledger.payments.length === 0) return null;
  return (
    <div className={className ?? 'oe-ledger'}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{t('payLedgerTitle')}</div>
        <RouteLink to={openPath()} className="btn sm ghost" style={{ marginLeft: 'auto' }}>
          {t('payLedgerOpen')}
        </RouteLink>
      </div>
      <div style={{ marginTop: 10, display: 'grid', gap: 6, fontSize: 12.5 }}>
        {ledger.payments.map(p => (
          <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span className={'chip dot ' + (p.linkKind === 'refund' ? 'cool' : 'pos')} style={{ fontSize: 10.5 }}>
              {t(p.linkKind === 'refund' ? 'payKindRefund'
                : p.linkKind === 'commission' ? 'payKindCommission' : 'payKindPayment')}
            </span>
            {/* Without this the order reads as paid by money that is still in
                flight, or that came back — the net below already excludes the
                second kind, and the chip is what explains the difference. */}
            {p.settleStatus && p.settleStatus !== 'settled' && (
              <span
                className={'chip dot ' + (p.settleStatus === 'pending' ? 'warn' : p.settleStatus === 'reversed' ? 'neg' : 'muted')}
                style={{ fontSize: 10.5 }}
              >
                {t(p.settleStatus === 'pending' ? 'paySettlePending'
                  : p.settleStatus === 'reversed' ? 'paySettleReversed' : 'paySettleFailed')}
              </span>
            )}
            {/* Each row is the way back to its transaction: the Payments page
                pinned to this order, that row open. */}
            <RouteLink
              to={openPath(p.id)}
              className="muted rec-link"
              title={t('payLedgerOpen')}
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {fmtDateShort(p.postedAt, locale)}
              {' '}
              {p.counterparty ?? (p.source === 'paired' ? 'PayPal + Mercury' : p.source)}
            </RouteLink>
            <span className="mono" style={{ marginLeft: 'auto', color: p.amount > 0 ? 'var(--pos)' : undefined }}>
              {(p.amount < 0 ? '−' : '+') + fmtUSD(Math.abs(p.amount), locale)}
            </span>
          </div>
        ))}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          paddingTop: 6, borderTop: '1px dashed var(--border)', fontWeight: 600,
        }}>
          <span>{t(netKey)}</span>
          <span className="mono">{(ledger.net < 0 ? '−' : '+') + fmtUSD(Math.abs(ledger.net), locale)}</span>
        </div>
      </div>
    </div>
  );
}
