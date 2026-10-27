import { FB_FAILED_OUTCOMES, type FbStintOutcome } from '@recycle-erp/shared';
import { Fragment, useState, type ReactNode } from 'react';
import { Icon } from '../../../components/Icon';
import { FormSkeleton } from '../../../components/Skeleton';
import { handleFetchError } from '../../../lib/errorToast';
import {
  groupTimeline, loginCounts, loginTone, poolApi, REPORT_REASON_KEYS,
  type FbAccountTimeline, type FbWorkerStint, type LoginTone, type TimelineLine,
} from '../../../lib/facebookPool';
import type { FleetStatus } from '../../../lib/fleetView';
import { relTime } from '../../../lib/format';
import { useT } from '../../../lib/i18n';
import { hrefFor, onLinkClick } from '../../../lib/route';
import { StatusChip } from '../FleetWorkers';

// ─── One worker's page, whichever fleet runs it ───────────────────────────────
// The layout both worker pages share: the homelab coordinator's
// (FleetWorker.tsx) and the ERP fleet's (FleetErpWorker.tsx). Each page reads
// its own source and hands the pieces here as labels and nodes, so the two
// look and read the same; a value a source does not have is "—".

const STUB_TONE: Record<FleetStatus, string> = { live: 'accent', stale: 'warn', attention: 'warn', offline: 'neg' };

export function initialsOf(name: string): string {
  return name.replace(/[^a-z0-9]/gi, ' ').trim().split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase() || '?';
}

export const Muted = ({ children }: { children: ReactNode }) => <span className="fp-muted">{children}</span>;

/** An ERP-fleet worker's build, amber while it is behind the release the fleet rolls onto. */
export function ErpBuildChip({ version, release }: { version: string | null; release: string | null }) {
  const { t } = useT();
  if (!version) return <Muted>—</Muted>;
  const behind = !!release && version !== release;
  return (
    <span className={`chip ${behind ? 'warn' : 'muted'} mono fl-build`}
      title={behind ? t('fleetBuildBehind', { v: release }) : undefined}>{version}</span>
  );
}

export function BackToFleet() {
  const { t } = useT();
  return (
    <a className="fl-back" href={hrefFor('/fleet')} onClick={onLinkClick('/fleet')}>
      <Icon name="chevronLeft" size={13} />{t('fbcFleetTitle')}
    </a>
  );
}

/** The page head of a worker that could not be shown: its id and why. */
export function WorkerMissing({ workerId, note }: { workerId: string; note: string }) {
  return <div className="page-head"><div><BackToFleet /><h1 className="page-title mono">{workerId}</h1><div className="page-sub">{note}</div></div></div>;
}

export function WorkerHead({ title, sub, status }: { title: string; sub: ReactNode; status: FleetStatus }) {
  return (
    <div className="page-head">
      <div>
        <BackToFleet />
        <h1 className="page-title">{title}</h1>
        <div className="page-sub">{sub}</div>
      </div>
      <div className="page-actions">
        <StatusChip status={status} />
      </div>
    </div>
  );
}

export type WorkerStat = { label: string; value: ReactNode };
export type WorkerField = { label: string; value: ReactNode; wrap?: boolean };

/** The credential card: status stripe, who it is, the stat row, every field, the actions. */
export function WorkerCard({ name, status, stubNote, userId, headSub, stats, fields, actions }: {
  name: string; status: FleetStatus; stubNote: ReactNode; userId: string | null; headSub: ReactNode;
  stats: WorkerStat[]; fields: WorkerField[]; actions: ReactNode;
}) {
  return (
    <article className="fp-credential ff-worker-card" aria-label={name}>
      <div className={`fp-stub ff-stub-${STUB_TONE[status]}`}>
        <b>{initialsOf(name)}</b>
        <small>{stubNote}</small>
      </div>
      <div className="fp-credential-main">
        <div className="fp-credential-head">
          <span><b>{name}</b> {userId && <span className="mono fp-muted">{userId}</span>}</span>
          <small>{headSub}</small>
        </div>
        <div className="ff-ledger">
          {stats.map(s => <div key={s.label}><b>{s.value}</b><small>{s.label}</small></div>)}
        </div>
        <dl className="fp-fields">
          {fields.map(f => (
            <div key={f.label}><dt>{f.label}</dt><dd className={f.wrap ? 'ff-wrap-cell' : undefined}>{f.value}</dd></div>
          ))}
        </dl>
        <div className="fp-credential-foot">
          <div className="fp-row" style={{ flexWrap: 'wrap' }}>{actions}</div>
        </div>
      </div>
    </article>
  );
}

export type CheckpointItem = { key: string | number; thumb: ReactNode; kind: string; what: ReactNode; sub: ReactNode; actions: ReactNode };

export function CheckpointsCard({ items, sub }: { items: CheckpointItem[]; sub: string }) {
  const { t } = useT();
  return (
    <section className="card" aria-label={t('fbcOpenCheckpoints')}>
      <div className="card-head"><h2 className="card-title">{t('fbcOpenCheckpoints')}</h2><span className="card-sub">{sub}</span></div>
      {items.length === 0 && <div className="fp-empty">{t('fbcNoCheckpoint')}</div>}
      {items.map(c => (
        <div key={c.key} className="ff-checkpoint">
          {c.thumb}
          <div className="ff-checkpoint-what">
            <div><span className="chip accent">{c.kind}</span> {c.what}</div>
            <small>{c.sub}</small>
            <div className="fp-row" style={{ marginTop: 8 }}>{c.actions}</div>
          </div>
        </div>
      ))}
    </section>
  );
}

/** A checkpoint with no screenshot to show. */
export function NoThumb() {
  const { t } = useT();
  return <div className="ff-thumb" title={t('fbcNoScreenshot')}><Icon name="image" size={16} /></div>;
}

// ─── Accounts used ────────────────────────────────────────────────────────────

const OUTCOME_TONE: Record<FbStintOutcome, string> = {
  available: 'muted', taken: 'muted', fleet: 'muted', removed: 'muted', problem: 'warn', retired: 'neg',
};

const shortWhen = (at: number, locale: string) =>
  new Date(at).toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// Every pool account the worker has signed in with, newest first, each with
// the proxy it went out through. Problem and Retired count against that proxy.
// A row unfolds into the account's timeline, fetched the first time.
export function AccountsUsed({ stints, locale }: { stints: FbWorkerStint[] | null; locale: string }) {
  const { t } = useT();
  const when = (at: number) => shortWhen(at, locale);
  const failed = stints?.filter(s => s.outcome && FB_FAILED_OUTCOMES.includes(s.outcome)).length ?? 0;
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [timelines, setTimelines] = useState<ReadonlyMap<number, FbAccountTimeline | 'error'>>(() => new Map());
  const toggle = (row: string, no: number) => {
    const opening = !open.has(row);
    setOpen(prev => {
      const next = new Set(prev);
      if (next.has(row)) next.delete(row); else next.add(row);
      return next;
    });
    // A timeline that failed to load is asked for again on the next unfold.
    const had = timelines.get(no);
    if (!opening || (had !== undefined && had !== 'error')) return;
    if (had === 'error') setTimelines(m => { const next = new Map(m); next.delete(no); return next; });
    poolApi.timeline(no)
      .then(tl => setTimelines(m => new Map(m).set(no, tl)))
      .catch(err => { handleFetchError(err); setTimelines(m => new Map(m).set(no, 'error')); });
  };
  return (
    <section className="card ff-stints" aria-label={t('fbcAccountsUsed')}>
      <div className="card-head">
        <h2 className="card-title">{t('fbcAccountsUsed')}</h2>
        <span className="card-sub">{stints ? t('fbcAccountsUsedSub', { n: stints.length, failed }) : ''}</span>
      </div>
      {stints === null ? <FormSkeleton fields={2} />
        : stints.length === 0 ? <div className="fp-empty">{t('fbcAccountsUsedNone')}</div>
        : (
          <div className="fp-table-wrap">
            <table className="fp-table">
              <thead>
                <tr>
                  <th aria-label={t('fbcTlTitle')} />
                  <th>#</th>
                  <th>{t('fbcStintLogin')}</th>
                  <th>{t('fbcColProxy')}</th>
                  <th>{t('fbcStintFrom')}</th>
                  <th>{t('fbcStintUntil')}</th>
                  <th>{t('fbcStintOutcome')}</th>
                </tr>
              </thead>
              <tbody>
                {stints.map(s => {
                  const row = `${s.accountNo}-${s.startedAt}`;
                  const isOpen = open.has(row);
                  return (
                  <Fragment key={row}>
                  <tr className={isOpen ? 'ff-open ff-tl-toggle' : 'ff-tl-toggle'} onClick={() => toggle(row, s.accountNo)}>
                    <td className="ff-chev">
                      <button type="button" className="btn ghost icon sm" aria-expanded={isOpen}
                        aria-label={t(isOpen ? 'fbcTlHide' : 'fbcTlShow', { n: s.accountNo })} title={t('fbcTlTitle')}
                        onClick={e => { e.stopPropagation(); toggle(row, s.accountNo); }}>
                        <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size={13} />
                      </button>
                    </td>
                    <td className="mono">#{s.accountNo}</td>
                    <td>
                      <span className="fp-holder">
                        <span>{s.email ?? s.uid}</span>
                        {s.email && <small className="mono">{s.uid}</small>}
                      </span>
                    </td>
                    <td>
                      {!s.proxyKnown ? <span className="fp-muted" title={t('fbcStintProxyUnknownHint')}>{t('fbcStintProxyUnknown')}</span>
                        : s.proxyUrl ? <span className="mono">{s.proxyUrl}</span>
                        : <span className="fp-muted">{t('fbcProxyNone')}</span>}
                    </td>
                    <td>{when(s.startedAt)}</td>
                    <td>{s.endedAt ? when(s.endedAt) : <span className="fp-muted">—</span>}</td>
                    <td>
                      {s.outcome
                        ? <span className={`chip ${OUTCOME_TONE[s.outcome]}`}>{t(`fbcStint_${s.outcome}`)}</span>
                        : <span className="chip accent">{t('fbcStint_current')}</span>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="ff-tl-row">
                      <td colSpan={7}><AccountTimeline timeline={timelines.get(s.accountNo)} locale={locale} /></td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

export const LOGIN_DOT: Record<LoginTone, string> = { ok: 'ff-live', warn: 'ff-attention', fail: 'ff-offline', pending: 'ff-tl-muted' };

function lineDot(line: TimelineLine): string {
  if (line.kind === 'login') return LOGIN_DOT[loginTone(line.outcome)];
  if (line.kind === 'pool' && line.action === 'reported') return 'ff-attention';
  if (line.kind === 'pool' && (line.action === 'retired' || line.action === 'removed')) return 'ff-offline';
  return 'ff-tl-muted';
}

const TL_LOGINS_NOTE = { not_served: 'fbcTlNotServed', unreachable: 'fbcTlUnreachable', partial: 'fbcTlPartial' } as const;

// One account's life, newest first: every login a worker attempted for it,
// and what the pool did with it. A run of identical logins is one line.
function AccountTimeline({ timeline, locale }: { timeline: FbAccountTimeline | 'error' | undefined; locale: string }) {
  const { t } = useT();
  if (timeline === undefined) return <div className="ff-timeline-note fp-muted">{t('fbcTlLoading')}</div>;
  if (timeline === 'error') return <div className="ff-timeline-note fp-warn">{t('fbcTlFailed')}</div>;
  const lines = groupTimeline(timeline.events);
  const { ok, failed } = loginCounts(timeline.events);
  // To the second: a cookie restore that fails and the token refresh after it
  // land in the same minute.
  const when = (at: number) => new Date(at).toLocaleString(locale,
    { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  return (
    <div className="ff-timeline">
      <div className="ff-timeline-head">
        <span>{t('fbcTlSum', { ok, failed })}</span>
        {timeline.logins !== 'ok' && (
          <span className="fp-warn">{t(TL_LOGINS_NOTE[timeline.logins])}</span>
        )}
      </div>
      <ul className="fp-log">
        {lines.map((line, i) => (
          <li key={i}>
            <i className={`fp-dot ${lineDot(line)}`} />
            <div>
              <TimelineText line={line} />
              <time title={new Date(line.at).toLocaleString(locale)}>
                {line.count > 1 ? t('fbcTlRange', { from: when(line.since), to: when(line.at) }) : when(line.at)}
              </time>
            </div>
          </li>
        ))}
        {lines.length === 0 && <li className="fp-muted">{t('fbcTlEmpty')}</li>}
      </ul>
    </div>
  );
}

function TimelineText({ line }: { line: TimelineLine }) {
  const { t } = useT();
  if (line.kind === 'added') return <span>{t('fbcTlAdded', { batch: line.batch })}</span>;
  if (line.kind === 'pool') {
    const detail = line.detail ?? '';
    const reason = detail in REPORT_REASON_KEYS ? t(REPORT_REASON_KEYS[detail as keyof typeof REPORT_REASON_KEYS]) : detail;
    const text = line.action === 'assigned' ? t('fbcTlAssigned', { worker: detail, by: line.by })
      : line.action === 'reported' ? t('fbcTlReported', { reason, by: line.by })
      : line.action === 'took' ? t('fbcTlTook', { by: line.by })
      : line.action === 'returned' ? t('fbcTlReturned', { by: line.by })
      : line.action === 'retired' ? t('fbcTlRetired', { by: line.by })
      : line.action === 'removed' ? t('fbcTlRemoved', { by: line.by })
      : `${line.action} · ${line.by}`;
    // A displaced account's note says which account replaced it, and where.
    const why = line.action !== 'assigned' && line.action !== 'reported' && detail ? ` — ${detail}` : '';
    return <span>{text}{why}</span>;
  }
  return <LoginWords outcome={line.outcome} detail={line.detail} trigger={line.trigger} count={line.count}
    url={line.url} worker={line.worker} />;
}

// One login, or a run of them: how it ended (a checkpoint names its kind
// unless that is plain "checkpoint"), how many, what started it, and where.
export function LoginWords({ outcome, detail, trigger, count, url, worker }: {
  outcome: string | null; detail: string | null; trigger: string | null; count: number; url: string | null;
  worker?: string;
}) {
  const { t } = useT();
  const what = t(`fbcTlLogin_${outcome ?? 'none'}`);
  return (
    <span title={url ?? undefined}>
      <b>{outcome === 'challenge' && detail && detail !== 'checkpoint' ? `${what} (${detail})` : what}</b>
      {count > 1 && <> ×{count}</>}
      <span className="fp-muted">
        {trigger && <> · {t(`fbcTlTrigger_${trigger}`)}</>}
        {worker && <>{' · '}<span className="mono">{worker}</span></>}
      </span>
    </span>
  );
}

// ─── History ──────────────────────────────────────────────────────────────────

/** One line of a worker's history: when, its dot, its words, and for a run
 *  of the same thing, when the run began. */
export type HistoryEntry = { at: number; dot: string; text: ReactNode; since?: number };

// The page's right-hand column: everything known to have happened on this
// worker, newest first. It is as tall as the main column and scrolls its own
// list.
export function WorkerHistory({ entries, note, locale }: { entries: HistoryEntry[]; note?: string | null; locale: string }) {
  const { t } = useT();
  const ago = (at: number) => relTime(new Date(at).toISOString(), locale);
  return (
    <aside className="card fp-activity ff-activity ff-history" aria-label={t('fbcHistory')}>
      <div className="card-head"><h2 className="card-title">{t('fbcHistory')}</h2></div>
      {note && <div className="ff-history-note fp-warn">{note}</div>}
      <ul className="fp-log">
        {entries.map((line, i) => (
          <li key={i}>
            <i className={`fp-dot ${line.dot}`} />
            <div>
              {line.text}
              <time title={new Date(line.at).toLocaleString(locale)}>
                {line.since !== undefined && line.since !== line.at ? t('fbcTlRange', { from: ago(line.since), to: ago(line.at) }) : ago(line.at)}
              </time>
            </div>
          </li>
        ))}
        {entries.length === 0 && <li className="fp-muted">{t('fbcActivityEmpty')}</li>}
      </ul>
    </aside>
  );
}
