import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { usePhScrolled } from '../lib/usePhScrolled';
import { PhSparkline } from '../components/PhSparkline';
import { useT } from '../lib/i18n';
import { useEffectiveUser } from '../lib/tweaks';
import { isPricedSellPrice } from '@recycle-erp/shared';
import { api } from '../lib/api';
import { handleFetchError } from '../lib/errorToast';
import { fmtUSD0 } from '../lib/format';
import { relTime } from '../lib/format';
import { navigate } from '../lib/route';
import type { DashboardData } from '../lib/types';
import { Skeleton, PhoneKpiSkeleton, PhoneListSkeleton } from '../components/Skeleton';

type Props = {
  goSubmit: () => void;
  goHistory: () => void;
  onOpenNotifications: () => void;
  unreadCount: number;
};

export function Dashboard({ goSubmit, goHistory, onOpenNotifications, unreadCount }: Props) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const user = useEffectiveUser();
  const [data, setData] = useState<DashboardData | null>(null);

  // The role-preview tweak flips `user.role`; refetch so the dashboard
  // re-scopes (own work vs. team-wide) when a manager toggles preview, matching
  // the backend's effectiveRole scoping.
  const effRole = user?.role;
  useEffect(() => {
    let alive = true;
    api.get<DashboardData>('/api/dashboard').then(r => { if (alive) setData(r); }).catch(handleFetchError);
    return () => { alive = false; };
  }, [effRole]);

  // Inbound counts for the shipping card — the card is also the manager's only
  // tab-bar-free entry to /shipping, so both roles load it. Silent on failure:
  // a nav card that can't count just doesn't show.
  const [inbound, setInbound] = useState<{ moving: number; needs: number } | null>(null);
  useEffect(() => {
    let alive = true;
    api.get<{ moving: number; needs: number }>('/api/shipments/inbound-counts?mine=true')
      .then(r => { if (alive) setInbound(r); })
      .catch(() => {});
    return () => { alive = false; };
  }, [effRole]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolled = usePhScrolled(scrollRef);

  if (!user) return null;
  const isManager = user.role === 'manager';

  const lb = data?.leaderboard ?? [];
  const myRank = lb.findIndex(x => x.id === user.id);
  const totals = data?.kpis ?? {
    count: 0, cost: 0, revenue: 0, profit: 0, commission: 0,
    prev: { revenue: 0, profit: 0 },
  };
  const prevProfit = totals.prev.profit;
  const profitDelta = prevProfit === 0 ? null : ((totals.profit - prevProfit) / prevProfit) * 100;

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
          {unreadCount > 0 && (
            <span style={{
              position: 'absolute', top: -2, right: -2,
              minWidth: 15, height: 15, padding: '0 3px',
              borderRadius: 999, background: 'var(--accent)', color: 'white',
              fontSize: 9.5, fontWeight: 700, lineHeight: '15px', textAlign: 'center',
              border: '2px solid var(--bg)', boxSizing: 'content-box',
              fontFamily: 'JetBrains Mono, monospace', letterSpacing: '-0.02em',
              pointerEvents: 'none',
            }}>{unreadCount}</span>
          )}
        </button>
      </div>

      <div className="ph-scroll" ref={scrollRef}>
        <div style={{ marginTop: 4 }}>
          <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.025em', margin: 0 }}>
            {isManager ? t('teamPerformance') : t('yourNumbers')}
          </h1>
          <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', marginTop: 4 }}>
            {isManager ? t('last30Team', { n: totals.count }) : t('last30Mine', { n: totals.count })}
          </div>
        </div>

        {!data ? (
          <div className="ph-kpi" style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Skeleton width={120} height={11} />
            <Skeleton width={180} height={30} radius={6} />
            <Skeleton width={120} height={10} />
            <div style={{ height: 60 }}>
              <Skeleton width="100%" height={60} radius={8} />
            </div>
          </div>
        ) : (
        <div className="ph-kpi" style={{
          marginTop: 16,
          background: 'linear-gradient(150deg, var(--bg-elev), color-mix(in oklch, var(--accent-soft) 60%, white))',
          border: '1px solid color-mix(in oklch, var(--accent) 22%, var(--border))',
        }}>
          <div className="ph-kpi-label">{isManager ? t('grossProfit') : t('profitYouGenerated')}</div>
          <div className="ph-kpi-value" style={{ fontSize: 30, color: 'var(--accent-strong)' }}>{fmtUSD0(totals.profit, locale)}</div>
          {profitDelta !== null && (
            <div className="ph-kpi-trend" style={{ color: profitDelta >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
              <Icon name={profitDelta >= 0 ? 'arrowUp' : 'arrowDown'} size={11} />
              {' '}{t('vsLast30', { pct: `${profitDelta >= 0 ? '+' : '−'}${Math.abs(profitDelta).toFixed(1)}%` })}
            </div>
          )}
          <PhSparkline data={data?.weeks ?? []} />
        </div>
        )}

        {!data ? (
          <div style={{ marginTop: 12 }}>
            <PhoneKpiSkeleton tiles={2} />
          </div>
        ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
          <div className="ph-kpi">
            <div className="ph-kpi-label">{t('revenue')}</div>
            <div className="ph-kpi-value" style={{ fontSize: 18 }}>{fmtUSD0(totals.revenue, locale)}</div>
          </div>
          <div className="ph-kpi">
            <div className="ph-kpi-label">{isManager ? t('commissionPaid') : t('yourCommission')}</div>
            <div className="ph-kpi-value" style={{ fontSize: 18 }}>{fmtUSD0(totals.commission, locale)}</div>
          </div>
        </div>
        )}

        <button
          onClick={goSubmit}
          style={{
            marginTop: 14, width: '100%', padding: 14,
            background: 'var(--fg)', color: 'white',
            border: 'none', borderRadius: 14,
            display: 'flex', alignItems: 'center', gap: 12,
            fontFamily: 'inherit', fontSize: 14, fontWeight: 500,
            textAlign: 'left',
          }}
        >
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(255,255,255,0.12)', display: 'grid', placeItems: 'center' }}>
            <Icon name="camera" size={18} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{t('scanWithAI')}</div>
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>{t('scanWithAISub')}</div>
          </div>
          <Icon name="chevronRight" size={16} />
        </button>

        {/* Managers always get the card — the phone tab bar gives them
            Inventory, not Shipping, so this row is their only way in. For
            purchasers (who have the tab) it appears once there's something
            to glance at. */}
        {inbound && (isManager || inbound.moving + inbound.needs > 0) && (
          <button
            className="ph-row"
            onClick={() => navigate('/shipping')}
            style={{ width: '100%', marginTop: 10, fontFamily: 'inherit', textAlign: 'left', cursor: 'pointer' }}
          >
            <div className="ph-cat-icon" style={{ width: 36, height: 36, borderRadius: 10 }}>
              <Icon name="truck" size={17} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{t('shipMobInboundTitle')}</div>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                {[
                  inbound.moving > 0 ? t('shipMobMovingN', { n: inbound.moving }) : null,
                  inbound.needs > 0 ? t('shipMobNeedsN', { n: inbound.needs }) : null,
                ].filter(Boolean).join(' · ') || t('shipMobEmptyTitle')}
              </div>
            </div>
            {inbound.needs > 0 && (
              <span className="mono" style={{
                minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999,
                background: 'var(--warn)', color: 'white', fontSize: 10.5, fontWeight: 700,
                lineHeight: '18px', textAlign: 'center',
              }}>{inbound.needs}</span>
            )}
            <Icon name="chevronRight" size={15} className="arrow" />
          </button>
        )}

        {!isManager && (
          <button
            className="ph-row"
            onClick={() => navigate('/market')}
            style={{ width: '100%', marginTop: 8, fontFamily: 'inherit', textAlign: 'left', cursor: 'pointer' }}
          >
            <div className="ph-inv-thumb" style={{ width: 36, height: 36 }}>
              <Icon name="tag" size={16} />
            </div>
            <div style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{t('homeMarketLink')}</div>
            <Icon name="chevronRight" size={15} className="arrow" />
          </button>
        )}

        {!isManager && myRank >= 0 && (
          <>
            <div className="ph-section-h"><span>{t('yourRank')}</span></div>
            <div className="ph-card">
              <div style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className={'lb-rank ' + (myRank === 0 ? 'gold' : myRank === 1 ? 'silver' : myRank === 2 ? 'bronze' : '')} style={{ width: 32, height: 32, fontSize: 14 }}>
                  {myRank + 1}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{t('youreRank', { n: myRank + 1, total: lb.length })}</div>
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                    {myRank > 0 && t('behindBy', { amt: fmtUSD0(lb[myRank - 1].profit - lb[myRank].profit, locale), name: lb[myRank - 1].name.split(' ')[0] })}
                    {myRank === 0 && t('leadingTeam')}
                  </div>
                </div>
                <Icon name="medal" size={20} style={{ color: 'var(--accent)' }} />
              </div>
            </div>
          </>
        )}

        {isManager && lb.length > 0 && (
          <>
            <div className="ph-section-h"><span>{t('topContributors')}</span><span className="more">{t('seeAll')}</span></div>
            <div className="ph-card" style={{ padding: '4px 0' }}>
              {lb.slice(0, 3).map((row, i) => (
                <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: i < 2 ? '1px solid var(--border)' : 'none' }}>
                  <span className={'lb-rank ' + (i === 0 ? 'gold' : i === 1 ? 'silver' : 'bronze')}>{i + 1}</span>
                  <div className="ph-mini-avatar">{row.initials}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{row.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{t('nOrders', { n: row.count })}</div>
                  </div>
                  <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--pos)' }}>{fmtUSD0(row.profit, locale)}</div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="ph-section-h">
          <span>{t('recentActivity')}</span>
          <span className="more" onClick={goHistory} style={{ cursor: 'pointer' }}>{t('seeAll')}</span>
        </div>
        {!data && <PhoneListSkeleton rows={4} />}
        {(data?.recent ?? []).map(r => {
          const label = r.category === 'RAM'   ? `${r.brand ?? ''} ${r.capacity ?? ''} ${r.generation ?? ''}`.trim()
                      : r.category === 'SSD'   ? `${r.brand ?? ''} ${r.capacity ?? ''} ${r.interface ?? ''}`.trim()
                      : r.category === 'HDD'   ? `${r.brand ?? ''} ${r.capacity ?? ''} ${r.rpm ? r.rpm + 'rpm' : ''}`.trim()
                      : (r.description ?? 'Item');
          // An unpriced line has no projected margin — the profit tile above
          // doesn't count it, so this row can't state one. Em-dash, the same as
          // the orders list's line rows.
          const priced = isPricedSellPrice(r.sell_price);
          return (
            <div key={r.id} className="ph-row">
              <div className="ph-mini-avatar">{r.user_initials}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {label}
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{r.user_name.split(' ')[0]} · {relTime(r.created_at, locale)} · {t('qtyShort', { n: r.qty })}</div>
              </div>
              <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: priced ? 'var(--pos)' : 'var(--fg-subtle)' }}>
                {priced ? '+' + fmtUSD0(r.profit ?? 0, locale) : '—'}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
