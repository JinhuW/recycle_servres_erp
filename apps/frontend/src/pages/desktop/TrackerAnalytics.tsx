import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Skeleton } from '../../components/Skeleton';
import { nextSort, SortTh, type SortState } from '../../components/SortTh';
import { useT } from '../../lib/i18n';
import { usePersisted } from '../../lib/listMemory';
import { useElementWidth } from '../../lib/useElementWidth';
import {
  ANALYTICS_WINDOWS,
  trackerApi,
  type AnalyticsWindow,
  type TrackerAnalytics,
  type TrackerListedPost,
} from '../../lib/tracker';
import { niceTop } from './fleet/fleetBoard';
import '../../styles/fleet.css';

// ─── How the tracker is doing ─────────────────────────────────────────────────
// Two judges score the alerts. Buyers react: any emoji but 👎 is a good catch.
// The market answers too: a day after a post goes up, the tracer counts the
// buyers who commented "PM". A memory post with that many PMs and no good-catch
// reaction is "missing", a lead the tracker let through. PM numbers cover the
// same span shifted back a day, since a post is only traced once a day old.

const REFRESH_MS = 60_000;

type Props = { locale: string };

export function AnalyticsCard({ locale }: Props) {
  const { t } = useT();
  const [win, setWin] = useState<AnalyticsWindow>('7d');
  const [data, setData] = useState<TrackerAnalytics | 'unavailable' | null>(null);

  const load = useCallback(() => {
    trackerApi.analytics(win).then(setData).catch(() => setData('unavailable'));
  }, [win]);

  useEffect(() => {
    setData(null);
    load();
    const refresh = () => { if (!document.hidden) load(); };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  const a = data && data !== 'unavailable' ? data : null;

  return (
    <>
      <section className="card rt-analytics" aria-label={t('trkAnTitle')} aria-busy={!data}>
        <div className="card-head">
          <div>
            <h2 className="card-title">{t('trkAnTitle')}</h2>
            <span className="card-sub">{t('trkAnSub')}</span>
          </div>
          <div className="seg" role="tablist" aria-label={t('trkAnWindow')}>
            {ANALYTICS_WINDOWS.map(w => (
              <button key={w} type="button" role="tab" aria-selected={win === w}
                className={win === w ? 'active' : ''} onClick={() => setWin(w)}>
                {t(`trkAnWindow_${w}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="card-body rt-an-body">
          {data === 'unavailable'
            ? <p className="fp-muted rt-note">{t('trkAnUnavailable')}</p>
            : <Body a={a} locale={locale} />}
        </div>
      </section>
      {data !== 'unavailable' && <MissedCard a={a} locale={locale} />}
    </>
  );
}

// The leads the tracker let through get their own card, under the same window.
function MissedCard({ a, locale }: { a: TrackerAnalytics | null; locale: string }) {
  const { t } = useT();
  const fmt = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), [locale]);
  const pct = useMemo(() => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }), [locale]);
  const share = (part: number, whole: number) => (whole > 0 ? pct.format(part / whole) : '—');
  return (
    <section className="card rt-analytics" aria-label={t('trkAnMissedTitle')} aria-busy={!a}>
      <div className="card-head">
        <div>
          <h2 className="card-title">{t('trkAnMissedTitle')}</h2>
          <span className="card-sub">{t('trkAnMissedSub', { pms: a?.hotPms ?? 5, window: a ? t(`trkAnWindow_${a.window}`) : '…' })}</span>
        </div>
        {a && <span className={`mono rt-an-missed-count${a.demand.missing > 0 ? ' rt-an-bad' : ''}`}>
          {t('trkAnMissedCount', { n: fmt.format(a.demand.missing), hot: fmt.format(a.demand.hotMemory) })}
        </span>}
      </div>
      <div className="card-body rt-an-body">
        <div className="rt-an-panel">
          <div className="fp-section-label">{t('trkAnMissingTitle', { pms: a?.hotPms ?? 5 })}</div>
          <PostsTable sortKey="missing" posts={a?.missing ?? null} empty={t('trkAnMissingNone')} showReason locale={locale} />
        </div>

        <div className="rt-an-panel">
          <div className="fp-section-label">{t('trkAnSubreddits')}</div>
          <SubredditsTable a={a} fmt={fmt} share={share} />
        </div>

        {a && a.hotOther.length > 0 && (
          <details className="rt-an-panel rt-an-other">
            <summary className="fp-section-label">{t('trkAnHotOther', { n: a.hotOther.length })}</summary>
            <PostsTable sortKey="other" posts={a.hotOther} empty="" locale={locale} />
          </details>
        )}
      </div>
    </section>
  );
}

// Click cycles desc → asc → the order the tracker sent. Blanks sort last.
function useSort(key: string): [SortState, (col: string) => void] {
  const [sort, setSort] = usePersisted<SortState>(`desktop.tracker.analytics.${key}.sort`, { col: '', dir: null });
  const cycle = (col: string) => setSort(s => nextSort(s, col));
  return [sort, cycle];
}

function sortRows<T>(rows: T[], sort: SortState, value: (row: T, col: string) => string | number | null): T[] {
  if (!sort.dir) return rows;
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((x, y) => {
    const a = value(x, sort.col);
    const b = value(y, sort.col);
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    return sign * (typeof a === 'string' ? a.localeCompare(b as string) : a - (b as number));
  });
}

function Body({ a, locale }: { a: TrackerAnalytics | null; locale: string }) {
  const { t } = useT();
  const fmt = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), [locale]);
  const pct = useMemo(() => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }), [locale]);
  const share = (part: number, whole: number) => (whole > 0 ? pct.format(part / whole) : '—');
  const minutes = (m: number | null) => (m === null ? '—' : t('trkAnMinutes', { n: fmt.format(m) }));
  const day = (iso: string) => new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' });

  const kpis: Array<{ label: string; value: string | null; sub?: string; tone?: 'bad' }> = a ? [
    { label: t('trkAnKpiAlerts'), value: fmt.format(a.volume.alerts),
      sub: t('trkAnKpiAlertsSub', { n: fmt.format(a.volume.alertsPerDay), posts: fmt.format(a.volume.posts) }) },
    { label: t('trkAnKpiGood'), value: share(a.feedback.good, a.feedback.alerts),
      sub: t('trkAnKpiGoodSub', { good: a.feedback.good, bad: a.feedback.bad, none: a.feedback.unreacted }) },
    { label: t('trkAnKpiMissing'), value: fmt.format(a.demand.missing), tone: a.demand.missing > 0 ? 'bad' : undefined,
      sub: t('trkAnKpiMissingSub', { hot: a.demand.hotMemory, pms: a.hotPms }) },
    { label: t('trkAnKpiSpeed'), value: minutes(a.speed.medianMinutes),
      sub: t('trkAnKpiSpeedSub', { p90: minutes(a.speed.p90Minutes) }) },
    { label: t('trkAnKpiDuplicates'), value: fmt.format(a.volume.duplicates), sub: t('trkAnKpiDuplicatesSub') },
  ] : Array.from({ length: 5 }, () => ({ label: '', value: null }));

  return (
    <>
      <div className="rt-an-kpis">
        {kpis.map((k, i) => (
          <div key={i} className={`kpi rt-an-kpi${k.tone === 'bad' ? ' rt-an-bad' : ''}`}>
            <div className="kpi-label">{k.value === null ? <Skeleton width={80} height={12} /> : k.label}</div>
            <div className="kpi-value mono">{k.value ?? <Skeleton width={50} height={24} />}</div>
            {k.sub && <div className="rt-an-kpi-sub">{k.sub}</div>}
          </div>
        ))}
      </div>

      <AlertsChart a={a} locale={locale} />

      <div className="rt-an-split">
        <div className="rt-an-panel">
          <div className="fp-section-label">{t('trkAnDemand')}</div>
          {a ? <>
            <p className="fp-muted rt-help">
              {t('trkAnDemandRange', { from: day(a.demandRange.since), to: day(a.demandRange.until) })}
            </p>
            <dl className="rt-an-facts">
              <dt>{t('trkAnTraced')}</dt>
              <dd className="mono">{t('trkPromptOf', { x: fmt.format(a.demand.traced), n: fmt.format(a.demand.posts) })}</dd>
              <dt>{t('trkAnHot', { pms: a.hotPms })}</dt><dd className="mono">{fmt.format(a.demand.hotMemory)}</dd>
              <dt>{t('trkAnCaught')}</dt><dd className="mono">{fmt.format(a.demand.caught)}</dd>
              <dt>{t('trkAnAlertedNoReaction')}</dt><dd className="mono">{fmt.format(a.demand.alertedNoReaction)}</dd>
              <dt>{t('trkAnNotAlerted')}</dt><dd className="mono">{fmt.format(a.demand.notAlerted)}</dd>
              <dt>{t('trkAnAvgPms')}</dt>
              <dd className="mono">{t('trkAnAvgPmsVal', {
                alerted: a.demand.avgPmsAlerted === null ? '—' : fmt.format(a.demand.avgPmsAlerted),
                rejected: a.demand.avgPmsRejected === null ? '—' : fmt.format(a.demand.avgPmsRejected),
              })}</dd>
            </dl>
            <p className="fp-muted rt-help">
              {a.tracer ? t('trkAnTracer', { worker: a.tracer.workerId }) : t('trkAnNoTracer')}
            </p>
          </> : <Skeleton width="100%" height={140} />}
        </div>
        <div className="rt-an-panel">
          <div className="fp-section-label">{t('trkAnPrompts')}</div>
          <PromptsTable a={a} fmt={fmt} share={share} />
        </div>
      </div>
    </>
  );
}

const H = 150;
const PAD = { l: 34, r: 8, t: 16, b: 22 };

function AlertsChart({ a, locale }: { a: TrackerAnalytics | null; locale: string }) {
  const { t } = useT();
  const fmt = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const wrap = useRef<HTMLDivElement>(null);
  const W = Math.max(useElementWidth(wrap), 200);
  if (!a) return <div className="fleet-chart" ref={wrap}><Skeleton width="100%" height={150} /></div>;
  const points = a.series.points;
  const top = niceTop(Math.max(...points.map(p => p.alerts), 0));
  const bw = (W - PAD.l - PAD.r) / points.length;
  const y = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / top);
  const hourly = a.series.bucket === 'hour';
  const label = (iso: string) => new Date(iso).toLocaleString(locale, hourly
    ? { hour: 'numeric' } : { month: 'numeric', day: 'numeric' });
  const every = Math.ceil(points.length / Math.max(Math.floor(W / 90), 2));
  return (
    <div className="fleet-chart rt-an-chart" ref={wrap}>
      <div className="rt-an-legend">
        <span><i className="rt-an-swatch fleet-chart-bar" />{t('trkAnChartAlerts')}</span>
        <span><i className="rt-an-swatch rt-an-good" />{t('trkAnChartGood')}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('trkAnChartAlerts')}>
        {[0, top / 2, top].map(g => (
          <g key={g}>
            <line className="fleet-chart-grid" x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)} />
            <text x={PAD.l - 6} y={y(g) + 3.5} textAnchor="end">{fmt.format(g)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const bx = PAD.l + i * bw + 2;
          const wd = Math.max(bw - 4, 1);
          return (
            <g key={p.until}>
              <rect className="fleet-chart-bar" x={bx} width={wd} y={y(p.alerts)} height={Math.max(y(0) - y(p.alerts), 1)} rx={2}>
                <title>{t('trkAnChartTip', { at: label(p.until), alerts: p.alerts, good: p.good, posts: p.posts })}</title>
              </rect>
              {p.good > 0 && <rect className="rt-an-good" x={bx} width={wd} y={y(p.good)} height={y(0) - y(p.good)} rx={2} />}
              {(i % every === every - 1) && (
                <text x={bx + wd / 2} y={H - 6} textAnchor="middle">{label(p.until)}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function PromptsTable({ a, fmt, share }: {
  a: TrackerAnalytics | null; fmt: Intl.NumberFormat; share: (x: number, n: number) => string;
}) {
  const { t } = useT();
  return (
    <div className="fp-table-wrap">
      <table className="fp-table rt-an-table">
        <thead>
          <tr>
            <th>{t('trkPromptColVersion')}</th>
            <th className="num">{t('trkPromptColJudged')}</th>
            <th className="num">{t('trkPromptColFlagged')}</th>
            <th className="num">{t('trkAnColGood')}</th>
            <th className="num" title={t('trkAnColRecallHint', { pms: a?.hotPms ?? 5 })}>{t('trkAnColRecall')}</th>
          </tr>
        </thead>
        <tbody>
          {!a && <tr><td colSpan={5}><Skeleton width="100%" height={12} /></td></tr>}
          {a?.prompts.length === 0 && <tr><td colSpan={5} className="fp-muted">{t('trkAnNone')}</td></tr>}
          {a?.prompts.map(p => (
            <tr key={p.versionId} className={p.role === 'retired' ? 'rt-retired' : undefined}>
              <td>
                <b className="mono">v{p.versionId}</b>{' '}
                {p.role !== 'retired' && <span className={`fp-chip ${p.role === 'live' ? 'ff-live' : 'ff-stale'}`}>{t(`trkPromptRole_${p.role}`)}</span>}
                <span className="mono fp-muted rt-model"> {p.model}</span>
              </td>
              <td className="num mono">{fmt.format(p.judged)}</td>
              <td className="num mono">{fmt.format(p.flagged)}</td>
              <td className="num mono">{t('trkAnGoodBad', { good: p.good, bad: p.bad })}</td>
              <td className="num mono">{p.hotMemoryJudged > 0
                ? `${t('trkPromptOf', { x: p.hotMemoryFlagged, n: p.hotMemoryJudged })} (${share(p.hotMemoryFlagged, p.hotMemoryJudged)})`
                : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SubredditsTable({ a, fmt, share }: {
  a: TrackerAnalytics | null; fmt: Intl.NumberFormat; share: (x: number, n: number) => string;
}) {
  const { t } = useT();
  const [sort, onSort] = useSort('subreddits');
  const rows = sortRows(a?.subreddits ?? [], sort, (s, col) => {
    switch (col) {
      case 'name': return s.name;
      case 'posts': return s.posts;
      case 'memory': return s.memoryPosts;
      case 'alerts': return s.alerts;
      case 'good': return s.alerts > 0 ? s.good / s.alerts : null;
      case 'avgPms': return s.avgPms;
      case 'hot': return s.hotMemory;
      default: return s.missing;
    }
  });
  const th = (col: string, label: string, title?: string) =>
    <SortTh col={col} sort={sort} onSort={onSort} align={col === 'name' ? undefined : 'right'} title={title}>{label}</SortTh>;
  return (
    <div className="fp-table-wrap rt-an-cap">
      <table className="fp-table rt-an-table">
        <thead>
          <tr>
            {th('name', t('trkAnColSub'))}
            {th('posts', t('trkAnColPosts'))}
            {th('memory', t('trkAnColMemory'))}
            {th('alerts', t('trkAnChartAlerts'))}
            {th('good', t('trkAnColGoodRate'))}
            {th('avgPms', t('trkAnColAvgPms'), t('trkAnColAvgPmsHint'))}
            {th('hot', t('trkAnColHot', { pms: a?.hotPms ?? 5 }))}
            {th('missing', t('trkAnKpiMissing'))}
          </tr>
        </thead>
        <tbody>
          {!a && <tr><td colSpan={8}><Skeleton width="100%" height={12} /></td></tr>}
          {rows.map(s => (
            <tr key={s.name}>
              <td className="mono">r/{s.name}</td>
              <td className="num mono">{fmt.format(s.posts)}</td>
              <td className="num mono">{fmt.format(s.memoryPosts)}</td>
              <td className="num mono">{fmt.format(s.alerts)}</td>
              <td className="num mono">{share(s.good, s.alerts)}</td>
              <td className="num mono">{s.avgPms === null ? '—' : fmt.format(s.avgPms)}</td>
              <td className="num mono">{fmt.format(s.hotMemory)}</td>
              <td className={`num mono${s.missing > 0 ? ' rt-an-bad' : ''}`}>{fmt.format(s.missing)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PostsTable({ sortKey, posts, empty, showReason = false, locale }: {
  sortKey: string; posts: TrackerListedPost[] | null; empty: string; showReason?: boolean; locale: string;
}) {
  const { t } = useT();
  const [sort, onSort] = useSort(sortKey);
  const rows = sortRows(posts ?? [], sort, (p, col) => {
    switch (col) {
      case 'post': return p.title;
      case 'sub': return p.subreddit;
      case 'alerted': return p.alerted ? 1 : 0;
      case 'posted': return Date.parse(p.postedAt);
      default: return p.pmCount;
    }
  });
  const cols = showReason ? 6 : 5;
  return (
    <div className="fp-table-wrap rt-an-cap">
      <table className="fp-table rt-an-table">
        <thead>
          <tr>
            <SortTh col="post" sort={sort} onSort={onSort}>{t('trkAnColPost')}</SortTh>
            <SortTh col="sub" sort={sort} onSort={onSort}>{t('trkAnColSub')}</SortTh>
            <SortTh col="pms" sort={sort} onSort={onSort} align="right">{t('trkAnColPms')}</SortTh>
            <SortTh col="alerted" sort={sort} onSort={onSort}>{t('trkAnColAlerted')}</SortTh>
            {showReason && <th>{t('trkAnColWhy')}</th>}
            <SortTh col="posted" sort={sort} onSort={onSort}>{t('trkAnColPosted')}</SortTh>
          </tr>
        </thead>
        <tbody>
          {posts === null && <tr><td colSpan={cols}><Skeleton width="100%" height={12} /></td></tr>}
          {posts?.length === 0 && <tr><td colSpan={cols} className="fp-muted">{empty}</td></tr>}
          {rows.map(p => (
            <tr key={p.redditId}>
              <td className="rt-an-post">
                <a href={p.url} target="_blank" rel="noreferrer">{p.title}</a>
              </td>
              <td className="mono fp-muted">r/{p.subreddit}</td>
              <td className="num mono">{p.pmCount}</td>
              <td>{p.alerted ? t('trkAnAlertedYes') : t('trkAnAlertedNo')}</td>
              {showReason && <td className="fp-muted rt-an-why">{p.reasoning ?? '—'}</td>}
              <td className="fp-muted">{new Date(p.postedAt).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
