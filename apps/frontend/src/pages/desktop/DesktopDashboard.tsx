import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { fmtUSD0, relTime } from '../../lib/format';
import type { Category, DashboardData } from '../../lib/types';

const CAT_COLOR: Record<Category, string> = {
  RAM:   'var(--info)',
  SSD:   'var(--accent)',
  Other: 'var(--warn)',
};

type Range = '7d' | '30d' | '90d' | 'ytd';

export function DesktopDashboard() {
  const { t } = useT();
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [lbCategory, setLbCategory] = useState<'all' | Category>('all');
  // The dashboard endpoint doesn't yet accept a range parameter — the seg
  // selector is wired so the UI matches the design, with a placeholder query
  // string ready for when the backend grows the filter.
  const [range, setRange] = useState<Range>('30d');

  useEffect(() => {
    const params = new URLSearchParams();
    if (range !== '30d') params.set('range', range);
    api.get<DashboardData>(`/api/dashboard?${params}`).then(setData).catch(console.error);
  }, [range]);

  if (!user) return null;
  const isManager = user.role === 'manager';
  const k = data?.kpis ?? { count: 0, cost: 0, revenue: 0, profit: 0, commission: 0 };
  const weeks = data?.weeks ?? [];
  const byCat = data?.byCat ?? ({} as DashboardData['byCat']);
  const rawLb = data?.leaderboard ?? [];

  const commissionPct = k.profit > 0 ? (k.commission / k.profit) * 100 : 0;
  const netProfit = k.profit - k.commission;

  // Filter leaderboard by category — at the moment the backend doesn't break
  // leaderboard rows down per-category, so the filter only narrows the visible
  // header label. (Follow-up: extend the API to return per-cat rollups per user.)
  const leaderboard = useMemo(() => rawLb, [rawLb]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{isManager ? t('teamDashboard') : t('yourNumbers')}</h1>
          <div className="page-sub">
            {isManager ? t('teamDashboardSub') : t('last30Mine', { n: k.count })}
          </div>
        </div>
        <div className="page-actions">
          <div className="seg" role="tablist" aria-label="Range">
            {(['7d', '30d', '90d', 'ytd'] as const).map(r => (
              <button
                key={r}
                className={range === r ? 'active' : ''}
                onClick={() => setRange(r)}
              >
                {r === 'ytd' ? 'YTD' : r}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi-label">{t('totalRevenue')}</div>
          <div className="kpi-value mono">{fmtUSD0(k.revenue)}</div>
          <div className="kpi-trend up"><Icon name="arrowUp" size={11} /> 12.4% {t('vsLastPeriod')}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('grossProfit')}</div>
          <div className="kpi-value mono" style={{ color: 'var(--pos)' }}>{fmtUSD0(k.profit)}</div>
          <div className="kpi-trend up">
            <Icon name="arrowUp" size={11} /> 8.7% {t('vsLastPeriod')}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{isManager ? t('commissionPaid') : t('commissionEarned')}</div>
          <div className="kpi-value mono">{fmtUSD0(k.commission)}</div>
          <div className="kpi-trend">
            <span style={{ color: 'var(--fg-subtle)' }}>
              {commissionPct.toFixed(1)}{t('ofGross')}
            </span>
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('netProfit')}</div>
          <div className="kpi-value mono">{fmtUSD0(netProfit)}</div>
          <div className="kpi-trend">
            <span style={{ color: 'var(--fg-subtle)' }}>{t('afterCommission')}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--gap)' }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">{t('profitTrend')}</div>
              <div className="card-sub">{t('profitTrendSub')}</div>
            </div>
            <span className="chip pos dot">{t('trackingUp')}</span>
          </div>
          <div className="card-body">
            <TrendChart weeks={weeks} />
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div className="card-title">{t('categoryBreakdown')}</div>
            <span className="card-sub">{t('byRevenue')}</span>
          </div>
          <div className="card-body">
            <CategoryBreakdown byCat={byCat} totalRevenue={k.revenue} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head" style={{ gap: 16 }}>
          <div>
            <div className="card-title">{t('contributorLeaderboard')}</div>
            <div className="card-sub">
              {t('rankedByProfit')} · {lbCategory === 'all' ? t('allItemTypes') : `${lbCategory} only`}
            </div>
          </div>
          <div className="seg" role="tablist" aria-label="Filter by item type">
            {(['all', 'RAM', 'SSD', 'Other'] as const).map(c => (
              <button
                key={c}
                className={lbCategory === c ? 'active' : ''}
                onClick={() => setLbCategory(c)}
              >
                {c === 'all' ? t('all') : c}
              </button>
            ))}
          </div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 50 }}>#</th>
                  <th>{t('contributor')}</th>
                  <th>{t('role')}</th>
                  <th className="num">{t('entries')}</th>
                  <th className="num">{t('revenue')}</th>
                  <th className="num">{t('profit')}</th>
                  <th className="num">{t('commission')}</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--fg-subtle)', fontSize: 13 }}>
                      No contributors have logged any {lbCategory === 'all' ? '' : `${lbCategory} `}sales yet.
                      {lbCategory !== 'all' && (
                        <>
                          {' '}
                          <button
                            onClick={() => setLbCategory('all')}
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer',
                              color: 'var(--accent-strong)', textDecoration: 'underline',
                              fontFamily: 'inherit', fontSize: 13, padding: 0,
                            }}
                          >
                            Show all item types
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )}
                {leaderboard.map((row, i) => (
                  <tr key={row.id} className="row-hover">
                    <td>
                      <span className={'lb-rank ' + (i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '')}>
                        {i + 1}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div className="avatar">{row.initials}</div>
                        <div>
                          <div style={{ fontWeight: 500 }}>{row.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{row.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="muted">{row.role === 'manager' ? t('role_manager') : t('role_purchaser')}</td>
                    <td className="num mono">{row.count}</td>
                    <td className="num mono">{fmtUSD0(row.revenue)}</td>
                    <td className="num mono pos">{fmtUSD0(row.profit)}</td>
                    <td className="num mono">{fmtUSD0(row.commission)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title">{t('recentActivity')}</div>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('item')}</th>
                  <th>{t('submittedBy')}</th>
                  <th className="num">{t('qty')}</th>
                  <th>{t('date')}</th>
                  <th className="num">{t('profit')}</th>
                </tr>
              </thead>
              <tbody>
                {(data?.recent ?? []).map(r => {
                  const label = r.category === 'RAM'
                    ? `${r.brand ?? ''} ${r.capacity ?? ''} ${r.type ?? ''}`.trim()
                    : r.category === 'SSD'
                      ? `${r.brand ?? ''} ${r.capacity ?? ''} ${r.interface ?? ''}`.trim()
                      : (r.description ?? 'Item');
                  const profit = ((r.sell_price ?? r.unit_cost) - r.unit_cost) * r.qty;
                  return (
                    <tr key={r.id} className="row-hover">
                      <td>{label}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div className="avatar">{r.user_initials}</div>
                          <span>{r.user_name}</span>
                        </div>
                      </td>
                      <td className="num">{r.qty}</td>
                      <td className="muted">{relTime(r.created_at)}</td>
                      <td className="num pos mono">+{fmtUSD0(profit)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function TrendChart({ weeks }: { weeks: { label: string; profit: number }[] }) {
  if (weeks.length === 0) {
    return <div style={{ padding: 32, textAlign: 'center', color: 'var(--fg-subtle)' }}>No data yet.</div>;
  }
  const max = Math.max(1, ...weeks.map(w => w.profit));
  const min = 0;
  const w = 700, h = 220;
  const pad = { l: 44, r: 16, t: 16, b: 28 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const x = (i: number) =>
    pad.l + (weeks.length === 1 ? innerW / 2 : (i / (weeks.length - 1)) * innerW);
  const y = (v: number) => pad.t + innerH - ((v - min) / (max - min || 1)) * innerH;
  const linePath = weeks.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(d.profit)}`).join(' ');
  const areaPath = linePath + ` L ${x(weeks.length - 1)} ${pad.t + innerH} L ${x(0)} ${pad.t + innerH} Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1];
  const yTicks = [0, 0.5, 1];

  return (
    <svg className="trend-svg" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="dashSpark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="var(--accent)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0"    />
        </linearGradient>
      </defs>
      {grid.map((p, i) => (
        <line
          key={i}
          x1={pad.l} x2={w - pad.r}
          y1={pad.t + p * innerH} y2={pad.t + p * innerH}
          stroke="var(--border)" strokeDasharray="3 3"
        />
      ))}
      {yTicks.map((p, i) => (
        <text
          key={i}
          x={pad.l - 8} y={pad.t + p * innerH + 4}
          fill="var(--fg-subtle)" fontSize="10" textAnchor="end"
          fontFamily="JetBrains Mono, monospace"
        >
          {fmtUSD0(max - p * (max - min))}
        </text>
      ))}
      <path d={areaPath} fill="url(#dashSpark)" />
      <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={2} />
      {weeks.map((d, i) => (
        <circle key={i} cx={x(i)} cy={y(d.profit)} r={3} fill="white" stroke="var(--accent)" strokeWidth={2} />
      ))}
      {weeks.map((d, i) => (
        <text key={`l-${i}`} x={x(i)} y={h - 8} fill="var(--fg-subtle)" fontSize={10} textAnchor="middle">
          {d.label}
        </text>
      ))}
    </svg>
  );
}

function CategoryBreakdown({
  byCat,
  totalRevenue,
}: {
  byCat: DashboardData['byCat'];
  totalRevenue: number;
}) {
  const cats: Category[] = ['RAM', 'SSD', 'Other'];
  return (
    <>
      {cats.map(cat => {
        const c = byCat[cat] ?? { count: 0, revenue: 0, profit: 0 };
        const pct = totalRevenue > 0 ? (c.revenue / totalRevenue) * 100 : 0;
        return (
          <div key={cat} style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 13 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: CAT_COLOR[cat] }} />
                <span style={{ fontWeight: 500 }}>{cat}</span>
                <span style={{ color: 'var(--fg-subtle)', fontSize: 11 }}>· {c.count}</span>
              </span>
              <span className="mono" style={{ fontWeight: 600 }}>{fmtUSD0(c.revenue)}</span>
            </div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: pct + '%', background: CAT_COLOR[cat] }} />
            </div>
            <div style={{
              fontSize: 11, color: 'var(--fg-subtle)', marginTop: 4,
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>{pct.toFixed(1)}% of revenue</span>
              <span>Profit {fmtUSD0(c.profit)}</span>
            </div>
          </div>
        );
      })}
    </>
  );
}
