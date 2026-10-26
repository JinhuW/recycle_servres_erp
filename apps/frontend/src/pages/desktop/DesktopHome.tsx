import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { RouteLink } from '../../components/RouteLink';
import { DashboardSkeleton } from '../../components/Skeleton';
import { useT } from '../../lib/i18n';
import { useEffectiveUser } from '../../lib/tweaks';
import { fmtDateShort, fmtUSD0 } from '../../lib/format';
import { LIFECYCLE_STATUS, statusTone, WORKFLOW_STAGES } from '../../lib/status';
import { NEED_SHORT_KEY, SERVER_BLOCKER_KEY } from '../../lib/poReadiness';
import { ACCOUNTING_REVIEW_PATH } from '../../lib/route';
import {
  ageTone, daysSince, managerTiles, poStagePath, sellStatusPath, useHomeData,
} from '../../lib/home';
import type { HomePackage, ManagerHome, PurchaserHome } from '../../lib/types';

// Home: what is waiting on the viewer right now. The numbers moved to
// Analysis; every row here links to the page where the work gets done.
export function DesktopHome() {
  const { t } = useT();
  const user = useEffectiveUser();
  const data = useHomeData();
  if (!user) return null;
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('homeGreeting', { name: user.name.split(' ')[0] })}</h1>
          <div className="page-sub">{t(user.role === 'manager' ? 'homeSubManager' : 'homeSubPurchaser')}</div>
        </div>
        <div className="page-actions">
          <RouteLink to="/analysis" className="btn">
            <Icon name="analytics" size={14} /> {t(user.role === 'manager' ? 'homeSeeTeamNumbers' : 'homeSeeYourNumbers')}
          </RouteLink>
        </div>
      </div>
      {!data ? <DashboardSkeleton />
        : data.role === 'manager' ? <ManagerView m={data.manager} />
        : <PurchaserView p={data.purchaser} />}
    </>
  );
}

// ── Purchaser ────────────────────────────────────────────────────────────────

function PurchaserView({ p }: { p: PurchaserHome }) {
  const { t, locale } = useT();
  return (
    <div className="home-body">
      <div className="home-pipeline">
        {WORKFLOW_STAGES.map(s => (
          <RouteLink key={s.id} to={poStagePath(s.id)} className={'home-stage' + (p.stages[s.id as keyof PurchaserHome['stages']] ? '' : ' empty')}>
            <span className={'chip dot ' + statusTone(s.label)}>{s.label}</span>
            <span className="home-stage-n mono">{p.stages[s.id as keyof PurchaserHome['stages']]}</span>
            <span className="home-stage-sub">{t(s.id === 'done' ? 'homeStageDoneSub' : `homeStageSub_${s.id}`)}</span>
          </RouteLink>
        ))}
      </div>

      <div className="home-grid">
        <Card title={t('homeOpenPos')} sub={t('homeOpenPosSub', { n: p.openPos.count })}
              more={p.openPos.count > p.openPos.items.length ? { to: '/purchase-orders', label: t('seeAll') } : undefined}>
          {p.openPos.items.length === 0 ? <AllClear text={t('homeNoOpenPos')} /> : (
            <table className="table home-table">
              <thead>
                <tr>
                  <th>{t('homeColPo')}</th><th>{t('homeColStage')}</th><th>{t('homeColInStage')}</th>
                  <th>{t('homeColNext')}</th><th className="num">{t('homeColCost')}</th>
                </tr>
              </thead>
              <tbody>
                {p.openPos.items.map(o => {
                  const label = LIFECYCLE_STATUS[o.lifecycle] ?? o.lifecycle;
                  return (
                    <tr key={o.id} className="row-hover">
                      <td>
                        <RouteLink to={'/purchase-orders/' + o.id} className="mono rec-link">{o.id}</RouteLink>
                        {o.supplier && <div className="home-sub">{o.supplier}</div>}
                      </td>
                      <td><span className={'chip dot ' + statusTone(label)}>{label}</span></td>
                      <td><Age since={o.since} /></td>
                      <td className="home-next">{nextStep(o, t, locale)}</td>
                      <td className="num mono">{fmtUSD0(o.cost, locale)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <div className="home-col">
          <Card title={t('homeYourPackages')}
                sub={[
                  p.packages.moving > 0 ? t('shipMobMovingN', { n: p.packages.moving }) : null,
                  p.packages.needs > 0 ? t('shipMobNeedsN', { n: p.packages.needs }) : null,
                ].filter(Boolean).join(' · ') || undefined}
                more={{ to: '/shipping', label: t('seeAll') }}>
            <PackageList items={p.packages.items} empty={t('homeNoPackages')} />
          </Card>

          <Card title={t('homeCommission')}>
            <div className="home-money">
              <RouteLink to={poStagePath('ready_to_pay')} className="home-money-row">
                <span>{t('homeCommissionOwed', { n: p.commission.owedCount })}</span>
                <span className="mono">{fmtUSD0(p.commission.owed, locale)}</span>
              </RouteLink>
              <div className="home-money-row">
                <span>{t('homeCommissionPaid', { n: p.commission.recentDays })}</span>
                <span className="mono pos">{fmtUSD0(p.commission.paidRecent, locale)}</span>
              </div>
            </div>
          </Card>

          <Card title={t('homeFollowUps')}
                sub={p.followUps.due + p.followUps.soon > 0
                  ? t('homeFollowUpsSub', { due: p.followUps.due, soon: p.followUps.soon }) : undefined}
                more={{ to: '/clients', label: t('seeAll') }}>
            {p.followUps.items.length === 0 ? <AllClear text={t('homeNoFollowUps')} /> : (
              <div className="home-list">
                {p.followUps.items.map(f => (
                  <RouteLink key={f.id} to={'/clients/' + f.id} className="home-list-row">
                    <span className="home-list-main">{f.name}</span>
                    <span className={'home-list-meta' + (f.daysUntil < 0 ? ' neg' : f.daysUntil === 0 ? ' warn' : '')}>
                      {f.daysUntil < 0 ? t('homeOverdueN', { n: -f.daysUntil })
                        : f.daysUntil === 0 ? t('homeDueToday') : fmtDateShort(f.nextFollowUpAt, locale)}
                    </span>
                  </RouteLink>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

type T = ReturnType<typeof useT>['t'];

// What the PO is waiting for, in a few words: a draft's blockers, the box on
// its way, or the manager's next step.
function nextStep(o: PurchaserHome['openPos']['items'][number], t: T, locale: string): ReactNode {
  if (o.lifecycle === 'draft') {
    const keys = (o.blockers ?? []).map(b => SERVER_BLOCKER_KEY[b]).filter(Boolean);
    if (keys.length === 0) return <span className="pos">{t('homeReadyToSubmit')}</span>;
    return <span className="warn">{keys.map(k => t(NEED_SHORT_KEY[k] ?? k)).join(' · ')}</span>;
  }
  if (o.lifecycle === 'in_transit') {
    if (!o.package) return t('homeNextPickup');
    if (o.package.status === 'exception') return <span className="neg">{t('homePkgException')}</span>;
    if (o.package.status === 'delivered') return t('homePkgDelivered');
    return o.package.eta
      ? t('homeEta', { date: fmtDateShort(o.package.eta, locale) })
      : (o.package.trackingStatus ?? t('homeNoEta'));
  }
  if (o.lifecycle === 'reviewing') return t('homeNextReview');
  return t('homeNextPayout');
}

// ── Manager ──────────────────────────────────────────────────────────────────

function ManagerView({ m }: { m: ManagerHome }) {
  const { t, locale } = useT();
  return (
    <div className="home-body">
      <div className="home-tiles">
        {managerTiles(m).map(tile => (
          <RouteLink key={tile.key} to={tile.to} className={'home-tile' + (tile.count === 0 ? ' empty' : '')}>
            <span className="home-tile-n mono">{tile.count}</span>
            <span className="home-tile-label">{t(tile.labelKey)}</span>
          </RouteLink>
        ))}
      </div>

      <div className="home-grid">
        <Card title={t('homeReviewQueue')}
              sub={m.review.count > 0 ? t('homeReviewSub', { n: m.review.count, mine: m.review.mine }) : undefined}
              more={m.review.count > m.review.items.length ? { to: poStagePath('reviewing'), label: t('seeAll') } : undefined}>
          {m.review.items.length === 0 ? <AllClear text={t('homeNoReview')} /> : (
            <table className="table home-table">
              <thead>
                <tr>
                  <th>{t('homeColPo')}</th><th>{t('homeColWaiting')}</th>
                  <th>{t('homeColChecked')}</th><th>{t('homeColAi')}</th><th>{t('homeColManager')}</th>
                </tr>
              </thead>
              <tbody>
                {m.review.items.map(r => (
                  <tr key={r.id} className="row-hover">
                    <td>
                      <RouteLink to={'/purchase-orders/' + r.id} className="mono rec-link">{r.id}</RouteLink>
                      <div className="home-sub">{r.purchaser}</div>
                    </td>
                    <td><Age since={r.since} /></td>
                    <td><Progress done={r.checked} total={r.lines} /></td>
                    <td>{r.findings > 0
                      ? <span className="chip warn">{t('homeFindingsN', { n: r.findings })}</span>
                      : <span className="muted">—</span>}</td>
                    <td className={r.mine ? '' : 'muted'}>{r.mine ? t('homeYou') : (r.manager ?? '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {m.reverts.count > 0 && (
            <div className="home-callout">
              <Icon name="alert" size={14} />
              <span>{t('homeRevertsN', { n: m.reverts.count })}</span>
              {m.reverts.items.map(r => (
                <RouteLink key={r.id} to={'/purchase-orders/' + r.id} className="mono rec-link">{r.id}</RouteLink>
              ))}
            </div>
          )}
        </Card>

        <Card title={t('homeInbound')}
              sub={t('homeInboundSub', { arriving: m.inbound.arriving, moving: m.inbound.moving, pickups: m.inbound.pickups })}
              more={{ to: '/shipping', label: t('seeAll') }}>
          <PackageList items={m.inbound.items} empty={t('homeNoInbound')} showCreator />
        </Card>
      </div>

      <div className="home-grid-3">
        <Card title={t('homeMoney')}>
          <div className="home-money">
            <MoneyRow to={poStagePath('ready_to_pay')} label={t('homeReadyToPayN', { n: m.readyToPay.count })}
                      value={fmtUSD0(m.readyToPay.commission, locale)} icon="dollar" />
            <MoneyRow to={sellStatusPath('Awaiting payment')} label={t('homeAwaitingPaymentN', { n: m.sales.awaitingPayment })}
                      icon="clock" />
            <MoneyRow to="/payments" label={t('homeUnlinkedN', { n: m.bank.unlinked })}
                      value={fmtUSD0(m.bank.unlinkedAmount, locale)} icon="cash" />
            {m.bank.disputes > 0 && (
              <MoneyRow to="/payments" label={t('homeDisputesN', { n: m.bank.disputes })} icon="alert" tone="neg" />
            )}
          </div>
        </Card>

        <Card title={t('homeSales')}>
          <div className="home-money">
            <MoneyRow to={sellStatusPath('Draft')} icon="note"
                      label={m.sales.draftConnector > 0
                        ? t('homeSellDraftsConnector', { n: m.sales.draft, c: m.sales.draftConnector })
                        : t('homeSellDraftsN', { n: m.sales.draft })} />
            <MoneyRow to={sellStatusPath('Shipped')} label={t('homeShippedN', { n: m.sales.shipped })} icon="truck" />
          </div>
          {m.sales.packingItems.length > 0 && (
            <div className="home-list">
              <div className="home-list-h">{t('homePackingN', { n: m.sales.packing })}</div>
              {m.sales.packingItems.map(s => (
                <RouteLink key={s.id} to={'/sell-orders/' + s.id} className="home-list-row">
                  <span className="home-list-main"><span className="mono">{s.id}</span> · {s.customer}</span>
                  <Progress done={s.packed} total={s.lines} />
                </RouteLink>
              ))}
            </div>
          )}
          {m.signoffs.items.length > 0 && (
            <div className="home-list">
              <div className="home-list-h">{t('homeSignoffsN', { n: m.signoffs.count })}</div>
              {m.signoffs.items.map(s => (
                <RouteLink key={s.id} to={'/sell-orders/' + s.id} className="home-list-row">
                  <span className="home-list-main"><span className="mono">{s.id}</span> · {s.customer}</span>
                  <span className="home-list-meta">{s.status}</span>
                </RouteLink>
              ))}
            </div>
          )}
        </Card>

        <Card title={t('homeOtherQueues')}>
          <div className="home-money">
            <MoneyRow to={ACCOUNTING_REVIEW_PATH} icon="cash"
                      label={t('homeRmbReview', { n: m.rmb.forMe, asked: m.rmb.asked })} />
            <MoneyRow to="/after-sales" icon="refresh"
                      label={t('homeAfterSalesN', { n: m.queues.afterSales, mine: m.queues.afterSalesMine })} />
            <MoneyRow to="/transfers" icon="truck" label={t('homeTransfersN', { n: m.queues.transfers })} />
            <MoneyRow to="/web-submissions" icon="mail" label={t('homeWebN', { n: m.queues.web })} />
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function Card({ title, sub, more, children }: {
  title: string; sub?: string; more?: { to: string; label: string }; children: ReactNode;
}) {
  return (
    <div className="card home-card">
      <div className="card-head">
        <div>
          <div className="card-title">{title}</div>
          {sub && <div className="card-sub">{sub}</div>}
        </div>
        {more && <RouteLink to={more.to} className="home-more">{more.label}</RouteLink>}
      </div>
      <div className="card-body">{children}</div>
    </div>
  );
}

function AllClear({ text }: { text: string }) {
  return (
    <div className="home-clear">
      <Icon name="check" size={14} /> {text}
    </div>
  );
}

function Age({ since }: { since: string }) {
  const { t } = useT();
  const d = daysSince(since);
  return <span className={'home-age ' + ageTone(d)}>{d === 0 ? t('homeToday') : t('homeDaysN', { n: d })}</span>;
}

function Progress({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return (
    <span className="home-progress" title={`${done}/${total}`}>
      <span className="bar-track"><span className="bar-fill" style={{ width: pct + '%' }} /></span>
      <span className="mono">{done}/{total}</span>
    </span>
  );
}

function MoneyRow({ to, label, value, icon, tone }: {
  to: string; label: string; value?: string; icon: IconName; tone?: 'neg';
}) {
  return (
    <RouteLink to={to} className={'home-money-row' + (tone ? ' ' + tone : '')}>
      <span className="home-money-label"><Icon name={icon} size={14} /> {label}</span>
      {value && <span className="mono">{value}</span>}
    </RouteLink>
  );
}

function PackageList({ items, empty, showCreator }: { items: HomePackage[]; empty: string; showCreator?: boolean }) {
  const { t, locale } = useT();
  if (items.length === 0) return <AllClear text={empty} />;
  return (
    <div className="home-list">
      {items.map(p => {
        const problem = p.status === 'exception' || p.status === 'delivered';
        return (
          <RouteLink key={p.id} to={p.orderId ? '/purchase-orders/' + p.orderId : '/shipping'} className="home-list-row">
            <span className="home-list-main">
              <span className="mono">{p.carrier} {p.trackingNumber.slice(-6)}</span>
              {p.orderId && <span className="home-sub"> · {p.orderId}</span>}
              {showCreator && p.creator && <span className="home-sub"> · {p.creator}</span>}
            </span>
            <span className={'home-list-meta' + (problem ? ' neg' : '')}>
              {p.status === 'exception' ? t('homePkgException')
                : p.status === 'delivered' ? t('homePkgNoPo')
                : p.eta ? t('homeEta', { date: fmtDateShort(p.eta, locale) })
                : (p.trackingStatus ?? t('homeNoEta'))}
            </span>
          </RouteLink>
        );
      })}
    </div>
  );
}
