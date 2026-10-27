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
import { lineSpecLabel } from '../lib/lineGroups';
import { PhHeader } from '../components/PhHeader';
import { navigateBack } from '../lib/route';
import type { DashboardData, LeaderboardSort } from '../lib/types';
import { Skeleton, PhoneKpiSkeleton, PhoneListSkeleton } from '../components/Skeleton';

type Props = {
  goHistory: () => void;
};

// Numbers: the phone's Analysis, opened from Home. The last 30 days, the
// ranking and the recent feed; what waits on the viewer lives on Home.
export function Dashboard({ goHistory }: Props) {
  const { t, locale } = useT();
  const user = useEffectiveUser();
  const [data, setData] = useState<DashboardData | null>(null);
  const [lbSort, setLbSort] = useState<LeaderboardSort>('cost');

  // The role-preview tweak flips `user.role`; refetch so the dashboard
  // re-scopes (own work vs. team-wide) when a manager toggles preview, matching
  // the backend's effectiveRole scoping.
  const effRole = user?.role;
  useEffect(() => {
    let alive = true;
    const url = lbSort === 'cost' ? '/api/dashboard' : `/api/dashboard?lb=${lbSort}`;
    api.get<DashboardData>(url).then(r => { if (alive) setData(r); }).catch(handleFetchError);
    return () => { alive = false; };
  }, [effRole, lbSort]);

  // Rank by what was bought or what it earned. Full-width, like every other
  // mobile segment row — the section caption above it is too small to host it.
  const lbSortRow = (
    <div className="seg" role="tablist" aria-label={t('dashLbSortAriaLabel')}
         style={{ width: '100%', display: 'grid', gridTemplateColumns: '1fr 1fr', marginBottom: 8 }}>
      {(['cost', 'commission'] as const).map(s => (
        <button key={s} className={lbSort === s ? 'active' : ''} onClick={() => setLbSort(s)}>
          {s === 'cost' ? t('totalCost') : t('commission')}
        </button>
      ))}
    </div>
  );

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
      <PhHeader
        title={isManager ? t('teamPerformance') : t('yourNumbers')}
        sub={isManager ? t('last30Team', { n: totals.count }) : t('last30Mine', { n: totals.count })}
        scrolled={scrolled}
        leading={(
          <button className="ph-icon-btn" onClick={() => navigateBack('/')} aria-label={t('back')}>
            <Icon name="chevronLeft" size={17} />
          </button>
        )}
      />

      <div className="ph-scroll" ref={scrollRef}>
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
          marginTop: 4,
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
          <PhSparkline data={(data?.series ?? []).map(s => ({
            // Numeric, so the edge labels fit inside the 360-unit sparkline.
            label: new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', timeZone: 'UTC' })
              .format(new Date(s.start + 'T00:00:00Z')),
            profit: s.profit,
          }))} />
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

        {!isManager && myRank >= 0 && (
          <>
            <div className="ph-section-h"><span>{t('yourRank')}</span></div>
            {lbSortRow}
            <div className="ph-card">
              <div style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
                <span className={'lb-rank ' + (myRank === 0 ? 'gold' : myRank === 1 ? 'silver' : myRank === 2 ? 'bronze' : '')} style={{ width: 32, height: 32, fontSize: 14 }}>
                  {myRank + 1}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{t('youreRank', { n: myRank + 1, total: lb.length })}</div>
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                    {myRank === 0
                      ? t('leadingTeam')
                      : (lbSort === 'cost' ? t('rankedByTotalCost') : t('rankedByCommission'))}
                  </div>
                </div>
                <Icon name="medal" size={20} style={{ color: 'var(--accent)' }} />
              </div>
            </div>
          </>
        )}

        {isManager && lb.length > 0 && (
          <>
            <div className="ph-section-h"><span>{t('topContributors')}</span></div>
            {lbSortRow}
            <div className="ph-card" style={{ padding: '4px 0' }}>
              {lb.slice(0, 3).map((row, i) => (
                <div key={row.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: i < 2 ? '1px solid var(--border)' : 'none' }}>
                  <span className={'lb-rank ' + (i === 0 ? 'gold' : i === 1 ? 'silver' : 'bronze')}>{i + 1}</span>
                  <div className="ph-mini-avatar">{row.initials}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{row.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{t('nOrders', { n: row.count })}</div>
                  </div>
                  <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: lbSort === 'commission' ? 'var(--pos)' : undefined }}>
                    {fmtUSD0(lbSort === 'cost' ? row.cost : row.commission, locale)}
                  </div>
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
          const label = lineSpecLabel(r) ?? (r.description ?? 'Item');
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
