import { useMemo, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { TableSkeleton } from '../../../components/Skeleton';
import { handleFetchError, showSuccessToast } from '../../../lib/errorToast';
import { poolApi, proxyMarkFor, type FbProxyMark } from '../../../lib/facebookPool';
import {
  FLEET_PROXY_BUCKET_MS, FLEET_PROXY_SLOW_MS, fleetApi,
  type FleetProxyHealth, type FleetProxyHealthAnswer, type FleetProxyHealthState, type FleetProxySource,
} from '../../../lib/fleet';
import { useT } from '../../../lib/i18n';
import { ProxyDeadChip } from '../FleetWorkers';
import { easternClock } from './fleetBoard';
import { agoLabel, Clock, EmptyRow, Legend, UnavailableCard, useFleetMirror, useFleetPoll, WorkerLink } from './shared';

// ─── Proxies ──────────────────────────────────────────────────────────────────
// Every proxy port the fleet browses through: the ERP's list, and the ports
// the homelab workers dial (rs_console checks those, since it holds their
// logins). The backend checks each through itself every five minutes and
// keeps the answers, so a row says how the port answers now and how it did
// over the day. Editing the list stays in Account pool ▸ Proxies.

const STATES = ['up', 'degraded', 'down', 'unchecked'] as const;
const STATE_CHIP: Record<FleetProxyHealthState, string> = { up: 'chip pos', degraded: 'chip warn', down: 'chip neg', unchecked: 'chip muted' };
const STATE_KEY: Record<FleetProxyHealthState | 'all', string> = {
  all: 'fleetSegAll', up: 'fleetProxyUp', degraded: 'fleetProxyDegraded', down: 'fleetProxyDown', unchecked: 'fleetProxyUnchecked',
};
const STATE_DOT: Record<FleetProxyHealthState | 'all', string> = {
  all: 'fleet-dot-all', up: 'fleet-dot-pos', degraded: 'fleet-dot-warn', down: 'fleet-dot-neg', unchecked: 'fleet-dot-all',
};
const SOURCE_KEY: Record<FleetProxySource, string> = { erp: 'fleetProxySourceErp', coordinator: 'fleetProxySourceCoordinator' };
// Down first: the row that needs a hand is the one to see.
const STATE_ORDER: Record<FleetProxyHealthState, number> = { down: 0, degraded: 1, unchecked: 2, up: 3 };

type Data = { health: FleetProxyHealthAnswer; marks: FbProxyMark[] | null };
type Filter = { state: FleetProxyHealthState | 'all'; source: FleetProxySource | ''; q: string };

/** Whether a row matches the search box: label, host:port, exit, city, worker or account. */
export function proxyMatches(p: FleetProxyHealth, q: string): boolean {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = [
    p.label, p.exit, `${p.host}:${p.port}`, p.last?.exit_ip, p.last?.city, p.last?.region, p.last?.org, p.previous_ip,
    ...p.workers, ...p.slots.map(s => `#${s.account_no}`),
  ].filter(Boolean).join(' ').toLowerCase();
  return terms.every(term => hay.includes(term));
}

export function FleetProxiesTab() {
  const { t } = useT();
  const mirror = useFleetMirror();
  const { data, reload } = useFleetPoll<Data>(() => Promise.all([
    fleetApi.proxyHealth(),
    // The failed-account marks are the pool's; the table stands without them.
    poolApi.proxies().then(r => r.proxies).catch(() => null),
  ]).then(([health, marks]) => ({ health, marks })));
  const [busy, setBusy] = useState<number | 'all' | null>(null);
  const [filter, setFilter] = useState<Filter>({ state: 'all', source: '', q: '' });

  if (data === 'unavailable') return <UnavailableCard text={t('fleetNotServed')} />;
  const health = data?.health;
  const rows = health?.proxies ?? [];
  const count = (s: FleetProxyHealthState) => rows.filter(p => p.state === s).length;

  const check = async (id?: number) => {
    if (busy !== null) return;
    setBusy(id ?? 'all');
    try {
      const answer = await fleetApi.checkProxies(id);
      showSuccessToast(t('fleetProxyChecked', { n: id === undefined ? answer.proxies.length : 1 }));
      reload();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fp-pool">
      <div className="fleet-tab-head">
        <p className="fleet-lede">
          {health && (health.round_at
            ? t('fleetProxiesLede', { n: rows.length, up: count('up'), degraded: count('degraded'), down: count('down'), ago: agoLabel(t, health.round_at) })
            : t('fleetProxiesLedeNever', { n: rows.length }))}
        </p>
        {!mirror && (
          <div className="page-actions">
            <button type="button" className="btn primary" onClick={() => check()} disabled={!health || busy !== null}>
              <Icon name="refresh" size={14} />{t('fleetProxyCheckAll')}
            </button>
          </div>
        )}
      </div>
      {health?.coordinator === 'unsupported' && <UnavailableCard text={t('fleetProxyCoordUnsupported')} />}
      {health?.coordinator === 'unreachable' && <UnavailableCard text={t('fleetProxyCoordUnreachable')} />}
      <section className="card fleet-card" aria-label={t('fleetProxiesTitle')}>
        {data === null ? <TableSkeleton rows={6} cols={8} />
          : <ProxiesHealthTable rows={rows} marks={data.marks} filter={filter} onFilter={setFilter} busy={busy} onCheck={mirror ? undefined : check} />}
      </section>
    </div>
  );
}

export function ProxiesHealthTable({ rows, marks, filter, onFilter, busy, onCheck, now = Date.now() }: {
  rows: readonly FleetProxyHealth[]; marks: readonly FbProxyMark[] | null; filter: Filter; onFilter: (f: Filter) => void;
  // Without one the rows carry no check button: a mirror's checks are prod's.
  busy: number | 'all' | null; onCheck?: (id?: number) => void; now?: number;
}) {
  const { t, locale } = useT();
  const counts = useMemo(() => {
    const out = { all: rows.length, up: 0, degraded: 0, down: 0, unchecked: 0 };
    for (const p of rows) out[p.state] += 1;
    return out;
  }, [rows]);
  const sources = useMemo(() => [...new Set(rows.map(p => p.source))], [rows]);
  const shown = useMemo(() => rows
    .filter(p => (filter.state === 'all' || p.state === filter.state) && (!filter.source || p.source === filter.source) && proxyMatches(p, filter.q))
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.source.localeCompare(b.source) || a.exit.localeCompare(b.exit)),
  [rows, filter]);
  const set = (patch: Partial<Filter>) => onFilter({ ...filter, ...patch });
  const cols = 8;

  return (
    <>
      <div className="fp-toolbar fleet-toolbar">
        <Legend buckets={STATES} counts={counts} value={filter.state} onChange={state => set({ state })}
          label={k => t(STATE_KEY[k])} dotClass={k => STATE_DOT[k]} />
        {sources.length > 1 && (
          <select className="input fleet-select" value={filter.source} aria-label={t('fleetEverySource')}
            onChange={e => set({ source: e.target.value as Filter['source'] })}>
            <option value="">{t('fleetEverySource')}</option>
            {sources.map(s => <option key={s} value={s}>{t(SOURCE_KEY[s])}</option>)}
          </select>
        )}
        <label className="toolbar-search">
          <Icon name="search" size={14} />
          <input className="input" type="search" value={filter.q} autoComplete="off" placeholder={t('fleetSearchProxies')}
            aria-label={t('fleetSearchProxies')} onChange={e => set({ q: e.target.value })} />
        </label>
      </div>
      <div className="fp-table-wrap fleet-table-cap fleet-table-tall">
        <table className="fp-table fleet-table fleet-proxies">
          <thead>
            <tr>
              <th>{t('fleetColProxyPort')}</th>
              <th>{t('fleetColHealth')}</th>
              <th className="num">{t('fleetColLatency')}</th>
              <th>{t('fleetColExit')}</th>
              <th>{t('fleetColDay')}</th>
              <th>{t('fleetColChecked')}</th>
              <th>{t('fleetColUsedBy')}</th>
              <th aria-label={t('fleetColActions')} />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <EmptyRow cols={cols}>{rows.length === 0 ? t('fleetProxiesNone') : t('fleetProxiesNoMatch')}</EmptyRow>}
            {shown.map(p => {
              const mark = proxyMarkFor(marks, { proxy: { url: p.exit } });
              const last = p.last;
              const where = last ? [last.city, last.region, last.country].filter(Boolean).join(', ') : '';
              const rowBusy = busy === 'all' || (p.proxy_id !== null && busy === p.proxy_id);
              return (
                <tr key={`${p.source}:${p.proxy_id ?? p.exit}`}>
                  <td>
                    <span className="fp-holder">
                      <span>
                        {p.label ?? <span className="mono">{`${p.host}:${p.port}`}</span>} <span className="chip muted">{t(SOURCE_KEY[p.source])}</span>
                      </span>
                      {p.label && <small className="mono">{`${p.host}:${p.port}`}</small>}
                    </span>
                  </td>
                  <td>
                    <span className="fp-holder">
                      <span>
                        <span className={STATE_CHIP[p.state]}>{t(STATE_KEY[p.state])}</span>
                        {mark?.dead && <> <ProxyDeadChip mark={mark} /></>}
                      </span>
                      {p.state === 'degraded' && <small className="fp-warn">
                        {last?.ok ? t('fleetProxyDegradedSlow', { s: FLEET_PROXY_SLOW_MS / 1000 }) : t('fleetProxyDegradedMissed')}
                      </small>}
                      {last && !last.ok && <small className="fp-warn">{last.error}</small>}
                    </span>
                  </td>
                  <td className="num mono">{last?.latency_ms != null && last.ok ? `${last.latency_ms} ms` : '—'}</td>
                  <td>
                    {last?.exit_ip ? (
                      <span className="fp-holder">
                        <span className="mono" title={last.org ?? undefined}>{last.exit_ip}</span>
                        <small>
                          {where || '—'}
                          {p.previous_ip && <> · <span className="fp-warn" title={t('fleetProxyIpChangedHint')}>{t('fleetProxyIpChanged', { ip: p.previous_ip })}</span></>}
                        </small>
                      </span>
                    ) : <span className="fp-muted">—</span>}
                  </td>
                  <td>
                    <span className="fp-holder">
                      <DayStrip buckets={p.buckets} now={now} locale={locale} />
                      <small>{p.uptime === null ? '—' : t('fleetProxyUptime', { pct: Math.round(p.uptime * 1000) / 10, n: p.checks })}</small>
                    </span>
                  </td>
                  <td><Clock at={last?.at} now={now} /></td>
                  <td>
                    {p.slots.length > 0 && (
                      <span className="fp-holder">{p.slots.map(s => (
                        <small key={s.account_no}>{t('fleetAccountN', { no: s.account_no })}{s.parked && ` · ${t('fleetProxyParked')}`}</small>
                      ))}</span>
                    )}
                    {p.workers.length > 0 && <span className="fleet-proxy-workers">{p.workers.map(w => <WorkerLink key={w} id={w} />)}</span>}
                    {!p.slots.length && !p.workers.length && <span className="fp-muted">{t('fleetProxyNobody')}</span>}
                  </td>
                  <td className="fleet-row-actions">
                    {onCheck && (
                      <button type="button" className="btn ghost icon sm" onClick={() => onCheck(p.proxy_id ?? undefined)}
                        disabled={busy !== null || p.proxy_id === null} aria-busy={rowBusy}
                        title={p.proxy_id === null ? t('fleetProxyCheckOneHomelab') : t('fleetProxyCheckOne')} aria-label={t('fleetProxyCheckOne')}>
                        <Icon name="refresh" size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** The day in half-hour buckets, oldest first, each in its worst state. */
function DayStrip({ buckets, now, locale }: { buckets: FleetProxyHealth['buckets']; now: number; locale: string }) {
  const { t } = useT();
  const n = buckets.length;
  return (
    <span className="fleet-proxy-strip" role="img" aria-label={t('fleetColDay')}>
      {buckets.map((b, i) => {
        const time = easternClock(new Date(now - (n - 1 - i) * FLEET_PROXY_BUCKET_MS).toISOString(), locale, now);
        return <i key={i} className={b ? `is-${b}` : undefined}
          title={b ? t('fleetProxyBucket', { time, state: t(STATE_KEY[b]) }) : t('fleetProxyBucketNone', { time })} />;
      })}
    </span>
  );
}
