import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { PhSparkline } from '../components/PhSparkline';
import { useT } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { fmtUSD0 } from '../lib/format';
import { relTime } from '../lib/format';
import type { DashboardData } from '../lib/types';

type Props = {
  goSubmit: () => void;
  goHistory: () => void;
  onOpenNotifications: () => void;
  unreadCount: number;
};

export function Dashboard({ goSubmit, goHistory, onOpenNotifications, unreadCount }: Props) {
  const { t } = useT();
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    api.get<DashboardData>('/api/dashboard').then(setData).catch(console.error);
  }, []);

  if (!user) return null;
  const isManager = user.role === 'manager';

  const lb = data?.leaderboard ?? [];
  const myRank = lb.findIndex(x => x.id === user.id);
  const totals = data?.kpis ?? { count: 0, cost: 0, revenue: 0, profit: 0, commission: 0 };

  return (
    <>
      <div className="ph-header">
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

      <div className="ph-scroll">
        <div style={{ marginTop: 4 }}>
          <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.025em', margin: 0 }}>
            {isManager ? t('teamPerformance') : t('yourNumbers')}
          </h1>
          <div style={{ fontSize: 12.5, color: 'var(--fg-subtle)', marginTop: 4 }}>
            {isManager ? t('last30Team', { n: totals.count }) : t('last30Mine', { n: totals.count })}
          </div>
        </div>

        <div className="ph-kpi" style={{
          marginTop: 16,
          background: 'linear-gradient(150deg, var(--bg-elev), color-mix(in oklch, var(--accent-soft) 60%, white))',
          border: '1px solid color-mix(in oklch, var(--accent) 22%, var(--border))',
        }}>
          <div className="ph-kpi-label">{isManager ? t('grossProfit') : t('profitYouGenerated')}</div>
          <div className="ph-kpi-value" style={{ fontSize: 30, color: 'var(--accent-strong)' }}>{fmtUSD0(totals.profit)}</div>
          <div className="ph-kpi-trend" style={{ color: 'var(--pos)' }}>
            <Icon name="arrowUp" size={11} /> 12.4% vs last 30d
          </div>
          <PhSparkline data={data?.weeks ?? []} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
          <div className="ph-kpi">
            <div className="ph-kpi-label">{t('revenue')}</div>
            <div className="ph-kpi-value" style={{ fontSize: 18 }}>{fmtUSD0(totals.revenue)}</div>
          </div>
          <div className="ph-kpi">
            <div className="ph-kpi-label">{isManager ? t('commissionPaid') : t('yourCommission')}</div>
            <div className="ph-kpi-value" style={{ fontSize: 18 }}>{fmtUSD0(totals.commission)}</div>
          </div>
        </div>

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
                    {myRank > 0 && t('behindBy', { amt: fmtUSD0(lb[myRank - 1].profit - lb[myRank].profit), name: lb[myRank - 1].name.split(' ')[0] })}
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
                  <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--pos)' }}>{fmtUSD0(row.profit)}</div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="ph-section-h">
          <span>{t('recentActivity')}</span>
          <span className="more" onClick={goHistory} style={{ cursor: 'pointer' }}>{t('seeAll')}</span>
        </div>
        {(data?.recent ?? []).map(r => {
          const label = r.category === 'RAM'   ? `${r.brand ?? ''} ${r.capacity ?? ''} ${r.type ?? ''}`.trim()
                      : r.category === 'SSD'   ? `${r.brand ?? ''} ${r.capacity ?? ''} ${r.interface ?? ''}`.trim()
                      : (r.description ?? 'Item');
          const profit = ((r.sell_price ?? r.unit_cost) - r.unit_cost) * r.qty;
          return (
            <div key={r.id} className="ph-row">
              <div className="ph-mini-avatar">{r.user_initials}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {label}
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{r.user_name.split(' ')[0]} · {relTime(r.created_at)} · {t('qtyShort', { n: r.qty })}</div>
              </div>
              <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--pos)' }}>+{fmtUSD0(profit)}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}
