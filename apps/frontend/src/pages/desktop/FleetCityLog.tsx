import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { FormSkeleton } from '../../components/Skeleton';
import { ApiError } from '../../lib/api';
import { coordinatorApi, type CityStep, type CityVisit, type CityVisitOutcome } from '../../lib/coordinator';
import { cityStepDot, stepCount, VISIT_TONE, visitMinutes } from '../../lib/fleetView';
import { useT } from '../../lib/i18n';
import type { Translate } from '../../lib/orderPresentation';
import { stateLabel } from './FleetAccounts';
import '../../styles/facebookPool.css';

// ─── The city log ─────────────────────────────────────────────────────────────
// Each city a worker searched, from its handout (or its start, on a worker's
// own list) to its end, with the worker's brief report: one row a city, and
// under it every step. The worker page shows one worker's day; a city name on
// the round card opens that city's day across workers.

// null while loading; a console older than the log answers 404.
export type CityLogState = CityVisit[] | 'not_served' | 'unreachable' | null;

export function loadCityLog(q: { worker?: string; city?: string }, set: (s: CityLogState) => void): void {
  coordinatorApi.cityLog(q).then(set)
    .catch(err => set(err instanceof ApiError && err.status === 404 ? 'not_served' : 'unreachable'));
}

const OUTCOME_KEY: Record<CityVisitOutcome, string> = {
  finished: 'fbcCityOutcomeFinished',
  searching: 'fbcCityOutcomeSearching',
  stopped: 'fbcCityOutcomeStopped',
  released: 'fbcCityOutcomeReleased',
  expired: 'fbcCityOutcomeExpired',
  quiet: 'fbcCityOutcomeQuiet',
};

const STOP_KEY: Record<string, string> = {
  wall: 'fbcCityStopWall',
  session: 'fbcCityStopSession',
  paused: 'fbcCityStopPaused',
  'cut short': 'fbcCityStopCutShort',
  interrupted: 'fbcCityStopInterrupted',
  error: 'fbcCityStopError',
};

const WHY_KEY: Record<string, string> = {
  home: 'fbcCityWhyHome',
  familiar: 'fbcCityWhyFamiliar',
  other: 'fbcCityWhyOther',
};

const COUNTS = ['searches', 'cards', 'opened', 'reviewed', 'alerted'] as const;

const clock = (at: string, locale: string, seconds = false) =>
  new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });

const text = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));

function stopReason(t: Translate, reason: string | null, wall: string | null): string {
  const key = reason ? STOP_KEY[reason] : undefined;
  const said = key ? t(key) : reason ?? t('fbcCityStopUnknown');
  return wall ? `${said} (${wall})` : said;
}

// Given back by a restart, or by a worker that parked: the state it reported.
function backReason(t: Translate, reason: string | null): string {
  return reason === 'restarted' ? t('fbcCityBackRestarted') : stateLabel(t, reason ?? '?');
}

function outcomeLabel(t: Translate, v: CityVisit, locale: string): string {
  if (v.outcome === 'stopped') return t(OUTCOME_KEY.stopped, { reason: stopReason(t, v.reason, v.wall) });
  if (v.outcome === 'released') return t(OUTCOME_KEY.released, { reason: backReason(t, v.reason) });
  if (v.outcome === 'quiet') return t(OUTCOME_KEY.quiet, { time: clock(v.events[v.events.length - 1].at, locale) });
  return t(OUTCOME_KEY[v.outcome]);
}

function StepText({ step }: { step: CityStep }) {
  const { t } = useT();
  const d = step.detail;
  switch (step.event) {
    case 'handed': {
      const why = text(d.why);
      return <span>{t('fbcCityStepHanded', { why: WHY_KEY[why] ? t(WHY_KEY[why]) : why })}</span>;
    }
    case 'started':
      return <span>{t(d.via === 'own' ? 'fbcCityStepStartedOwn' : 'fbcCityStepStarted', { n: stepCount(step, 'searches') })}</span>;
    case 'searched': {
      const counts = {
        cards: stepCount(step, 'cards'), passed: stepCount(step, 'title_pass'),
        opened: stepCount(step, 'opened'), reviewed: stepCount(step, 'reviewed'),
      };
      return <span>{d.phrase
        ? t('fbcCityStepSearched', { phrase: text(d.phrase), ...counts })
        : t('fbcCityStepSearchedNoPhrase', counts)}</span>;
    }
    case 'alerted': {
      const title = text(d.title) || text(d.listing_id) || t('fbcCityAListing');
      return (
        <span>
          {t('fbcCityStepAlerted')}{' '}
          {d.url ? <a href={text(d.url)} target="_blank" rel="noreferrer">{title}</a> : title}
          {d.price ? `, ${text(d.price)}` : ''}
          {typeof d.score === 'number' ? `, ${t('fbcCityScore', { n: d.score })}` : ''}
        </span>
      );
    }
    case 'finished':
      return <span>{t('fbcCityStepFinished', { minutes: visitMinutes({ seconds: stepCount(step, 'seconds') }) ?? 0 })}</span>;
    case 'stopped':
      return (
        <span>
          {t('fbcCityStepStopped', {
            n: stepCount(step, 'searches'), of: stepCount(step, 'of'),
            reason: stopReason(t, d.reason ? text(d.reason) : null, d.wall ? text(d.wall) : null),
          })}
          {d.error ? <span className="fp-muted"> {text(d.error)}</span> : null}
        </span>
      );
    case 'released':
      return <span>{t('fbcCityStepReleased', { reason: backReason(t, d.reason ? text(d.reason) : null) })}</span>;
    case 'expired':
      return <span>{t('fbcCityStepExpired')}</span>;
  }
}

function VisitSteps({ visit, locale }: { visit: CityVisit; locale: string }) {
  const { t } = useT();
  return (
    <div className="ff-timeline">
      {!visit.reported && visit.outcome === 'finished' && (
        <div className="ff-timeline-head"><span>{t('fbcCityNoReport')}</span></div>
      )}
      <ul className="fp-log">
        {visit.events.map((step, i) => (
          <li key={i}>
            <i className={`fp-dot ${cityStepDot(step)}`} />
            <div>
              <StepText step={step} />
              <time title={new Date(step.at).toLocaleString(locale)}>{clock(step.at, locale, true)}</time>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One row a city, and its steps under it. `by` names the column that varies:
 *  the city on a worker's page, the worker on a city's log. */
export function CityLogTable({ visits, by }: { visits: CityVisit[]; by: 'city' | 'worker' }) {
  const { t, locale } = useT();
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (row: string) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(row)) next.delete(row); else next.add(row);
    return next;
  });
  const columns = 9;
  return (
    <div className="fp-table-wrap">
      <table className="fp-table ff-citylog">
        <thead>
          <tr>
            <th aria-label={t('fbcCityLogSteps')} />
            <th>{t('fbcCityLogColTime')}</th>
            <th>{t(by === 'city' ? 'fbcCityLogColCity' : 'fbcCityLogColWorker')}</th>
            <th className="num">{t('fbcCityLogColSearches')}</th>
            <th className="num">{t('fbcCityLogColCards')}</th>
            <th className="num">{t('fbcCityLogColOpened')}</th>
            <th className="num">{t('fbcCityLogColReviewed')}</th>
            <th className="num">{t('fbcCityLogColAlerts')}</th>
            <th>{t('fbcCityLogColOutcome')}</th>
          </tr>
        </thead>
        <tbody>
          {visits.map(v => {
            const row = `${v.worker_id}-${v.item}-${v.city}-${v.started_at}`;
            const isOpen = open.has(row);
            const minutes = visitMinutes(v);
            const where: ReactNode = by === 'city'
              ? <span>{v.name ?? v.city}</span>
              : <span className="mono">{v.worker_id}</span>;
            return (
              <Fragment key={row}>
                <tr className={isOpen ? 'ff-open ff-tl-toggle' : 'ff-tl-toggle'} onClick={() => toggle(row)}>
                  <td className="ff-chev">
                    <button type="button" className="btn ghost icon sm" aria-expanded={isOpen}
                      aria-label={t(isOpen ? 'fbcCityLogHide' : 'fbcCityLogShow', { city: v.name ?? v.city })}
                      onClick={e => { e.stopPropagation(); toggle(row); }}>
                      <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size={13} />
                    </button>
                  </td>
                  <td>
                    <span className="fp-holder">
                      <span>{clock(v.started_at, locale)}{v.ended_at ? `–${clock(v.ended_at, locale)}` : ''}</span>
                      {minutes !== null && (
                        <small>{minutes === 0 ? t('fbcCityUnderAMinute') : t('fbcCityMinutes', { n: minutes })}</small>
                      )}
                    </span>
                  </td>
                  <td>
                    <span className="fp-holder">
                      {where}
                      <small className="mono">{v.item ?? t('fbcCityNoItem')}</small>
                    </span>
                  </td>
                  {COUNTS.map(k => (
                    <td key={k} className={k === 'alerted' && v.totals.alerted > 0 ? 'num ff-citylog-hit' : 'num'}>
                      {v.totals[k]}
                    </td>
                  ))}
                  <td>
                    <span className={`chip ${VISIT_TONE[v.outcome]}`}
                      title={v.outcome === 'finished' && !v.reported ? t('fbcCityNoReport') : v.error ?? undefined}>
                      {outcomeLabel(t, v, locale)}
                    </span>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="ff-tl-row">
                    <td colSpan={columns}><VisitSteps visit={v} locale={locale} /></td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The worker page's card: its cities over the last 24 h. */
export function CityLogCard({ log }: { log: CityLogState }) {
  const { t } = useT();
  if (log === 'not_served') return null;
  return (
    <section className="card ff-stints" aria-label={t('fbcCityLog')}>
      <div className="card-head">
        <h2 className="card-title">{t('fbcCityLog')}</h2>
        <span className="card-sub">{Array.isArray(log) ? t('fbcCityLogSub', { n: log.length }) : ''}</span>
      </div>
      {log === null ? <FormSkeleton fields={2} />
        : log === 'unreachable' ? <div className="fp-empty fp-warn">{t('fbcCityLogFailed')}</div>
        : log.length === 0 ? <div className="fp-empty">{t('fbcCityLogNone')}</div>
        : <CityLogTable visits={log} by="city" />}
    </section>
  );
}

/** One city's last 24 h across workers and items, from the round card. */
export function CityLogModal({ slug, name, onClose }: { slug: string; name: string; onClose: () => void }) {
  const { t } = useT();
  const [log, setLog] = useState<CityLogState>(null);
  useEffect(() => { loadCityLog({ city: slug }, setLog); }, [slug]);
  return (
    <Modal onClose={onClose} shellStyle={{ maxWidth: 920 }}>
      <div className="modal-head">
        <div>
          <div className="modal-title">{t('fbcCityLogCityTitle', { city: name })}</div>
          <div className="modal-sub">{t('fbcCityLogCitySub')}</div>
        </div>
      </div>
      <div className="modal-body">
        {log === null ? <FormSkeleton fields={2} />
          : log === 'not_served' ? <p className="fp-muted">{t('fbcCityLogNotServed')}</p>
          : log === 'unreachable' ? <p className="fp-warn">{t('fbcCityLogFailed')}</p>
          : log.length === 0 ? <p className="fp-muted">{t('fbcCityLogCityNone')}</p>
          : <CityLogTable visits={log} by="worker" />}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose}>{t('close')}</button>
      </div>
    </Modal>
  );
}
