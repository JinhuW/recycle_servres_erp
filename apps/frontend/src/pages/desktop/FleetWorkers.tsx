import { Fragment, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import type { AlertHitRow, Challenge, FleetAccount, FleetDoc } from '../../lib/coordinator';
import {
  accountAlerts, accountHaystack, attentionReason, FLEET_STATUSES, fleetActivity, fleetStatus, hitsByCity,
  matchesTerms, parkedWorkers, queryTerms, whoIs, type CityHits, type FleetStatus,
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
// the worker's cities and pacing, and the eye — the one way to a worker's
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

export function FleetLegend({ counts, filter, onFilter }: {
  counts: Record<FleetStatus, number>;
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
          <b>{counts[s]}</b>
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
          {fleet ? t('fbcWorkersSummary', { n: all.length, cities, alerts, days: HITS_DAYS }) : '…'}
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
        <table className="fp-table ff-table">
          <thead>
            <tr>
              <th aria-label={t('fbcColCities')} />
              <th>{t('fbcColWorker')}</th>
              <th>{t('fbcColStatus')}</th>
              <th>{t('fbcColLastSearch')}</th>
              <th>{t('fbcColSession')}</th>
              <th className="num" title={t('fbcColAlertsHint', { days: HITS_DAYS })}>{t('fbcColAlerts', { days: HITS_DAYS })}</th>
              <th aria-label={t('fbcOpenWorker')} />
            </tr>
          </thead>
          <tbody>
            {shown.map(w => (
              <WorkerRow key={w.worker_id} account={w} hits={byCity} parked={parked} terms={terms}
                open={open.has(w.worker_id)} onToggle={() => toggle(w.worker_id)} locale={locale} />
            ))}
            {fleet && shown.length === 0 && (
              <tr><td colSpan={7} className="fp-empty">{terms.length || filter !== 'all' ? t('fbcAccEmptySearch') : t('fbcAccEmptyAll')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="fp-table-foot">
        {fleet ? t('fbcAsOf', { age: relTime(fleet.generated_at, locale) }) : '…'}
      </div>
    </section>
  );
}

function WorkerRow({ account: w, hits, parked, terms, open, onToggle, locale }: {
  account: FleetAccount;
  hits: Map<string, CityHits>;
  parked: ReadonlySet<string>;
  terms: readonly string[];
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
  const pace = w.pacing.search_interval
    ? `${w.pacing.search_interval} – ${w.pacing.max_search_interval ?? w.pacing.search_interval}`
    : null;

  return (
    <Fragment>
      <tr className={open ? 'ff-open' : undefined}>
        <td className="ff-chev">
          <button type="button" className="btn ghost icon sm" aria-expanded={open} onClick={onToggle}
            aria-label={t(open ? 'fbcHideCities' : 'fbcShowCities', { id: w.worker_id })} title={t('fbcCitiesAndPacing')}>
            <Icon name={open ? 'chevronUp' : 'chevronDown'} size={13} />
          </button>
        </td>
        <td className="ff-wrap">
          <span className="fp-holder">
            <span><Hi text={who.login ?? who.label ?? w.worker_id} terms={terms} /></span>
            <small><span className="mono"><Hi text={w.worker_id} terms={terms} /></span> · <Hi text={w.region.name} terms={terms} /></small>
          </span>
        </td>
        <td className="ff-wrap">
          <span className="fp-holder">
            <span><StatusChip status={status} /></span>
            {note && <small className={status === 'attention' || status === 'offline' ? 'fp-warn' : ''}>{note}</small>}
          </span>
        </td>
        <td title={h?.last_search_at ?? undefined}>
          <span className="fp-holder">
            <span>{h?.last_search_at ? relTime(h.last_search_at, locale) : '—'}</span>
            <small>{t('fbcHeartbeatAge', { age: h?.last_heartbeat_at ? relTime(h.last_heartbeat_at, locale) : t('fbcNever') })}</small>
          </span>
        </td>
        <td title={h?.session_expiry ?? undefined}
          className={days === null ? 'fp-muted' : days <= 7 ? 'fp-warn' : 'fp-ok'}>
          {fmtDays(t, days)}
        </td>
        <td className="num">{h ? accountAlerts(w, hits) : '—'}</td>
        <td>
          <a className="btn ghost icon sm" href={hrefFor(path)} onClick={onLinkClick(path)}
            aria-label={t('fbcOpenWorkerOf', { id: w.worker_id })} title={t('fbcOpenWorkerOf', { id: w.worker_id })}>
            <Icon name="eye" size={14} />
          </a>
        </td>
      </tr>
      {open && (
        <tr className="ff-fold">
          <td colSpan={7}>
            <div className="ff-fold-body">
              <div>
                <div className="fp-section-label">{t('fbcFoldCities', { n: w.cities.length })}</div>
                <div className="fl-cities">
                  {w.cities.length
                    ? w.cities.map(c => <CityChip key={c.slug} city={c} hits={hits} terms={terms}
                        tone={status === 'live' || status === 'stale' ? 'accent' : 'muted'} />)
                    : <span className="fp-muted">{t('fbcNoCities')}</span>}
                </div>
              </div>
              <div>
                <div className="fp-section-label">{t('fbcFoldPacing')}</div>
                <div className="ff-fold-text">
                  {pace ? t('fbcPacingText', { pace }) : t('fbcPacingDefault')}
                  {w.pacing.overridden && ` · ${t('fbcPacingOverride')}`}
                  {' · '}{w.proxy_env ? t('fbcViaProxy', { env: w.proxy_env }) : t('fbcOwnIp')}
                </div>
                <div className="ff-fold-hint">{t('fbcFoldHint')}</div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

const EVENT_KEY = {
  search: 'fbcActSearch', listing: 'fbcActListing', backup: 'fbcActBackup', silent: 'fbcActSilent', checkpoint: 'fbcActCheckpoint',
} as const;

export function ActivityAside({ fleet, challenges, locale }: {
  fleet: FleetDoc | null; challenges: Challenge[] | null; locale: string;
}) {
  const { t } = useT();
  const parked = parkedWorkers(challenges);
  const byId = new Map((fleet?.workers ?? []).map(w => [w.worker_id, w]));
  const events = fleetActivity(fleet, challenges);
  return (
    <aside className="card fp-activity ff-activity" aria-label={t('fpRecent')}>
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
        {fleet && events.length === 0 && <li className="fp-muted">{t('fbcActivityEmpty')}</li>}
      </ul>
    </aside>
  );
}
