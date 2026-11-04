import { useEffect, useMemo, useState } from 'react';
import {
  PERF_WINDOWS,
  type PerfCompareRow, type PerfLoadRow, type PerfRouteRow, type PerfVersionRow, type PerfWindow,
} from '@recycle-erp/shared';
import { Icon } from '../../../components/Icon';
import { api } from '../../../lib/api';
import { useT } from '../../../lib/i18n';

const MAX_ROWS = 50;

// The global 1160px table minimum is wider than the Settings body, and would
// hide the right-hand columns behind a sideways scroll.
const TABLE = { minWidth: 0 } as const;
const TABLE_SCROLL = { maxHeight: 520 } as const;

const WINDOW_KEYS: Record<PerfWindow, string> = {
  '24h': 'perf.window_24h', '7d': 'perf.window_7d', '30d': 'perf.window_30d',
};

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function fmtTotal(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 1) return `${(ms / 1000).toFixed(1)} s`;
  return minutes < 60 ? `${minutes.toFixed(1)} min` : `${(minutes / 60).toFixed(1)} h`;
}

function P95Delta({ row }: { row: PerfCompareRow }) {
  if (!row.from || !row.to) return <>—</>;
  const delta = row.to.p95 - row.from.p95;
  if (delta === 0) return <>0 ms</>;
  const worse = delta > 0;
  return (
    <span style={{ color: worse ? 'var(--neg)' : 'var(--pos)' }}>
      {worse ? '+' : '−'}{fmtMs(Math.abs(delta))}
    </span>
  );
}

// Evidence for optimization work: where the time goes, what a page load costs,
// and whether a release moved either.
export function PerformancePanel() {
  const { t } = useT();
  const [perfWindow, setPerfWindow] = useState<PerfWindow>('7d');
  const [routes, setRoutes] = useState<PerfRouteRow[] | null>(null);
  const [loads, setLoads] = useState<PerfLoadRow[]>([]);
  const [versions, setVersions] = useState<PerfVersionRow[]>([]);
  const [hideMachine, setHideMachine] = useState(true);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [compare, setCompare] = useState<PerfCompareRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    Promise.all([
      api.get<{ routes: PerfRouteRow[] }>(`/api/perf/routes?window=${perfWindow}`),
      api.get<{ loads: PerfLoadRow[] }>(`/api/perf/loads?window=${perfWindow}`),
    ]).then(([r, l]) => {
      if (stale) return;
      setRoutes(r.routes);
      setLoads(l.loads);
      setError(null);
    }).catch((e: Error) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [perfWindow]);

  useEffect(() => {
    let stale = false;
    api.get<{ versions: PerfVersionRow[] }>('/api/perf/versions').then((r) => {
      if (stale) return;
      setVersions(r.versions);
      // Newest against the one before it: the question after most releases.
      setTo(r.versions[0]?.version ?? '');
      setFrom(r.versions[1]?.version ?? '');
    }).catch((e: Error) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, []);

  useEffect(() => {
    if (!from || !to || from === to) { setCompare(null); return; }
    let stale = false;
    const q = new URLSearchParams({ from, to });
    api.get<{ rows: PerfCompareRow[] }>(`/api/perf/compare?${q}`)
      .then((r) => { if (!stale) setCompare(r.rows); })
      .catch((e: Error) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [from, to]);

  const shownRoutes = useMemo(
    () => (routes ?? []).filter((r) => !hideMachine || !r.machine),
    [routes, hideMachine],
  );
  const shownCompare = useMemo(
    () => (compare ?? []).filter((r) => !hideMachine || !r.machine),
    [compare, hideMachine],
  );

  const versionOptions = versions.map((v) => (
    <option key={v.version} value={v.version}>v{v.version}</option>
  ));

  return (
    <>
      <div className="settings-header">
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>
            {t('perf.title')}
          </h2>
          <div style={{ fontSize: 13, color: 'var(--fg-subtle)', marginTop: 3 }}>
            {t('perf.panel_sub')}
          </div>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 14px', marginBottom: 'var(--gap)',
            background: 'var(--neg-soft)', color: 'var(--neg)',
            border: '1px solid color-mix(in oklch, var(--neg) 22%, transparent)',
            borderRadius: 'var(--radius)', fontSize: 13,
          }}
        >
          <Icon name="alert" size={15} />
          {error}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 'var(--gap)' }}>
        <div className="field" style={{ margin: 0 }}>
          <select
            className="select"
            aria-label={t('perf.window_label')}
            value={perfWindow}
            onChange={(e) => setPerfWindow(e.target.value as PerfWindow)}
          >
            {PERF_WINDOWS.map((w) => <option key={w} value={w}>{t(WINDOW_KEYS[w])}</option>)}
          </select>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={hideMachine} onChange={(e) => setHideMachine(e.target.checked)} />
          {t('perf.hide_machine')}
        </label>
        <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{t('perf.approximate')}</span>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{t('perf.routes_title')}</div>
            <div className="card-sub">{t('perf.routes_sub')}</div>
          </div>
        </div>
        {routes === null ? (
          <div className="card-body muted">{t('perf.loading')}</div>
        ) : shownRoutes.length === 0 ? (
          <div className="card-body muted">{t('perf.empty')}</div>
        ) : (
          <div className="table-scroll lb-scroll" style={TABLE_SCROLL}>
            <table className="table" style={TABLE}>
              <thead>
                <tr>
                  <th>{t('perf.col_route')}</th>
                  <th>{t('perf.col_total')}</th>
                  <th>{t('perf.col_requests')}</th>
                  <th>p50</th>
                  <th>p95</th>
                  <th>p99</th>
                  <th>{t('perf.col_max')}</th>
                  <th>{t('perf.col_errors')}</th>
                </tr>
              </thead>
              <tbody>
                {shownRoutes.slice(0, MAX_ROWS).map((r) => (
                  <tr key={r.route} className="row-hover">
                    <td className="mono">{r.route}</td>
                    <td className="mono">{fmtTotal(r.totalMs)}</td>
                    <td className="mono">{r.count.toLocaleString()}</td>
                    <td className="mono">{fmtMs(r.p50)}</td>
                    <td className="mono">{fmtMs(r.p95)}</td>
                    <td className="mono">{fmtMs(r.p99)}</td>
                    <td className="mono">{fmtMs(r.maxMs)}</td>
                    <td className="mono">{r.errorRate > 0 ? `${(r.errorRate * 100).toFixed(1)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 'var(--gap)' }}>
        <div className="card-head">
          <div>
            <div className="card-title">{t('perf.loads_title')}</div>
            <div className="card-sub">{t('perf.loads_sub')}</div>
          </div>
        </div>
        {loads.length === 0 ? (
          <div className="card-body muted">{t('perf.empty')}</div>
        ) : (
          <div className="table-scroll lb-scroll" style={TABLE_SCROLL}>
            <table className="table" style={TABLE}>
              <thead>
                <tr>
                  <th>{t('perf.col_page')}</th>
                  <th>{t('perf.col_shell')}</th>
                  <th>{t('perf.col_loads')}</th>
                  <th>LCP p50</th>
                  <th>LCP p75</th>
                  <th>LCP p95</th>
                  <th>{t('perf.col_load_p75')}</th>
                  <th>TTFB p75</th>
                </tr>
              </thead>
              <tbody>
                {loads.map((l) => (
                  <tr key={`${l.shell}|${l.page}`} className="row-hover">
                    <td className="mono">{l.page}</td>
                    <td>{l.shell}</td>
                    <td className="mono">{l.count.toLocaleString()}</td>
                    <td className="mono">{fmtMs(l.lcpP50)}</td>
                    <td className="mono">{fmtMs(l.lcpP75)}</td>
                    <td className="mono">{fmtMs(l.lcpP95)}</td>
                    <td className="mono">{fmtMs(l.loadP75)}</td>
                    <td className="mono">{fmtMs(l.ttfbP75)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 'var(--gap)' }}>
        <div className="card-head">
          <div>
            <div className="card-title">{t('perf.compare_title')}</div>
            <div className="card-sub">{t('perf.compare_sub')}</div>
          </div>
          {versions.length >= 2 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <select className="select" aria-label={t('perf.compare_from')} value={from} onChange={(e) => setFrom(e.target.value)}>
                {versionOptions}
              </select>
              <Icon name="arrow" size={14} />
              <select className="select" aria-label={t('perf.compare_to')} value={to} onChange={(e) => setTo(e.target.value)}>
                {versionOptions}
              </select>
            </div>
          )}
        </div>
        {versions.length < 2 ? (
          <div className="card-body muted">{t('perf.compare_need_two')}</div>
        ) : from === to ? (
          <div className="card-body muted">{t('perf.compare_same')}</div>
        ) : shownCompare.length === 0 ? (
          <div className="card-body muted">{t('perf.empty')}</div>
        ) : (
          <div className="table-scroll lb-scroll" style={TABLE_SCROLL}>
            <table className="table" style={TABLE}>
              <thead>
                <tr>
                  <th>{t('perf.col_route')}</th>
                  <th>{t('perf.col_requests')}</th>
                  <th>{t('perf.col_p50_change')}</th>
                  <th>{t('perf.col_p95_change')}</th>
                  <th>{t('perf.col_p95_delta')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shownCompare.slice(0, MAX_ROWS).map((r) => (
                  <tr key={r.route} className="row-hover">
                    <td className="mono">{r.route}</td>
                    <td className="mono">{(r.from?.count ?? 0).toLocaleString()} → {(r.to?.count ?? 0).toLocaleString()}</td>
                    <td className="mono">{fmtMs(r.from?.p50)} → {fmtMs(r.to?.p50)}</td>
                    <td className="mono">{fmtMs(r.from?.p95)} → {fmtMs(r.to?.p95)}</td>
                    <td className="mono"><P95Delta row={r} /></td>
                    <td>{r.lowSample && <span className="chip muted">{t('perf.low_sample')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
