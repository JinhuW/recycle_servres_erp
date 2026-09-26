import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { useT } from '../../lib/i18n';
import { useEffectiveUser } from '../../lib/tweaks';
import { api } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { isPricedSellPrice, REPORTING_TZ, resolvePreset, todayIn } from '@recycle-erp/shared';
import { fmtUSD0, relTime } from '../../lib/format';
import { lineSpecLabel } from '../../lib/lineGroups';
import type { Bucket, Category, DashboardData } from '../../lib/types';
import { DashboardSkeleton } from '../../components/Skeleton';
import { RangeBrush, RangeChip, fmtRange, type RangeValue } from './DashboardRange';
import { CashflowChart } from './DashboardChart';
import { ContribCard } from './DashboardContrib';

const CAT_COLOR: Record<Category, string> = {
  RAM:   'var(--info)',
  SSD:   'var(--accent)',
  HDD:   'oklch(0.55 0.18 295)',
  Other: 'var(--warn)',
};

const BUCKET_KEY: Record<Bucket, string> = { day: 'bucketDay', week: 'bucketWeek', month: 'bucketMonth' };

export function DesktopDashboard() {
  const { t, locale } = useT();
  const user = useEffectiveUser();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  // "Today" is the business day, not the viewer's — the brush's right edge and
  // every preset are anchored to it so two offices see one calendar.
  const today = useMemo(() => todayIn(REPORTING_TZ), []);
  const [range, setRange] = useState<RangeValue>(() => ({ ...resolvePreset('30d', today, null), preset: '30d' }));
  const [bucket, setBucket] = useState<Bucket | 'auto'>('auto');

  // The role-preview tweak flips `user.role`; refetch so the dashboard
  // re-scopes (own work vs. team-wide) when a manager toggles preview, matching
  // the backend's effectiveRole scoping. The `alive` guard keeps a slower
  // response from an earlier range from landing under the active buttons.
  const effRole = user?.role;
  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams({ from: range.from, to: range.to });
    if (bucket !== 'auto') params.set('bucket', bucket);
    setLoading(true);
    api.get<DashboardData>(`/api/dashboard?${params}`)
      .then(r => { if (alive) { setData(r); setLoading(false); } })
      .catch(e => { if (alive) setLoading(false); handleFetchError(e); });
    return () => { alive = false; };
  }, [range.from, range.to, bucket, effRole]);

  if (!user) return null;
  const isManager = user.role === 'manager';
  const k = data?.kpis ?? {
    count: 0, cost: 0, revenue: 0, profit: 0, commission: 0,
    prev: { revenue: 0, profit: 0 },
  };
  const byCat = data?.byCat ?? ({} as DashboardData['byCat']);
  const first = data?.bounds.first ?? null;
  const rangeLabel = fmtRange(range.from, range.to, today, locale);
  const activeBucket: Bucket = bucket === 'auto' ? (data?.window.bucket ?? 'day') : bucket;
  const countCaption = (n: number, sales: boolean) =>
    isManager && sales ? t('nSellOrders', { n }) : t('nPOs', { n });

  const commissionPct = k.profit > 0 ? (k.commission / k.profit) * 100 : 0;
  const netProfit = k.profit - k.commission;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{isManager ? t('teamDashboard') : t('yourNumbers')}</h1>
          <div className="page-sub">
            {isManager ? t('teamDashboardSub') : t('dashRangeMine', { range: rangeLabel, n: k.count })}
          </div>
        </div>
        <div className="page-actions">
          <RangeChip value={range} today={today} first={first} locale={locale} onChange={setRange} />
        </div>
      </div>

      <RangeBrush value={range} today={today} first={first} locale={locale} onChange={setRange} />

      {!data ? (
        <DashboardSkeleton />
      ) : (
      <div className={'dash-body' + (loading ? ' is-loading' : '')}>
      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi-label">{t('totalRevenue')}</div>
          <div className="kpi-value mono">{fmtUSD0(k.revenue, locale)}</div>
          <TrendChip current={k.revenue} prev={k.prev.revenue} label={t('vsLastPeriod')} />
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('grossProfit')}</div>
          <div className="kpi-value mono" style={{ color: 'var(--pos)' }}>{fmtUSD0(k.profit, locale)}</div>
          <TrendChip current={k.profit} prev={k.prev.profit} label={t('vsLastPeriod')} />
        </div>
        <div className="kpi">
          <div className="kpi-label">{isManager ? t('commissionPaid') : t('commissionEarned')}</div>
          <div className="kpi-value mono">{fmtUSD0(k.commission, locale)}</div>
          <div className="kpi-trend">
            <span style={{ color: 'var(--fg-subtle)' }}>
              {commissionPct.toFixed(1)}{t('ofGross')}
            </span>
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t('netProfit')}</div>
          <div className="kpi-value mono">{fmtUSD0(netProfit, locale)}</div>
          <div className="kpi-trend">
            <span style={{ color: 'var(--fg-subtle)' }}>{t('afterCommission')}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--gap)' }}>
        <div className="card">
          <div className="card-head" style={{ gap: 16 }}>
            <div>
              <div className="card-title">{t('chartCashflow')}</div>
              <div className="card-sub">{t('chartCashflowSub')} · {rangeLabel}</div>
            </div>
            <div className="seg" role="tablist" aria-label={t('chartBucketAriaLabel')}>
              {(['day', 'week', 'month'] as const).map(b => (
                <button key={b} className={activeBucket === b ? 'active' : ''} onClick={() => setBucket(b)}>
                  {t(BUCKET_KEY[b])}
                </button>
              ))}
            </div>
          </div>
          <div className="card-body">
            <CashflowChart series={data.series} bucket={data.window.bucket} from={data.window.from} to={data.window.to} locale={locale} />
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div className="card-title">{t('categoryBreakdown')}</div>
            <span className="card-sub">{t('byRevenue')}</span>
          </div>
          <div className="card-body">
            <CategoryBreakdown byCat={byCat} totalRevenue={k.revenue} locale={locale} />
          </div>
        </div>
      </div>

      <div className="dash-contrib-grid">
        <ContribCard title={t('contribCost')} note={t(isManager ? 'contribCostNote' : 'contribCostNoteMine')}
                     caption={countCaption(data.contrib.cost.count, false)}
                     data={data.contrib.cost} locale={locale} />
        <ContribCard title={t('contribSales')} note={t(isManager ? 'contribSalesNote' : 'contribSalesNoteMine')}
                     caption={countCaption(data.contrib.revenue.count, true)}
                     data={data.contrib.revenue} locale={locale}
                     purchaserAs={{ dim: 'dimSourcedBy' }} />
        <ContribCard title={t('contribProfit')} note={t(isManager ? 'contribProfitNote' : 'contribProfitNoteMine')}
                     caption={countCaption(data.contrib.profit.count, true)}
                     data={data.contrib.profit} locale={locale}
                     purchaserAs={{ dim: 'dimSourcedBy' }} />
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
                  const label = lineSpecLabel(r) ?? (r.description ?? 'Item');
                  // An unpriced line has no projected margin — the KPI tiles
                  // above don't count it, so this row can't state one. Em-dash,
                  // the same as the orders list's line rows.
                  const priced = isPricedSellPrice(r.sell_price);
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
                      <td className="muted">{relTime(r.created_at, locale)}</td>
                      <td className={'num mono' + (priced ? ' pos' : ' muted')}>
                        {priced ? '+' + fmtUSD0(r.profit ?? 0, locale) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      </div>
      )}
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

// Render nothing when prev is 0 — a "vs last period" chip is meaningless without
// a comparator, and "+∞%" or "—" both add visual noise without conveying signal.
function TrendChip({ current, prev, label }: { current: number; prev: number; label: string }) {
  if (prev === 0) return null;
  const delta = ((current - prev) / prev) * 100;
  const up = delta >= 0;
  return (
    <div className={'kpi-trend ' + (up ? 'up' : 'down')}>
      <Icon name={up ? 'arrowUp' : 'arrowDown'} size={11} /> {Math.abs(delta).toFixed(1)}% {label}
    </div>
  );
}

function CategoryBreakdown({
  byCat,
  totalRevenue,
  locale = 'en-US',
}: {
  byCat: DashboardData['byCat'];
  totalRevenue: number;
  locale?: string;
}) {
  const { t } = useT();
  const cats: Category[] = ['RAM', 'SSD', 'HDD', 'Other'];
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
              <span className="mono" style={{ fontWeight: 600 }}>{fmtUSD0(c.revenue, locale)}</span>
            </div>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: pct + '%', background: CAT_COLOR[cat] }} />
            </div>
            <div style={{
              fontSize: 11, color: 'var(--fg-subtle)', marginTop: 4,
              display: 'flex', justifyContent: 'space-between',
            }}>
              <span>{t('pctOfRevenue', { pct: pct.toFixed(1) })}</span>
              <span>{t('profitOf', { amount: fmtUSD0(c.profit, locale) })}</span>
            </div>
          </div>
        );
      })}
    </>
  );
}
