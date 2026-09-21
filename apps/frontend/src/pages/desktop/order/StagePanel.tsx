import type { ReactNode } from 'react';
import { Icon } from '../../../components/Icon';
import { fmtDateShort, relTime } from '../../../lib/format';
import { useT } from '../../../lib/i18n';
import { NEED_SHORT_KEY, type ReadinessItem, type ReadinessTab } from '../../../lib/poReadiness';
import type { Order, OrderPackage } from '../../../lib/types';
import { PackageJourney } from '../PackageJourney';

// What the status section says under the stepper for the order's *current*
// stage: on the left what the stage is about — the Draft's readiness list,
// the box while In Transit, the review, the commission owed — and on the
// right the one next step and its button. The look-back for a finished stage
// is StageLookback; the banners (gate, revert, pending) are the page's and
// come in as children above the columns.

export type RefreshState = 'idle' | 'busy' | { error: string };

type Props = {
  status: string;
  order: Order;
  readiness: ReadinessItem[];
  /** Met summaries for the readiness rows, by section, preformatted. */
  summaries: Partial<Record<ReadinessTab, string>>;
  onGoTo: (tab: ReadinessTab) => void;
  next: { label: string; onClick: () => void; disabled: boolean; hint: string | null } | null;
  pkg: OrderPackage | null | undefined;
  onRefreshPkg: () => void;
  refreshState: RefreshState;
  doneEvidence: ReactNode;
  locale: string;
  children?: ReactNode;
};

export function StagePanel(p: Props) {
  const { t } = useT();
  const o = p.order;
  const wh = o.warehouse?.short ?? '';

  let left: ReactNode;
  if (p.status === 'Draft') {
    left = (
      <div className="oe-box">
        <div className="oe-box-h">
          <span>{t('poReadyTitle')}</span>
          <span className="r">{(() => {
            const miss = p.readiness.filter(r => r.blocking && !r.ok).length;
            return miss
              ? <span className="chip warn" style={{ fontSize: 10.5 }}>{t('eoReadyToGo', { n: miss })}</span>
              : <span className="chip pos" style={{ fontSize: 10.5 }}>{t('eoReadyAll')}</span>;
          })()}</span>
        </div>
        <ul className="oe-ready">
          {p.readiness.map(r => (
            <li key={r.tab}>
              <button type="button" className={'oe-ready-row' + (r.ok ? ' ok' : '')} onClick={() => p.onGoTo(r.tab)}>
                <span className={'oe-ready-dot ' + (r.ok ? 'ok' : r.blocking ? 'miss' : 'soft')} aria-hidden="true">
                  {r.ok ? <Icon name="check" size={10} stroke={3} /> : '!'}
                </span>
                <span className="oe-ready-label">{t(
                  r.tab === 'products' ? 'poReadyProducts'
                  : r.tab === 'delivery' ? 'poReadyDelivery'
                  : r.tab === 'payment' ? 'poReadyPayment' : 'poReadyCommission',
                )}</span>
                <span className={'oe-ready-sub' + (r.ok ? '' : ' miss')}>
                  {r.ok
                    ? p.summaries[r.tab] ?? ''
                    : t('eoNeeds', { what: r.needKeys.map(k => t(NEED_SHORT_KEY[k] ?? k)).join(', ') })}
                </span>
                <Icon name="chevronRight" size={13} className="oe-ready-arrow" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  } else if (p.status === 'In Transit') {
    left = o.handoffMethod === 'pickup' ? (
      <div className="oe-box">
        <div className="oe-box-h"><span>{t('hoPickup')}</span></div>
        <div className="oe-box-lead">
          {t('poCollectedBy', { name: o.handoffBy?.name ?? '—' })}
        </div>
        <div className="muted" style={{ fontSize: 12 }}>{t('eoPickupNoCarrier', { wh })}</div>
      </div>
    ) : p.pkg ? (
      <div className="oe-box">
        <div className="oe-box-h">
          <span>{t('orderShipment')}</span>
          <span className="r">
            <button
              type="button"
              className="btn sm"
              onClick={p.onRefreshPkg}
              disabled={p.refreshState === 'busy'}
              title={t('shipRefreshHint')}
            >
              <Icon name="refresh" size={12} /> {p.refreshState === 'busy' ? t('poPkgRefreshing') : t('poPkgRefresh')}
            </button>
          </span>
        </div>
        <PackageJourney pkg={p.pkg} />
        {typeof p.refreshState === 'object' && (
          <div className="oe-box-err" role="status">{p.refreshState.error}</div>
        )}
        <div className="muted" style={{ fontSize: 11.5 }}>
          {p.pkg.lastTrackedAt
            ? t('poPkgLastReport', { when: relTime(p.pkg.lastTrackedAt, p.locale) })
            : t('poPkgNoReportYet')}
        </div>
      </div>
    ) : (
      <div className="oe-box">
        <div className="oe-box-h"><span>{t('orderShipment')}</span></div>
        <div className="muted" style={{ fontSize: 12.5 }}>{t('eoNoDeliveryRecorded')}</div>
      </div>
    );
  } else if (p.status === 'Reviewing') {
    left = (
      <div className="oe-box">
        <div className="oe-box-h"><span>{t('eoStageReview')}</span></div>
        <div className="oe-box-lead">{t('eoReviewLead', { wh })}</div>
        <div className="muted" style={{ fontSize: 12 }}>{t('eoReviewHint')}</div>
        {/* A reopened Done PO keeps its note and files; they must stay
            reachable (and removable) here, not only once it is Done again. */}
        {p.doneEvidence}
      </div>
    );
  } else if (p.status === 'Ready to Pay') {
    left = (
      <div className="oe-box">
        <div className="oe-box-h"><span>{t('eoStageOwed')}</span></div>
        <div className="oe-box-lead">{t('eoOwedLead', { name: o.userName })}</div>
        <div className="muted" style={{ fontSize: 12 }}>{t('eoOwedHint')}</div>
        {p.doneEvidence}
      </div>
    );
  } else if (p.status === 'Sold') {
    left = (
      <div className="oe-box">
        <div className="oe-box-h"><span>{t('eoStageSold')}</span></div>
        <div className="oe-box-lead">{t('eoSoldLead', { n: o.realized?.soldQty ?? 0, name: o.userName })}</div>
        {p.doneEvidence}
      </div>
    );
  } else {
    left = (
      <div className="oe-box">
        <div className="oe-box-h"><span>{t('eoStageDone')}</span></div>
        <div className="oe-box-lead">{t('eoDoneLead', { name: o.userName })}</div>
        {p.doneEvidence}
      </div>
    );
  }

  return (
    <div className="oe-stage">
      {p.children}
      <div className="oe-stage-cols">
        {left}
        <div className="oe-box plain oe-stage-next">
          <div className="oe-box-h"><span>{t('eoStageNext')}</span></div>
          <div className="oe-box-lead">{t(
            p.status === 'Draft' ? 'eoNextDraft'
            : p.status === 'In Transit' ? 'eoNextInTransit'
            : p.status === 'Reviewing' ? 'eoNextReviewing'
            : p.status === 'Ready to Pay' ? 'eoNextReadyToPay'
            : p.status === 'Sold' ? 'eoNextSold' : 'eoNextDone',
            { wh, name: o.userName, date: fmtDateShort(o.createdAt, p.locale) },
          )}</div>
          {p.next && (
            <div className="oe-stage-act">
              <button type="button" className="btn accent" onClick={p.next.onClick} disabled={p.next.disabled}>
                {p.next.label} <Icon name="chevronRight" size={13} />
              </button>
              {p.next.hint && <span className="muted" style={{ fontSize: 12 }}>{p.next.hint}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
