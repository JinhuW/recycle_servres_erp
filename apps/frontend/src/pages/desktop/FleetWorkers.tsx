import { Skeleton } from '../../components/Skeleton';
import type { Challenge, FleetAccount, FleetDoc } from '../../lib/coordinator';
import {
  attentionReason, fleetActivity, fleetStatus, parkedWorkers, type FleetEvent, type FleetStatus,
} from '../../lib/fleetView';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import type { Translate } from '../../lib/orderPresentation';
import type { FbProxyMark } from '../../lib/facebookPool';
import { fmtDays, stateLabel } from './FleetAccounts';
import '../../styles/facebookPool.css';

// ─── Fleet worker bits ────────────────────────────────────────────────────────
// The status chip and note, the proxy-dead chip and the activity aside that the
// account pool and the worker page share.

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
  if (r.kind === 'expiring') return t('fbcNoteExpiring', { days: fmtDays(t, r.days) });
  return null;
}

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];

export function ProxyDeadChip({ mark }: { mark: FbProxyMark }) {
  const { t, locale } = useT();
  const since = mark.deadAt ? relTime(new Date(mark.deadAt).toISOString(), locale) : '';
  return <span className="chip neg" title={t('fbcProxyDeadHint', { n: mark.failed, since })}>{t('fbcProxyDead')}</span>;
}

const EVENT_KEY = {
  search: 'fbcActSearch', listing: 'fbcActListing', backup: 'fbcActBackup', silent: 'fbcActSilent', checkpoint: 'fbcActCheckpoint',
  stale: 'fbcActStale', offline: 'fbcActOffline', back: 'fbcActBack', first: 'fbcActFirst',
  attention: 'fbcActAttention', healthy: 'fbcActHealthy',
} as const;

// The {kind} an event's text names: a checkpoint's kind as the coordinator
// files it, or the label of the state a worker reported.
export function eventDetail(t: Translate, e: FleetEvent): string {
  if (!e.detail) return '';
  return e.kind === 'attention' ? stateLabel(t, e.detail) : e.detail;
}

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
              <i className={`fp-dot ff-${e.status ?? (w ? fleetStatus(w, parked) : 'offline')}`} />
              <div>
                <b className="mono">{e.workerId}</b> {t(EVENT_KEY[e.kind], { kind: eventDetail(t, e) })}
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
