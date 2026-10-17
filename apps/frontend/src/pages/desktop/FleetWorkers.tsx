import { Fragment, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Skeleton } from '../../components/Skeleton';
import type { AlertHitRow, Challenge, FleetAccount, FleetDoc } from '../../lib/coordinator';
import {
  accountAlerts, accountHaystack, attentionReason, dayStrip, FLEET_STATUSES, fleetActivity, fleetPostsToday, fleetStatus,
  hitsByCity, isUnstampedBuild, matchesTerms, parkedWorkers, queryTerms, searchedToday, whoIs, type CityHits, type DayStrip, type FleetStatus,
} from '../../lib/fleetView';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import type { Translate } from '../../lib/orderPresentation';
import { fleetWorkerPath, hrefFor, onLinkClick } from '../../lib/route';
import { CityChip, fmtDays, Hi, HITS_DAYS, stateLabel } from './FleetAccounts';
import '../../styles/facebookPool.css';

// ─── Fleet list ───────────────────────────────────────────────────────────────
// The Fleet tab in the Account pool's chrome: a status legend that filters, a
// table of workers that fits beside the activity aside, a fold per row with
// the worker's cities, and the eye — the one way to a worker's
// page, where every edit lives. Rows themselves do not navigate.

export const STATUS_KEY: Record<FleetStatus, string> = {
  live: 'fbcStatusLive', stale: 'fbcStatusStale', attention: 'fbcStatusAttention', offline: 'fbcStatusOffline',
};

export function StatusChip({ status }: { status: FleetStatus }) {
  const { t } = useT();
  return <span className={`fp-chip ff-${status}`}><i className="fp-dot" />{t(STATUS_KEY[status])}</span>;
}

// Why a worker is in the attention bucket, or how close its session is to
// lapsing: the small line under its status chip.
export function statusNote(t: Translate, w: FleetAccount, parked: ReadonlySet<string>, locale: string): string | null {
  if (parked.has(w.worker_id)) return t('fbcNoteCheckpoint');
  const h = w.health;
  if (!h) return t('fbcNotDeployed');
  if (h.liveness === 'unknown') return t('fbcNeverReported');
  const r = attentionReason(w);
  if (r.kind === 'dead') return t('fbcNoteSilent', { age: r.since ? relTime(r.since, locale) : t('fbcNever') });
  if (r.kind === 'state') return stateLabel(t, r.state);
  if (r.kind === 'expired') return t('fbcSessionExpired');
  if (h.session_days_left !== null && h.session_days_left <= 7) return t('fbcNoteExpiring', { days: fmtDays(t, h.session_days_left) });
  return null;
}

export function FleetLegend({ counts, loading, filter, onFilter }: {
  counts: Record<FleetStatus, number>;
  loading: boolean;
  filter: FleetStatus | 'all';
  onFilter: (f: FleetStatus | 'all') => void;
}) {
  const { t } = useT();
  return (
    <div className="fp-legend" role="group" aria-label={t('fbcLegend')}>
      {FLEET_STATUSES.map(s => (
        <button key={s} type="button" className={`fp-legend-item ff-${s}`} aria-pressed={filter === s}
          onClick={() => onFilter(filter === s ? 'all' : s)}>
          <i className="fp-dot" />
          <span>{t(STATUS_KEY[s])}</span>
          <b>{loading ? <Skeleton width={14} height={13} radius={4} /> : counts[s]}</b>
        </button>
      ))}
    </div>
  );
}

export function WorkersCard({ fleet, unavailable, hits, challenges, filter, onClearFilter, locale }: {
  fleet: FleetDoc | null;
  // The facade answered with something other than a fleet document (an older
  // facade, or the tunnel is down): say so in the card, keep the page.
  unavailable: boolean;
  hits: AlertHitRow[] | null;
  challenges: Challenge[] | null;
  filter: FleetStatus | 'all';
  onClearFilter: () => void;
  locale: string;
}) {
  const { t } = useT();
  const loading = !fleet && !unavailable;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const terms = queryTerms(query);
  const byCity = useMemo(() => hitsByCity(hits ?? []), [hits]);
  const parked = useMemo(() => parkedWorkers(challenges), [challenges]);
  const all = fleet?.workers ?? [];
  const shown = all.filter(w =>
    (filter === 'all' || fleetStatus(w, parked) === filter) && matchesTerms(accountHaystack(w), terms));
  const cities = new Set(all.flatMap(w => w.cities.map(c => c.slug))).size;
  const alerts = all.reduce((n, w) => n + accountAlerts(w, byCity), 0);
  const posts = fleetPostsToday(all);
  const startAt = fleet?.search.start_at;
  const missing = fleet
    ? [!fleet.sources.fleet && 'fleet.toml', !fleet.sources.master && 'master.toml'].filter(Boolean) as string[]
    : [];
  const toggle = (id: string) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section className="card fp-accounts ff-workers" aria-label={t('fbcWorkers')}>
      <div className="fp-toolbar">
        <label className="toolbar-search">
          <Icon name="search" size={14} />
          <input className="input" type="search" value={query} autoComplete="off"
            placeholder={t('fbcSearchWorkers')} aria-label={t('fbcSearchWorkers')}
            onChange={e => setQuery(e.target.value)} />
        </label>
        {(filter !== 'all' || query) && (
          <button type="button" className="btn ghost sm" onClick={() => { onClearFilter(); setQuery(''); }}>
            <Icon name="x" size={12} />
            {t('fpClear')}
          </button>
        )}
        <span className="ff-summary">
          {!fleet ? (loading ? <Skeleton width={220} height={11} /> : '…') : posts === null
            ? t('fbcWorkersSummary', { n: all.length, cities, alerts, days: HITS_DAYS })
            : t('fbcWorkersSummaryPosts', { n: all.length, posts, cities, alerts, days: HITS_DAYS })}
        </span>
      </div>

      {!fleet && unavailable && (
        <div className="card-note"><Icon name="info" size={16} /><span>{t('fbcFleetUnavailableNote')}</span></div>
      )}
      {fleet && !fleet.health.ok && (
        <div className="card-note"><Icon name="alert" size={16} /><span>{t('fbcAccHealthDownNote', { error: fleet.health.error ?? '' })}</span></div>
      )}
      {missing.length > 0 && (
        <div className="card-note"><Icon name="info" size={16} /><span>{t('fbcAccConfigMissing', { files: missing.join(' + ') })}</span></div>
      )}

      <div className="fp-table-wrap">
        <table className="fp-table ff-table" aria-busy={loading}>
          <thead>
            <tr>
              <th aria-label={t('fbcColCities')} />
              <th>{t('fbcColWorker')}</th>
              <th>{t('fbcColStatus')}</th>
              <th title={t('fbcColTodayHint')}>{t('fbcColToday')}</th>
              <th title={t('fbcColSearchesHint')}>{t('fbcColSearches')}</th>
              <th>{t('fbcColSession')}</th>
              <th title={t('fbcColPostsHint', { days: HITS_DAYS })}>{t('fbcColPosts')}</th>
              <th aria-label={t('fbcOpenWorker')} />
            </tr>
          </thead>
          <tbody>
            {shown.map(w => (
              <WorkerRow key={w.worker_id} account={w} hits={byCity} parked={parked} terms={terms} startAt={startAt}
                open={open.has(w.worker_id)} onToggle={() => toggle(w.worker_id)} locale={locale} />
            ))}
            {loading && SKELETON_ROWS.map(i => <WorkerRowSkeleton key={i} />)}
            {fleet && shown.length === 0 && (
              <tr><td colSpan={8} className="fp-empty">{terms.length || filter !== 'all' ? t('fbcAccEmptySearch') : t('fbcAccEmptyAll')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="fp-table-foot">
        {fleet ? t('fbcAsOf', { age: relTime(fleet.generated_at, locale) })
          : loading ? <Skeleton width={110} height={11} /> : '…'}
      </div>
    </section>
  );
}

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];

// Cell for cell the shape of a WorkerRow, two-line holders included, so the
// table keeps its height when the fleet document lands.
function WorkerRowSkeleton() {
  const pair = (top: number, bottom: number, topH = 13) => (
    <span className="fp-holder">
      <Skeleton width={top} height={topH} />
      <Skeleton width={bottom} height={10} />
    </span>
  );
  return (
    <tr className="ff-skel" aria-hidden>
      <td className="ff-chev"><Skeleton width={13} height={13} radius={4} /></td>
      <td>{pair(150, 170)}</td>
      <td>{pair(86, 90, 20)}</td>
      <td>{pair(178, 140, 8)}</td>
      <td><span className="ff-searches"><Skeleton width={20} height={20} radius={999} /><Skeleton width={34} height={12} /></span></td>
      <td><Skeleton width={58} height={12} /></td>
      <td>{pair(50, 80)}</td>
      <td><Skeleton width={16} height={16} radius={4} /></td>
    </tr>
  );
}

function WorkerRow({ account: w, hits, parked, terms, startAt, open, onToggle, locale }: {
  account: FleetAccount;
  hits: Map<string, CityHits>;
  parked: ReadonlySet<string>;
  terms: readonly string[];
  startAt: readonly string[] | undefined;
  open: boolean;
  onToggle: () => void;
  locale: string;
}) {
  const { t } = useT();
  const h = w.health;
  const who = whoIs(w);
  const status = fleetStatus(w, parked);
  const note = statusNote(t, w, parked, locale);
  const days = h?.session_days_left ?? null;
  const path = fleetWorkerPath(w.worker_id);
  const strip = dayStrip(w, status, startAt);
  const plan = w.plan;
  const build = h?.version && !isUnstampedBuild(h.version) ? h.version : null;
  const searched = searchedToday(w);

  return (
    <Fragment>
      <tr className={open ? 'ff-open' : undefined}>
        <td className="ff-chev">
          <button type="button" className="btn ghost icon sm" aria-expanded={open} onClick={onToggle}
            aria-label={t(open ? 'fbcHideCities' : 'fbcShowCities', { id: w.worker_id })} title={t('fbcCitiesTitle')}>
            <Icon name={open ? 'chevronUp' : 'chevronDown'} size={13} />
          </button>
        </td>
        <td className="ff-wrap">
          <span className="fp-holder">
            <span><Hi text={who.login ?? who.label ?? w.worker_id} terms={terms} /></span>
            <small><span className="mono"><Hi text={w.worker_id} terms={terms} /></span> · <Hi text={w.region.name} terms={terms} />
              {build && <> · <span className="mono" title={build}>v{build.split(' ')[0]}</span></>}</small>
          </span>
        </td>
        <td className="ff-wrap">
          <span className="fp-holder">
            <span><StatusChip status={status} /></span>
            {note && <small className={status === 'attention' || status === 'offline' ? 'fp-warn' : ''}>{note}</small>}
          </span>
        </td>
        <td className="ff-wrap" title={h?.last_heartbeat_at
          ? t('fbcHeartbeatAge', { age: relTime(h.last_heartbeat_at, locale) })
          : undefined}>
          {strip
            ? <span className="fp-holder"><DayBar strip={strip} status={status} /><small>{todayLabel(t, strip)}</small></span>
            : <span className="fp-muted" title={t('fbcTodayUnknown')}>—</span>}
        </td>
        <td>
          <SearchRing done={strip?.searches ?? null} budget={strip?.budget ?? plan?.per_day ?? null} />
        </td>
        <td title={h?.session_expiry ?? undefined}
          className={days === null ? 'fp-muted' : days <= 7 ? 'fp-warn' : 'fp-ok'}>
          {fmtDays(t, days)}
        </td>
        <td>
          <span className="fp-holder">
            <span className="ff-posts">
              <b className="mono">{w.today?.posts ?? '—'}</b> {t('fbcPostsNew')}
            </span>
            <small>{t('fbcPostsAlerts', { n: h ? accountAlerts(w, hits) : 0, days: HITS_DAYS })}</small>
          </span>
        </td>
        <td>
          <a className="btn ghost icon sm" href={hrefFor(path)} onClick={onLinkClick(path)}
            aria-label={t('fbcOpenWorkerOf', { id: w.worker_id })} title={t('fbcOpenWorkerOf', { id: w.worker_id })}>
            <Icon name="eye" size={14} />
          </a>
        </td>
      </tr>
      {open && (
        <tr className="ff-fold">
          <td colSpan={8}>
            <div className="fp-section-label">{t('fbcFoldCities', { n: w.cities.length })}</div>
            <div className="fl-cities">
              {w.cities.length
                ? w.cities.map(c => <CityChip key={c.slug} city={c} hits={hits} terms={terms}
                    tone={searched.has(c.slug) ? 'accent' : 'muted'} />)
                : <span className="fp-muted">{t('fbcNoCities')}</span>}
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// "07:25–now, ≈15:24 · 13:40 MT": the searched window, then the worker's own
// local time, so a manager in Denver reads an east-coast sweep in its hours.
function todayLabel(t: Translate, s: DayStrip): string {
  const span = s.start === null
    ? s.next ? t(s.next.tomorrow ? 'fbcTodayNextTomorrow' : 'fbcTodayNext', { time: s.next.time }) : t('fbcTodayNone')
    : s.running ? `${s.start}–${t('fbcTodayNow')}${s.eta ? `, ≈${s.eta}` : ''}`
    : s.end ? `${s.start}–${s.end}`
    : t('fbcTodayFrom', { time: s.start });
  return `${span} · ${s.localNow} ${s.zone}`;
}

function DayBar({ strip, status }: { strip: DayStrip; status: FleetStatus }) {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  return (
    <span className={`ff-day ff-${status}`} aria-hidden>
      {strip.segments.map((seg, i) => (
        <i key={i} className={`ff-day-${seg.kind}`}
          style={{ left: pct(seg.from), width: pct(Math.max(seg.to - seg.from, 0.004)) }} />
      ))}
      <i className="ff-day-now" style={{ left: pct(strip.nowAt) }} />
    </span>
  );
}

// Done against the day's budget. Amber once the budget is met — the sweep is
// over for the day — and a dash when the monitor does not report searches.
function SearchRing({ done, budget }: { done: number | null; budget: number | null }) {
  const { t } = useT();
  const r = 8;
  const c = 2 * Math.PI * r;
  const frac = done !== null && budget ? Math.min(done / budget, 1) : 0;
  const tone = done === null || done === 0 ? 'idle' : budget !== null && done >= budget ? 'full' : 'part';
  const title = done === null
    ? t('fbcSearchesUnknown')
    : budget !== null ? t('fbcSearchesOf', { done, budget }) : undefined;
  return (
    <span className={`ff-searches ff-ring-${tone}`} title={title}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
        <circle cx="11" cy="11" r={r} className="ff-ring-track" />
        {frac > 0 && (
          <circle cx="11" cy="11" r={r} className="ff-ring-fill"
            strokeDasharray={`${frac * c} ${c}`} transform="rotate(-90 11 11)" />
        )}
      </svg>
      <span className="mono"><b>{done ?? '—'}</b>{budget !== null && <span className="ff-ring-of">/{budget}</span>}</span>
    </span>
  );
}

const EVENT_KEY = {
  search: 'fbcActSearch', listing: 'fbcActListing', backup: 'fbcActBackup', silent: 'fbcActSilent', checkpoint: 'fbcActCheckpoint',
} as const;

export function ActivityAside({ fleet, unavailable, challenges, locale }: {
  fleet: FleetDoc | null; unavailable: boolean; challenges: Challenge[] | null; locale: string;
}) {
  const { t } = useT();
  const parked = parkedWorkers(challenges);
  const byId = new Map((fleet?.workers ?? []).map(w => [w.worker_id, w]));
  const events = fleetActivity(fleet, challenges);
  return (
    <aside className="card fp-activity ff-activity" aria-label={t('fpRecent')} aria-busy={!fleet && !unavailable}>
      <div className="card-head">
        <h2 className="card-title">{t('fpRecent')}</h2>
        <span className="card-sub">{t('fbcActivitySub')}</span>
      </div>
      <ul className="fp-log">
        {events.map((e, i) => {
          const w = byId.get(e.workerId);
          return (
            <li key={i}>
              <i className={`fp-dot ff-${w ? fleetStatus(w, parked) : 'offline'}`} />
              <div>
                <b className="mono">{e.workerId}</b> {t(EVENT_KEY[e.kind], { kind: e.detail ?? '' })}
                <time title={e.at}>{relTime(e.at, locale)}</time>
              </div>
            </li>
          );
        })}
        {!fleet && !unavailable && SKELETON_ROWS.map(i => (
          <li key={i} aria-hidden>
            <Skeleton width={8} height={8} radius={999} style={{ marginTop: 4 }} />
            <div className="ff-skel-lines">
              <Skeleton width={i % 2 ? 150 : 175} height={12} />
              <Skeleton width={70} height={10} />
            </div>
          </li>
        ))}
        {fleet && events.length === 0 && <li className="fp-muted">{t('fbcActivityEmpty')}</li>}
      </ul>
    </aside>
  );
}
