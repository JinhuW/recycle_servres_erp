import { useMemo, useState } from 'react';
import { Skeleton, TableSkeleton } from '../../../components/Skeleton';
import { ApiError } from '../../../lib/api';
import { coordinatorApi, type AlertHitRow, type FilterPrompt, type FleetDoc, type ReviewStatsDay } from '../../../lib/coordinator';
import { fleetApi, type FleetCity, type FleetSlot, type FleetTask } from '../../../lib/fleet';
import { useT } from '../../../lib/i18n';
import { FlowCard } from '../FleetFlow';
import { alertsByCity, daySeries, FUNNEL_RANGES, niceTop, type DaySeries, type FunnelRange } from './fleetBoard';
import { EmptyRow, UnavailableCard, useFleetPoll, WorkerLink } from './shared';

// ─── Analysis ─────────────────────────────────────────────────────────────────
// Where listings drop out between a search and an alert. The pipeline card
// (FleetFlow.tsx) with a range, two per-day charts for the last 14 days, and
// the cities the alerts came from. The counts are the coordinator's, which
// are not tagged per worker: there is no worker or item filter here.

const DAYS = 14;

type Data = {
  stats: ReviewStatsDay[] | 'unavailable'; hits: AlertHitRow[]; fleet: FleetDoc | null; prompt: FilterPrompt | 'unavailable';
  cities: FleetCity[]; slots: FleetSlot[]; done: FleetTask[];
};

export function FleetAnalysisTab() {
  const { t } = useT();
  const [range, setRange] = useState<FunnelRange>(1);
  const { data, reload } = useFleetPoll<Data>(() => {
    const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
    return Promise.all([
      coordinatorApi.reviewStats(DAYS).then(s => s as ReviewStatsDay[] | 'unavailable').catch(err => {
        // 501 = no control plane here; the tab says so and shows nothing else.
        if (err instanceof ApiError && (err.status === 501 || err.status === 404)) throw err;
        return 'unavailable' as const;
      }),
      coordinatorApi.alertHits(DAYS).catch(() => []),
      coordinatorApi.fleet().catch(() => null),
      coordinatorApi.filterPrompt().then(p => (p.prompt ? p : 'unavailable' as const)).catch(() => 'unavailable' as const),
      fleetApi.cities().catch(() => []),
      fleetApi.slots().catch(() => []),
      // The model reviews per city come from the fleet's finished tasks; the
      // list is capped at 1000 rows, which a long window can reach.
      fleetApi.tasks({ state: 'done', since }).catch(() => []),
    ]).then(([stats, hits, fleet, prompt, cities, slots, done]) => ({ stats, hits, fleet, prompt, cities, slots, done }));
  }, 30_000);

  if (data === 'unavailable') return <UnavailableCard text={t('fbcNotConfigured')} />;
  const stats = data === null ? null : data.stats === 'unavailable' ? 'unavailable' : data.stats;
  const days = Array.isArray(stats) ? stats : [];

  return (
    <div className="fp-pool">
      <div className="fleet-tab-head">
        <p className="fleet-lede">{t('fleetAnalysisLede')}</p>
        <div className="page-actions">
          <div className="seg fleet-seg" role="group" aria-label={t('fleetRange')}>
            {FUNNEL_RANGES.map(r => (
              <button key={r} type="button" className={range === r ? 'active' : undefined} onClick={() => setRange(r)}>{t(`fleetFunnelRange_${r}`)}</button>
            ))}
          </div>
        </div>
      </div>
      <FlowCard fleet={data?.fleet ?? null} stats={stats} prompt={data?.prompt ?? null} onSaved={reload} range={range} />
      <div className="fleet-charts">
        <DayChart title={t('fleetChartReviewed')} sub={t('fleetChartReviewedSub')} series={data ? daySeries(days, 'reviewed', DAYS) : null} unavailable={stats === 'unavailable'}
          unit="reviewed" />
        <DayChart title={t('fleetChartAlerts')} sub={t('fleetChartAlertsSub')} series={data ? daySeries(days, 'alerted', DAYS) : null} unavailable={stats === 'unavailable'}
          unit="alerted" />
      </div>
      <section className="card fleet-card" aria-label={t('fleetHitsTitle')}>
        <div className="card-head">
          <div>
            <h2 className="card-title">{t('fleetHitsTitle')}</h2>
            <span className="card-sub">{t('fleetHitsSub', { days: DAYS })}</span>
          </div>
        </div>
        {data === null ? <TableSkeleton rows={5} cols={7} />
          : <HitsTable rows={alertsByCity(data.hits, data.done, data.cities, data.slots)} />}
      </section>
      <p className="fp-muted fleet-note">{t('fleetAnalysisNoFilter')}</p>
    </div>
  );
}

// ─── A per-day bar chart ──────────────────────────────────────────────────────
// One hue, thin bars with rounded tops, three gridlines, labels on the first,
// the highest and today's bar; today's bar is grey because the day is not
// over. Each bar carries its day and value on hover.

const W = 560;
const H = 150;
const PAD = { l: 40, r: 8, t: 18, b: 22 };

export function DayChart({ title, sub, series, unit, locale: localeOverride, unavailable = false }: {
  title: string; sub: string; series: DaySeries | null; unit: 'reviewed' | 'alerted'; locale?: string; unavailable?: boolean;
}) {
  const { t, locale: ctxLocale } = useT();
  const locale = localeOverride ?? ctxLocale;
  const fmt = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const top = series ? niceTop(series.max) : 1;
  const bw = (W - PAD.l - PAD.r) / DAYS;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / top);
  const dayLabel = (day: string, long: boolean) => new Date(day + 'T12:00:00Z').toLocaleDateString(locale, long
    ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'numeric', day: 'numeric' });
  return (
    <section className="card fleet-card fleet-chart-card" aria-label={title}>
      <div className="card-head">
        <div>
          <h2 className="card-title">{title}</h2>
          <span className="card-sub">{sub}</span>
        </div>
      </div>
      <div className="fleet-chart">
        {unavailable ? <p className="fp-muted">{t('fleetChartUnavailable')}</p> : series === null ? <Skeleton width="100%" height={150} /> : (
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
            {[0, top / 2, top].map(g => (
              <g key={g}>
                <line className="fleet-chart-grid" x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} />
                <text x={PAD.l - 6} y={y(g) + 3.5} textAnchor="end">{fmt.format(g)}</text>
              </g>
            ))}
            {series.points.map((p, i) => {
              const bx = PAD.l + i * bw + 3;
              const wd = bw - 6;
              const labelled = p.today || i === 0 || (i === series.points.findIndex(p => p.value === series.max) && series.max > 0);
              return (
                <g key={p.day}>
                  <path className={`fleet-chart-bar${p.today ? ' fleet-chart-bar-dim' : ''}`} d={barPath(bx, y(0), y(p.value), wd)}>
                    <title>{`${dayLabel(p.day, true)}: ${fmt.format(p.value)} ${t(`fleetChartUnit_${unit}`)}${p.today ? ` ${t('fleetChartSoFar')}` : ''}`}</title>
                  </path>
                  {labelled && <text className="fleet-chart-val" x={bx + wd / 2} y={y(p.value) - 5} textAnchor="middle">{fmt.format(p.value)}</text>}
                  {(i % 2 === 1 || p.today) && (
                    <text x={bx + wd / 2} y={H - 6} textAnchor="middle">{p.today ? t('fleetChartToday') : dayLabel(p.day, false)}</text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      {series && !unavailable && (
        <div className="fleet-chart-sum">
          <span>{t('fleetChartTotal', { days: DAYS })} <b>{fmt.format(series.total)}</b></span>
          <span>{t('fleetChartAverage')} <b>{fmt.format(series.fullDayAverage)}</b></span>
          <span>{t('fleetChartPartial')}</span>
        </div>
      )}
      {series && !unavailable && <details className="fleet-chart-data">
        <summary>{t('fleetChartTable')}</summary>
        <table className="fp-table">
          <thead><tr><th>{t('fleetChartDay')}</th><th className="num">{title}</th></tr></thead>
          <tbody>{series.points.map(p => <tr key={p.day}><td>{dayLabel(p.day, true)}{p.today ? ` · ${t('fleetChartSoFar')}` : ''}</td><td className="num">{fmt.format(p.value)}</td></tr>)}</tbody>
        </table>
      </details>}
    </section>
  );
}

// A bar rounded at its top and square on the baseline; a zero bar is a hairline.
function barPath(x: number, y0: number, y1: number, w: number): string {
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1, top + 1);
  const r = Math.min(3, w / 2, (bottom - top) / 2);
  return `M${x},${bottom} V${top + r} a${r},${r} 0 0 1 ${r},-${r} H${x + w - r} a${r},${r} 0 0 1 ${r},${r} V${bottom} Z`;
}

// ─── Alerts by city ───────────────────────────────────────────────────────────

export function HitsTable({ rows }: { rows: ReturnType<typeof alertsByCity> }) {
  const { t, locale } = useT();
  const dayLabel = (day: string) => new Date(day + 'T12:00:00Z').toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <div className="fp-table-wrap fleet-table-cap fleet-table-short">
      <table className="fp-table fleet-table">
        <thead>
          <tr>
            <th>{t('fleetColCity')}</th>
            <th>{t('fleetColRegion')}</th>
            <th className="num">{t('fleetColAlerts')}</th>
            <th className="num">{t('fleetColReviewed')}</th>
            <th className="num">{t('fleetColAlertRate')}</th>
            <th>{t('fleetColLastAlert')}</th>
            <th>{t('fleetColSearchedBy')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <EmptyRow cols={7}>{t('fleetHitsNone')}</EmptyRow>}
          {rows.map(r => (
            <tr key={r.slug}>
              <td><span className="fleet-city-name">{r.name}</span></td>
              <td className="fp-muted">{r.region ?? '—'}</td>
              <td className="num"><b>{r.alerts}</b></td>
              <td className="num">{r.reviewed ?? <span className="fp-muted">—</span>}</td>
              <td className="num">{r.rate === null ? <span className="fp-muted">—</span> : `${(r.rate * 100).toFixed(1)}%`}</td>
              <td className="fp-muted">{r.lastDay ? dayLabel(r.lastDay) : '—'}</td>
              <td>{r.homeWorker ? <><WorkerLink id={r.homeWorker} /> <small className="fp-muted">{t('fleetHitsHome')}</small></> : <span className="fp-muted">{t('fleetHitsWhoever')}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
