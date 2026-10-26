import { useRef, type ReactNode } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { RouteLink } from '../components/RouteLink';
import { PhoneListSkeleton } from '../components/Skeleton';
import { usePhScrolled } from '../lib/usePhScrolled';
import { useT } from '../lib/i18n';
import { useEffectiveUser } from '../lib/tweaks';
import { fmtDateShort, fmtUSD0 } from '../lib/format';
import { LIFECYCLE_STATUS, statusTone, WORKFLOW_STAGES } from '../lib/status';
import { NEED_SHORT_KEY, SERVER_BLOCKER_KEY } from '../lib/poReadiness';
import { ageTone, daysSince, useHomeData } from '../lib/home';
import type { ManagerHome, PurchaserHome } from '../lib/types';

type Props = {
  goSubmit: () => void;
  onOpenNotifications: () => void;
  unreadCount: number;
};

// The phone's Home: the same highlights as the desktop, as compact rows. Rows
// only link where the phone has a screen; the rest is the count to act on at a
// desk. The money view is one row away, under Numbers.
export function Home({ goSubmit, onOpenNotifications, unreadCount }: Props) {
  const { t } = useT();
  const user = useEffectiveUser();
  const data = useHomeData();
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = usePhScrolled(scrollRef);
  if (!user) return null;
  const isManager = user.role === 'manager';

  return (
    <>
      <div className={'ph-header' + (scrolled ? ' scrolled' : '')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="brand-mark" style={{ width: 32, height: 32, fontSize: 13 }}>RS</div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{t('greeting')}</div>
            <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>{user.name.split(' ')[0]}</div>
          </div>
        </div>
        <button className="ph-icon-btn" onClick={onOpenNotifications} style={{ position: 'relative', overflow: 'visible' }}>
          <Icon name="bell" size={16} />
          {unreadCount > 0 && <span className="ph-bell-badge">{unreadCount}</span>}
        </button>
      </div>

      <div className="ph-scroll" ref={scrollRef}>
        <div style={{ marginTop: 4 }}>
          <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.025em', margin: 0 }}>{t('homeNeedsYou')}</h1>
          <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', marginTop: 4 }}>
            {t(isManager ? 'homeSubManager' : 'homeSubPurchaser')}
          </div>
        </div>

        <button className="ph-scan-cta" onClick={goSubmit}>
          <div className="ph-scan-cta-icon"><Icon name="camera" size={18} /></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{t('scanWithAI')}</div>
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>{t('scanWithAISub')}</div>
          </div>
          <Icon name="chevronRight" size={16} />
        </button>

        {!data ? <div style={{ marginTop: 16 }}><PhoneListSkeleton rows={5} /></div>
          : data.role === 'manager' ? <ManagerRows m={data.manager} />
          : <PurchaserRows p={data.purchaser} />}

        <div className="ph-section-h"><span>{t('nav_analysis')}</span></div>
        <LinkRow to="/analysis" icon="analytics"
                 title={t(isManager ? 'homeSeeTeamNumbers' : 'homeSeeYourNumbers')} sub={t('homeOpenNumbers')} />
        {!isManager && <LinkRow to="/market" icon="tag" title={t('homeMarketLink')} />}
        {/* Inventory and RMB Flow have no tab on the manager's bar; Home is
            their way in. */}
        {isManager && <LinkRow to="/inventory" icon="inventory" title={t('homeInventoryLink')} />}
        {isManager && <LinkRow to="/accounting" icon="cash" title={t('homeAccountingLink')} />}
      </div>
    </>
  );
}

function PurchaserRows({ p }: { p: PurchaserHome }) {
  const { t, locale } = useT();
  const pkgSub = [
    p.packages.moving > 0 ? t('shipMobMovingN', { n: p.packages.moving }) : null,
    p.packages.needs > 0 ? t('shipMobNeedsN', { n: p.packages.needs }) : null,
  ].filter(Boolean).join(' · ');
  return (
    <>
      <div className="ph-home-stages">
        {WORKFLOW_STAGES.map(s => {
          const n = p.stages[s.id as keyof PurchaserHome['stages']];
          return (
            <RouteLink key={s.id} to="/purchase-orders" className={'ph-home-stage' + (n ? '' : ' empty')}>
              <span className="mono">{n}</span>
              <span>{s.label}</span>
            </RouteLink>
          );
        })}
      </div>

      <div className="ph-section-h"><span>{t('homeOpenPos')}</span></div>
      {p.openPos.items.length === 0 && <Clear text={t('homeNoOpenPos')} />}
      {p.openPos.items.map(o => {
        const label = LIFECYCLE_STATUS[o.lifecycle] ?? o.lifecycle;
        return (
          <RouteLink key={o.id} to={'/purchase-orders/' + o.id} className="ph-row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{o.id}</span>
                <span className={'chip dot ' + statusTone(label)} style={{ fontSize: 10 }}>{label}</span>
              </div>
              <div className="ph-home-next">{nextStep(o, t, locale)}</div>
            </div>
            <Age since={o.since} />
          </RouteLink>
        );
      })}

      {(p.packages.moving + p.packages.needs > 0) && (
        <LinkRow to="/shipping" icon="truck" title={t('homeYourPackages')} sub={pkgSub}
                 badge={p.packages.needs || undefined} />
      )}
      {p.commission.owedCount > 0 && (
        <Row icon="dollar" title={t('homeCommissionOwed', { n: p.commission.owedCount })}
             value={fmtUSD0(p.commission.owed, locale)} />
      )}
      {p.followUps.due > 0 && (
        <Row icon="book" title={t('homeFollowUps')}
             sub={t('homeFollowUpsSub', { due: p.followUps.due, soon: p.followUps.soon })} />
      )}
    </>
  );
}

function ManagerRows({ m }: { m: ManagerHome }) {
  const { t, locale } = useT();
  return (
    <>
      <div className="ph-home-tiles">
        <Tile to="/shipping" n={m.inbound.arriving} label={t('homeTileArriving')} />
        <Tile to="/shipping" n={m.inbound.needs} label={t('homeTileInboundNeeds')} />
        <Tile to="/purchase-orders" n={m.review.count} label={t('homeTileReview')} />
        <Tile to="/purchase-orders" n={m.readyToPay.count} label={t('homeTileReadyToPay')} />
        <Tile n={m.signoffs.count} label={t('homeTileSignoffs')} />
        <Tile to="/accounting" n={m.rmb.forMe + m.rmb.asked} label={t('homeTileRmb')} />
      </div>

      <div className="ph-section-h"><span>{t('homeReviewQueue')}</span></div>
      {m.review.items.length === 0 && <Clear text={t('homeNoReview')} />}
      {m.review.items.map(r => (
        <RouteLink key={r.id} to={'/purchase-orders/' + r.id} className="ph-row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              <span className="mono">{r.id}</span>
              <span style={{ fontWeight: 400, color: 'var(--fg-subtle)' }}> · {r.purchaser}</span>
            </div>
            <div className="ph-home-next">
              {t('homeColChecked')} {r.checked}/{r.lines} · {r.findings > 0 ? t('homeFindingsN', { n: r.findings }) : (r.mine ? t('homeYou') : r.manager ?? '—')}
            </div>
          </div>
          <Age since={r.since} />
        </RouteLink>
      ))}
      {m.reverts.count > 0 && (
        <Row icon="alert" title={t('homeTileReverts')} value={String(m.reverts.count)} />
      )}

      <div className="ph-section-h"><span>{t('homeInbound')}</span></div>
      <LinkRow to="/shipping" icon="truck" title={t('shipMobInboundTitle')}
               sub={t('homeInboundSub', { arriving: m.inbound.arriving, moving: m.inbound.moving, pickups: m.inbound.pickups })}
               badge={m.inbound.needs || undefined} />

      <div className="ph-section-h"><span>{t('homeMoney')}</span></div>
      <Row icon="dollar" title={t('homeReadyToPayN', { n: m.readyToPay.count })} value={fmtUSD0(m.readyToPay.commission, locale)} />
      <Row icon="cash" title={t('homeUnlinkedN', { n: m.bank.unlinked })} value={fmtUSD0(m.bank.unlinkedAmount, locale)} />
      <Row icon="clock" title={t('homeAwaitingPaymentN', { n: m.sales.awaitingPayment })} />
      <Row icon="note" title={t('homeSellDraftsN', { n: m.sales.draft })} sub={t('homePackingN', { n: m.sales.packing })} />
      <Row icon="refresh" title={t('homeAfterSalesN', { n: m.queues.afterSales, mine: m.queues.afterSalesMine })} />
    </>
  );
}

type T = ReturnType<typeof useT>['t'];

function nextStep(o: PurchaserHome['openPos']['items'][number], t: T, locale: string): string {
  if (o.lifecycle === 'draft') {
    const keys = (o.blockers ?? []).map(b => SERVER_BLOCKER_KEY[b]).filter(Boolean);
    return keys.length === 0 ? t('homeReadyToSubmit') : keys.map(k => t(NEED_SHORT_KEY[k] ?? k)).join(' · ');
  }
  if (o.lifecycle === 'in_transit') {
    if (!o.package) return t('homeNextPickup');
    if (o.package.status === 'exception') return t('homePkgException');
    if (o.package.status === 'delivered') return t('homePkgDelivered');
    return o.package.eta ? t('homeEta', { date: fmtDateShort(o.package.eta, locale) }) : (o.package.trackingStatus ?? t('homeNoEta'));
  }
  return t(o.lifecycle === 'reviewing' ? 'homeNextReview' : 'homeNextPayout');
}

function Age({ since }: { since: string }) {
  const { t } = useT();
  const d = daysSince(since);
  return <span className={'home-age ' + ageTone(d)}>{d === 0 ? t('homeToday') : t('homeDaysN', { n: d })}</span>;
}

function Tile({ to, n, label }: { to?: string; n: number; label: string }) {
  const body: ReactNode = (<><span className="mono">{n}</span><span>{label}</span></>);
  const cls = 'ph-home-tile' + (n === 0 ? ' empty' : '');
  return to ? <RouteLink to={to} className={cls}>{body}</RouteLink> : <div className={cls}>{body}</div>;
}

function Clear({ text }: { text: string }) {
  return <div className="home-clear"><Icon name="check" size={14} /> {text}</div>;
}

function Row({ icon, title, sub, value }: { icon: IconName; title: string; sub?: string; value?: string }) {
  return (
    <div className="ph-row">
      <div className="ph-inv-thumb" style={{ width: 36, height: 36 }}><Icon name={icon} size={16} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{title}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>{sub}</div>}
      </div>
      {value && <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{value}</span>}
    </div>
  );
}

function LinkRow({ to, icon, title, sub, badge }: { to: string; icon: IconName; title: string; sub?: string; badge?: number }) {
  return (
    <RouteLink to={to} className="ph-row" style={{ width: '100%', marginTop: 8, textAlign: 'left' }}>
      <div className="ph-inv-thumb" style={{ width: 36, height: 36 }}><Icon name={icon} size={16} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{title}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>{sub}</div>}
      </div>
      {badge !== undefined && <span className="ph-home-badge mono">{badge}</span>}
      <Icon name="chevronRight" size={15} className="arrow" />
    </RouteLink>
  );
}
