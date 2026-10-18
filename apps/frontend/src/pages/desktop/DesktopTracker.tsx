import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Skeleton } from '../../components/Skeleton';
import { ApiError } from '../../lib/api';
import { handleFetchError } from '../../lib/errorToast';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import {
  MIN_POLL_INTERVAL_S,
  normalizeSubredditName,
  trackerApi,
  WORKERS_PAGE_SIZE,
  type LoopName,
  type TrackerMatch,
  type TrackerRule,
  type TrackerStats,
  type TrackerSubreddit,
  type TrackerWorker,
} from '../../lib/tracker';
import { liveness, type Liveness } from '../../lib/workerLiveness';
import { ConfirmDialog } from './settings/dialogs';
import { Toggle } from './settings/_shared';
import '../../styles/facebookPool.css';

// ─── Monitors ▸ Reddit ────────────────────────────────────────────────────────
// The Facebook fleet page's chrome (DesktopCoordinator.tsx) with the Reddit
// monitor's content: a status legend that filters, the workers table beside
// the newest matches, and the pipeline from a poll to an alert, where the
// subreddits and the alert rules are edited. Everything goes through the
// /api/tracker proxy; a 501 from it means the backend has no tracker
// credentials, which gets its own quiet state instead of error toasts.

const REFRESH_MS = 30_000;
const MATCHES_SHOWN = 30;
const STATS_WINDOW_MS = 24 * 3600_000;

const LIVENESS: readonly Liveness[] = ['live', 'stale', 'dead'];
const LIVENESS_KEY: Record<Liveness, string> = { live: 'trkLive', stale: 'trkStale', dead: 'trkDead' };
// The Facebook page's status palette: a dead worker wears its offline colour.
const LIVENESS_CLASS: Record<Liveness, string> = { live: 'ff-live', stale: 'ff-stale', dead: 'ff-offline' };

const LOOPS: readonly LoopName[] = ['poll', 'evaluate', 'notify'];

// Matches and stats are only decoration on this page: without them their
// parts read "—", never an error dialog.
type Unavailable = 'unavailable';

type Props = { showToast?: (msg: string, kind?: 'success' | 'error') => void };

export function DesktopTracker({ showToast }: Props) {
  const { t, locale } = useT();

  const [rules, setRules] = useState<TrackerRule[] | null>(null);
  const [subs, setSubs] = useState<TrackerSubreddit[] | null>(null);
  const [counts, setCounts] = useState<Record<Liveness, number> | null>(null);
  const [matches, setMatches] = useState<TrackerMatch[] | Unavailable | null>(null);
  const [stats, setStats] = useState<TrackerStats | Unavailable | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [filter, setFilter] = useState<Liveness | 'all'>('all');

  const [ruleDialog, setRuleDialog] = useState<TrackerRule | 'new' | null>(null);
  const [deletingRule, setDeletingRule] = useState<TrackerRule | null>(null);
  const [deletingSub, setDeletingSub] = useState<TrackerSubreddit | null>(null);

  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 501) {
      setNotConfigured(true);
      return;
    }
    handleFetchError(err);
  }, []);

  useEffect(() => {
    let alive = true;
    trackerApi.listRules().then(r => { if (alive) setRules(r); }).catch(err => { if (alive) fail(err); });
    trackerApi.listSubreddits().then(s => { if (alive) setSubs(s); }).catch(err => { if (alive) fail(err); });
    return () => { alive = false; };
  }, [fail]);

  const loadLive = useCallback(() => {
    trackerApi.workerCounts().then(setCounts).catch(fail);
    trackerApi.listMatches(MATCHES_SHOWN).then(setMatches).catch(() => setMatches('unavailable'));
    trackerApi.stats(new Date(Date.now() - STATS_WINDOW_MS)).then(setStats).catch(() => setStats('unavailable'));
  }, [fail]);

  // Liveness, matches and the post counts all move on their own. A
  // backgrounded tab polls nothing and catches up the moment it's back.
  useEffect(() => {
    loadLive();
    const refresh = () => { if (!document.hidden) loadLive(); };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [loadLive]);

  const head = (
    <div className="page-head"><div><div className="page-sub">{t('nav_monitors')} / {t('nav_tracker')}</div>
      <h1 className="page-title">{t('trkTitle')}</h1></div></div>
  );

  if (notConfigured) {
    return (
      <>
        {head}
        <div className="card">
          <div className="card-body" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', color: 'var(--fg-muted)' }}>
            <Icon name="info" size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <span style={{ maxWidth: '65ch' }}>{t('trkNotConfigured')}</span>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {head}
      <div className="fp-pool">
        <WorkerLegend counts={counts} filter={filter} onFilter={setFilter} />
        <div className="fp-split ff-split">
          <WorkersCard filter={filter} onClearFilter={() => setFilter('all')} subs={subs} rules={rules}
            locale={locale} onError={fail} showToast={showToast} onRemoved={loadLive} />
          <MatchesAside matches={matches} locale={locale} />
        </div>
        <FlowCard stats={stats} subs={subs} rules={rules} locale={locale}
          onSubsChanged={setSubs} onDeleteSub={setDeletingSub}
          onRulesChanged={setRules} onEditRule={setRuleDialog} onDeleteRule={setDeletingRule}
          onError={fail} showToast={showToast} />
      </div>

      {ruleDialog && (
        <RuleModal
          rule={ruleDialog === 'new' ? null : ruleDialog}
          onClose={() => setRuleDialog(null)}
          onSaved={saved => {
            setRules(rs => {
              const list = rs ?? [];
              return list.some(r => r.id === saved.id)
                ? list.map(r => r.id === saved.id ? saved : r)
                : [...list, saved];
            });
            setRuleDialog(null);
            showToast?.(t('trkRuleSaved'));
          }}
          onError={fail}
        />
      )}

      {deletingRule && (
        <ConfirmDialog
          title={t('trkDeleteRule')}
          message={t('trkDeleteRuleMsg', { name: deletingRule.name })}
          confirmLabel={t('trkDeleteRule')}
          danger
          onCancel={() => setDeletingRule(null)}
          onConfirm={() => {
            trackerApi.deleteRule(deletingRule.id)
              .then(() => {
                setRules(rs => (rs ?? []).filter(r => r.id !== deletingRule.id));
                showToast?.(t('trkRuleDeleted'));
              })
              .catch(fail)
              .finally(() => setDeletingRule(null));
          }}
        />
      )}

      {deletingSub && (
        <ConfirmDialog
          title={t('trkDeleteSub')}
          message={t('trkDeleteSubMsg', { name: deletingSub.name })}
          confirmLabel={t('trkDeleteSub')}
          danger
          onCancel={() => setDeletingSub(null)}
          onConfirm={() => {
            trackerApi.deleteSubreddit(deletingSub.name)
              .then(() => {
                setSubs(ss => (ss ?? []).filter(s => s.name !== deletingSub.name));
                showToast?.(t('trkSubRemoved'));
              })
              .catch(fail)
              .finally(() => setDeletingSub(null));
          }}
        />
      )}
    </>
  );
}

function WorkerLegend({ counts, filter, onFilter }: {
  counts: Record<Liveness, number> | null;
  filter: Liveness | 'all';
  onFilter: (f: Liveness | 'all') => void;
}) {
  const { t } = useT();
  return (
    <div className="fp-legend" role="group" aria-label={t('trkLegend')}>
      {LIVENESS.map(s => (
        <button key={s} type="button" className={`fp-legend-item ${LIVENESS_CLASS[s]}`} aria-pressed={filter === s}
          onClick={() => onFilter(filter === s ? 'all' : s)}>
          <i className="fp-dot" />
          <span>{t(LIVENESS_KEY[s])}</span>
          <b>{counts ? counts[s] : <Skeleton width={14} height={13} radius={4} />}</b>
        </button>
      ))}
    </div>
  );
}

function StatusChip({ state }: { state: Liveness }) {
  const { t } = useT();
  return <span className={`fp-chip ${LIVENESS_CLASS[state]}`}><i className="fp-dot" />{t(LIVENESS_KEY[state])}</span>;
}

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];

function WorkersCard({ filter, onClearFilter, subs, rules, locale, onError, showToast, onRemoved }: {
  filter: Liveness | 'all';
  onClearFilter: () => void;
  subs: TrackerSubreddit[] | null;
  rules: TrackerRule[] | null;
  locale: string;
  onError: (err: unknown) => void;
  showToast?: (msg: string, kind?: 'success' | 'error') => void;
  onRemoved: () => void;
}) {
  const { t } = useT();
  const [workers, setWorkers] = useState<TrackerWorker[] | null>(null);
  const [total, setTotal] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const loadingRef = useRef(false);
  const loadedRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  loadedRef.current = workers?.length ?? 0;

  const load = useCallback((offset: number, limit: number, append: boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    trackerApi.listWorkers({ status: filter, limit, offset })
      .then(page => {
        setTotal(page.total);
        setNow(Date.now());
        setWorkers(prev => append ? [...(prev ?? []), ...page.workers] : page.workers);
      })
      .catch(onError)
      .finally(() => { loadingRef.current = false; });
  }, [filter, onError]);

  // Filter change (and mount): start over from the first page.
  useEffect(() => {
    setWorkers(null);
    setTotal(0);
    load(0, WORKERS_PAGE_SIZE, false);
  }, [load]);

  // Liveness is time-derived, so the loaded window refetches on a timer —
  // as one request covering everything currently on screen, not per page.
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) load(0, Math.max(loadedRef.current, WORKERS_PAGE_SIZE), false);
    };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  // Infinite scroll: when the sentinel under the table becomes visible and
  // more rows exist, append the next page.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting) && loadedRef.current < total) {
        load(loadedRef.current, WORKERS_PAGE_SIZE, true);
      }
    }, { rootMargin: '200px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [load, total]);

  const watched = subs?.filter(s => s.enabled).length;
  const active = rules?.filter(r => r.enabled).length;

  return (
    <section className="card fp-accounts ff-workers" aria-label={t('trkWorkers')}>
      <div className="fp-toolbar">
        <h2>{t('trkWorkers')}</h2>
        {filter !== 'all' && (
          <button type="button" className="btn ghost sm" onClick={onClearFilter}>
            <Icon name="x" size={12} />
            {t('trkShowAll')}
          </button>
        )}
        <span className="ff-summary">
          {watched === undefined || active === undefined
            ? <Skeleton width={200} height={11} />
            : t('trkWorkersSummary', { subs: watched, rules: active })}
        </span>
      </div>

      <div className="fp-table-wrap">
        <table className="fp-table ff-table" aria-busy={!workers}>
          <thead>
            <tr>
              <th>{t('trkColWorker')}</th>
              <th>{t('trkColStatus')}</th>
              {LOOPS.map(loop => <th key={loop} title={t(`trkLoopHint_${loop}`)}>{t(`trkLoop_${loop}`)}</th>)}
              <th aria-label={t('trkRemoveWorker')} />
            </tr>
          </thead>
          <tbody>
            {(workers ?? []).map(w => (
              <WorkerRow key={w.workerId} worker={w} now={now} locale={locale}
                onRemove={() => {
                  trackerApi.removeWorker(w.workerId)
                    .then(() => {
                      setWorkers(ws => (ws ?? []).filter(x => x.workerId !== w.workerId));
                      setTotal(n => Math.max(0, n - 1));
                      showToast?.(t('trkWorkerRemoved'));
                      onRemoved();
                    })
                    .catch(onError);
                }}
              />
            ))}
            {!workers && SKELETON_ROWS.map(i => <WorkerRowSkeleton key={i} />)}
            {workers?.length === 0 && (
              <tr><td colSpan={6} className="fp-empty">{filter === 'all' ? t('trkFleetEmpty') : t('trkFleetEmptyFilter')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div ref={sentinelRef} style={{ height: 1 }} />
      <div className="fp-table-foot">
        {workers
          ? t('trkFleetFoot', { shown: workers.length, n: total, age: relTime(new Date(now).toISOString(), locale) })
          : <Skeleton width={150} height={11} />}
      </div>
    </section>
  );
}

function WorkerRowSkeleton() {
  const pair = (top: number, bottom: number, topH = 13) => (
    <span className="fp-holder">
      <Skeleton width={top} height={topH} />
      <Skeleton width={bottom} height={10} />
    </span>
  );
  return (
    <tr className="ff-skel" aria-hidden>
      <td>{pair(170, 120)}</td>
      <td>{pair(56, 90, 20)}</td>
      <td><Skeleton width={56} height={12} /></td>
      <td><Skeleton width={56} height={12} /></td>
      <td><Skeleton width={56} height={12} /></td>
      <td />
    </tr>
  );
}

function WorkerRow({ worker: w, now, locale, onRemove }: {
  worker: TrackerWorker;
  now: number;
  locale: string;
  onRemove: () => void;
}) {
  const { t } = useT();
  const state = liveness(w.lastHeartbeatAt, now);
  const beat = relTime(w.lastHeartbeatAt, locale);
  return (
    <tr>
      <td className="ff-wrap">
        <span className="fp-holder">
          <span className="mono">{w.workerId}</span>
          <small>{t(w.role === 'api' ? 'trkRoleApi' : 'trkRoleWorker')} · {t('trkStarted', { age: relTime(w.startedAt, locale) })}</small>
        </span>
      </td>
      <td className="ff-wrap">
        <span className="fp-holder">
          <span><StatusChip state={state} /></span>
          <small className={state === 'live' ? undefined : 'fp-warn'}>
            {t('trkBeat', { age: beat })}
          </small>
        </span>
      </td>
      {LOOPS.map(loop => {
        // The api role runs no loops; a worker that never finished one shows a dash.
        const at = w.loops[loop]?.lastSuccessAt ?? null;
        return (
          <td key={loop} className={at ? undefined : 'fp-muted'} title={at ?? undefined}>
            {at ? relTime(at, locale) : '—'}
          </td>
        );
      })}
      <td>
        {state === 'dead' && (
          <button className="btn ghost icon sm" title={t('trkRemoveWorker')} aria-label={t('trkRemoveWorkerOf', { id: w.workerId })}
            onClick={onRemove}>
            <Icon name="trash" size={13} />
          </button>
        )}
      </td>
    </tr>
  );
}

function MatchesAside({ matches, locale }: { matches: TrackerMatch[] | Unavailable | null; locale: string }) {
  const { t } = useT();
  return (
    <aside className="card fp-activity ff-activity" aria-label={t('trkMatches')} aria-busy={!matches}>
      <div className="card-head">
        <h2 className="card-title">{t('trkMatches')}</h2>
        <span className="card-sub">{t('trkMatchesSub')}</span>
      </div>
      <ul className="fp-log">
        {Array.isArray(matches) && matches.map(m => (
          <li key={m.redditId}>
            {/* Green once the alert went out, amber while it waits for the notify loop. */}
            <i className={`fp-dot ${m.notifiedAt ? 'ff-live' : 'ff-stale'}`}
              title={m.notifiedAt ? t('trkMatchSent') : t('trkMatchQueued')} />
            <div>
              <a className="rt-match" href={m.url} target="_blank" rel="noreferrer">{m.summary ?? m.title}</a>
              <span className="rt-match-meta">
                <span className="mono">r/{m.subreddit}</span>
                {m.price && <b>{m.price}</b>}
              </span>
              <time title={m.discoveredAt}>{relTime(m.discoveredAt, locale)}</time>
            </div>
          </li>
        ))}
        {!matches && SKELETON_ROWS.map(i => (
          <li key={i} aria-hidden>
            <Skeleton width={8} height={8} radius={999} style={{ marginTop: 4 }} />
            <div className="ff-skel-lines">
              <Skeleton width={i % 2 ? 160 : 190} height={12} />
              <Skeleton width={90} height={10} />
            </div>
          </li>
        ))}
        {Array.isArray(matches) && matches.length === 0 && <li className="fp-muted rt-note">{t('trkMatchesEmpty')}</li>}
        {matches === 'unavailable' && <li className="fp-muted rt-note">{t('trkMatchesUnavailable')}</li>}
      </ul>
    </aside>
  );
}

// ─── From a post to an alert ──────────────────────────────────────────────────
// The three loops every worker runs (trackers/reddit/src/loops/), one stage
// each. Counts cover the posts discovered in the last STATS_WINDOW_MS, one
// cohort, so the stages read as a funnel; the tracker never prunes posts, so
// all-time totals only grow. Poll is where the subreddits are edited and
// Evaluate where the alert rules are; Notify has no settings this page may
// change.

type Setting = { label: string; value: string; fixed?: boolean };

function FlowCard({ stats, subs, rules, locale, onSubsChanged, onDeleteSub, onRulesChanged, onEditRule, onDeleteRule, onError, showToast }: {
  stats: TrackerStats | Unavailable | null;
  subs: TrackerSubreddit[] | null;
  rules: TrackerRule[] | null;
  locale: string;
  onSubsChanged: (update: (prev: TrackerSubreddit[] | null) => TrackerSubreddit[] | null) => void;
  onDeleteSub: (sub: TrackerSubreddit) => void;
  onRulesChanged: (update: (prev: TrackerRule[] | null) => TrackerRule[] | null) => void;
  onEditRule: (rule: TrackerRule | 'new') => void;
  onDeleteRule: (rule: TrackerRule) => void;
  onError: (err: unknown) => void;
  showToast?: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const { t } = useT();
  const [stage, setStage] = useState<LoopName>('evaluate');
  const fmt = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const posts = stats && stats !== 'unavailable' ? stats.posts : null;
  const n = (...keys: Array<keyof NonNullable<typeof posts>>) =>
    posts ? keys.reduce((sum, k) => sum + (posts[k] ?? 0), 0) : undefined;
  const counts: Record<LoopName, number | undefined> = {
    poll: n('new', 'rejected', 'target', 'notified', 'failed'),
    evaluate: n('target', 'notified'),
    notify: n('notified'),
  };

  const settings = (k: LoopName): Setting[] => {
    const v = (x: number | undefined) => (x === undefined ? '—' : fmt.format(x));
    switch (k) {
      case 'poll': {
        const on = subs?.filter(s => s.enabled) ?? [];
        const fastest = on.length ? Math.min(...on.map(s => s.poll_interval_seconds)) : null;
        return [
          { label: t('trkSetWatched'), value: subs ? `${on.length} / ${subs.length}` : '—' },
          { label: t('trkSetFastest'), value: fastest === null ? '—' : `${fastest} s` },
          { label: t('trkSetErroring'), value: subs ? String(on.filter(s => s.consecutive_errors > 0).length) : '—' },
          { label: t('trkSetFloor'), value: `${MIN_POLL_INTERVAL_S} s`, fixed: true },
        ];
      }
      case 'evaluate': {
        const oldest = stats && stats !== 'unavailable' ? stats.oldestPending : null;
        return [
          { label: t('trkSetRules'), value: rules ? `${rules.filter(r => r.enabled).length} / ${rules.length}` : '—' },
          { label: t('trkSetPending'), value: v(n('new')) },
          { label: t('trkSetRejected'), value: v(n('rejected')) },
          { label: t('trkSetOldest'), value: oldest ? relTime(oldest.discovered_at, locale) : '—' },
          { label: t('trkSetBatch'), value: '3', fixed: true },
        ];
      }
      case 'notify': return [
        { label: t('trkSetQueued'), value: v(n('target')) },
        { label: t('trkSetFailed'), value: v(n('failed')) },
        { label: t('trkSetOnce'), value: t('trkSetOnceValue'), fixed: true },
        { label: t('trkSetBatch'), value: '5', fixed: true },
      ];
    }
  };

  const failed = stats && stats !== 'unavailable' ? stats.failed : [];

  return (
    <section className="card ff-flow" aria-label={t('trkFlowTitle')}>
      <div className="card-head">
        <h2 className="card-title">{t('trkFlowTitle')}</h2>
        <span className="card-sub">{t('trkFlowSub')}</span>
      </div>
      <div className="ff-flow-row" role="tablist" aria-label={t('trkFlowTitle')}>
        {LOOPS.map(k => (
          <button key={k} type="button" role="tab" aria-selected={stage === k}
            className={`ff-stage${k === 'poll' ? '' : ' ff-stage-key'}`} onClick={() => setStage(k)}>
            <span className="ff-stage-title">{t(`trkLoop_${k}`)}</span>
            {stats === null ? <>
              <span className="ff-stage-n"><Skeleton width={46} height={20} /></span>
              <span className="ff-stage-unit"><Skeleton width={64} height={10} /></span>
            </> : <>
              <span className="ff-stage-n">{counts[k] === undefined ? '—' : fmt.format(counts[k])}</span>
              <span className="ff-stage-unit">{counts[k] === undefined ? t('trkFlowNotCounted') : t(`trkFlowUnit_${k}`)}</span>
            </>}
          </button>
        ))}
      </div>
      {/* Every stage renders into the same cell and only the picked one
          shows, as on the Facebook page: picking a stage never moves the page. */}
      <div className="ff-flow-stack">
        {LOOPS.map(k => {
          const shown = k === stage;
          return (
            <div key={k} className={`ff-flow-detail${k === 'notify' ? '' : ' ff-flow-detail-rules'}${shown ? '' : ' ff-flow-ghost'}`}
              role={shown ? 'tabpanel' : undefined} aria-hidden={!shown || undefined} {...(shown ? {} : { inert: '' })}>
              <div>
                <div className="ff-flow-head">
                  <h3>{t(`trkLoop_${k}`)}</h3>
                  <span className="mono fp-muted">loops/{k}.ts</span>
                </div>
                <p className="ff-flow-what">{t(`trkFlowWhat_${k}`)}</p>
                <div className="ff-settings">
                  {settings(k).map(s => (
                    <span key={s.label} className={`ff-setting${s.fixed ? ' ff-fixed' : ''}`}
                      title={s.fixed ? t('trkFixedHint') : undefined}>
                      {s.label} <b>{s.value}</b>
                    </span>
                  ))}
                </div>
              </div>
              <div className="ff-flow-extra">
                {k === 'poll' && (
                  <SubredditsPanel subs={subs} locale={locale} onChanged={onSubsChanged} onDelete={onDeleteSub}
                    onError={onError} showToast={showToast} />
                )}
                {k === 'evaluate' && (
                  <RulesPanel rules={rules} onChanged={onRulesChanged} onEdit={onEditRule} onDelete={onDeleteRule}
                    onError={onError} />
                )}
                {k === 'notify' && (
                  <>
                    <div className="fp-section-label">{t('trkFailedTitle')}</div>
                    {failed.length
                      ? <ul className="rt-failed">
                          {failed.slice(0, 8).map(f => (
                            <li key={f.reddit_id}>
                              <span>{f.title}</span>
                              <small className="fp-muted">{t('trkFailedAttempts', { n: f.attempts })}</small>
                            </li>
                          ))}
                        </ul>
                      : <span className="fp-muted">{stats && stats !== 'unavailable' ? t('trkFailedNone') : '—'}</span>}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function RulesPanel({ rules, onChanged, onEdit, onDelete, onError }: {
  rules: TrackerRule[] | null;
  onChanged: (update: (prev: TrackerRule[] | null) => TrackerRule[] | null) => void;
  onEdit: (rule: TrackerRule | 'new') => void;
  onDelete: (rule: TrackerRule) => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useT();
  return (
    <>
      <div className="fp-row fp-between">
        <div className="fp-section-label">{t('trkRulesTitle')}</div>
        <button className="btn primary sm" onClick={() => onEdit('new')}>
          <Icon name="plus" size={13} />
          {t('trkNewRule')}
        </button>
      </div>
      <div className="rt-panel">
        {!rules && [0, 1, 2].map(i => (
          <div key={i} className="rt-rule" aria-hidden>
            <div className="ff-skel-lines"><Skeleton width={140} height={13} /><Skeleton width={260} height={10} /></div>
          </div>
        ))}
        {rules?.length === 0 && <div className="fp-empty">{t('trkRulesEmpty')}</div>}
        {(rules ?? []).map(rule => (
          <div key={rule.id} className={`rt-rule${rule.enabled ? '' : ' rt-off'}`}>
            <div className="rt-rule-text">
              <b>{rule.name}</b>
              <p>{rule.prompt}</p>
            </div>
            <Toggle
              checked={rule.enabled}
              onChange={enabled => {
                trackerApi.updateRule(rule.id, { enabled })
                  .then(updated => onChanged(rs => (rs ?? []).map(r => r.id === updated.id ? updated : r)))
                  .catch(onError);
              }}
            />
            <button className="btn ghost icon sm" title={t('trkEditRule')} onClick={() => onEdit(rule)}>
              <Icon name="edit" size={13} />
            </button>
            <button className="btn ghost icon sm" title={t('trkDeleteRule')} onClick={() => onDelete(rule)}>
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
      </div>
      <span className="fp-muted rt-help">{t('trkRulesSub')}</span>
    </>
  );
}

function SubredditsPanel({ subs, locale, onChanged, onDelete, onError, showToast }: {
  subs: TrackerSubreddit[] | null;
  locale: string;
  onChanged: (update: (prev: TrackerSubreddit[] | null) => TrackerSubreddit[] | null) => void;
  onDelete: (sub: TrackerSubreddit) => void;
  onError: (err: unknown) => void;
  showToast?: (msg: string, kind?: 'success' | 'error') => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [interval, setIntervalStr] = useState('90');
  const [formError, setFormError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function add() {
    const normalized = normalizeSubredditName(name);
    if (!normalized) {
      setFormError(t('trkSubInvalidName'));
      return;
    }
    const seconds = Number(interval);
    if (!Number.isFinite(seconds) || seconds < MIN_POLL_INTERVAL_S) {
      setFormError(t('trkSubInvalidInterval'));
      return;
    }
    setFormError(null);
    setAdding(true);
    trackerApi.addSubreddit({ name: normalized, pollIntervalSeconds: Math.floor(seconds) })
      .then(added => {
        onChanged(prev => {
          const list = (prev ?? []).filter(s => s.name !== added.name);
          return [...list, added].sort((a, b) => a.name.localeCompare(b.name));
        });
        setName('');
        setIntervalStr('90');
        showToast?.(t('trkSubAdded'));
      })
      .catch(onError)
      .finally(() => setAdding(false));
  }

  return (
    <>
      <div className="fp-section-label">{t('trkSubsTitle')}</div>
      <div className="rt-panel">
        <div className="rt-add">
          <label className="rt-add-name">
            <span className="rt-prefix" aria-hidden>r/</span>
            <input className="input" placeholder="homelabsales" aria-label={t('trkSubName')} autoComplete="off"
              value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') add(); }} />
          </label>
          <label className="rt-add-interval">
            <span className="fp-muted">{t('trkEvery')}</span>
            <input className="input" inputMode="numeric" aria-label={t('trkInterval')}
              value={interval} onChange={e => setIntervalStr(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') add(); }} />
            <span className="fp-muted">s</span>
          </label>
          <button className="btn primary sm" onClick={add} disabled={adding}>
            <Icon name="plus" size={13} />
            {t('trkAddSub')}
          </button>
        </div>
        {formError && <div className="rt-add-error">{formError}</div>}
        <div className="fp-table-wrap">
          <table className="fp-table">
            <thead>
              <tr>
                <th>{t('trkSubName')}</th>
                <th>{t('trkColLastPolled')}</th>
                <th>{t('trkColClaimedBy')}</th>
                <th>{t('trkColEnabled')}</th>
                <th aria-label={t('trkDeleteSub')} />
              </tr>
            </thead>
            <tbody>
              {(subs ?? []).map(sub => <SubredditRow key={sub.name} sub={sub} locale={locale}
                onChanged={onChanged} onDelete={onDelete} onError={onError} />)}
              {!subs && [0, 1, 2].map(i => (
                <tr key={i} aria-hidden>
                  <td><Skeleton width={120} height={13} /></td>
                  <td><Skeleton width={70} height={12} /></td>
                  <td><Skeleton width={90} height={12} /></td>
                  <td><Skeleton width={30} height={16} radius={999} /></td>
                  <td />
                </tr>
              ))}
              {subs?.length === 0 && <tr><td colSpan={5} className="fp-empty">{t('trkSubsEmpty')}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <span className="fp-muted rt-help">{t('trkSubNameHelp')} {t('trkIntervalHelp')}</span>
    </>
  );
}

function SubredditRow({ sub, locale, onChanged, onDelete, onError }: {
  sub: TrackerSubreddit;
  locale: string;
  onChanged: (update: (prev: TrackerSubreddit[] | null) => TrackerSubreddit[] | null) => void;
  onDelete: (sub: TrackerSubreddit) => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useT();
  const erroring = sub.enabled && sub.consecutive_errors > 0;
  const status = !sub.enabled ? null
    : erroring ? t('trkSubErrors', { n: sub.consecutive_errors, status: sub.last_status ?? '—' })
    : sub.last_status;
  return (
    <tr className={sub.enabled ? undefined : 'rt-off'}>
      <td>
        <span className="fp-holder">
          <span className="mono">r/{sub.name}</span>
          <small>{t('trkEveryN', { n: sub.poll_interval_seconds })}</small>
        </span>
      </td>
      <td>
        <span className="fp-holder">
          <span className={sub.last_polled_at ? undefined : 'fp-muted'}>
            {sub.last_polled_at ? relTime(sub.last_polled_at, locale) : t('trkNever')}
          </span>
          {status && <small className={erroring ? 'fp-warn' : undefined}>{status}</small>}
        </span>
      </td>
      <td className={sub.claimed_by ? 'mono' : 'fp-muted'}>{sub.claimed_by ?? '—'}</td>
      <td>
        <Toggle checked={sub.enabled} onChange={enabled => {
          trackerApi.updateSubreddit(sub.name, { enabled })
            .then(updated => onChanged(prev => (prev ?? []).map(s => s.name === updated.name ? updated : s)))
            .catch(onError);
        }} />
      </td>
      <td>
        <button className="btn ghost icon sm" title={t('trkDeleteSub')} onClick={() => onDelete(sub)}>
          <Icon name="trash" size={13} />
        </button>
      </td>
    </tr>
  );
}

function RuleModal({ rule, onClose, onSaved, onError }: {
  rule: TrackerRule | null;
  onClose: () => void;
  onSaved: (rule: TrackerRule) => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState(rule?.name ?? '');
  const [prompt, setPrompt] = useState(rule?.prompt ?? '');
  const [saving, setSaving] = useState(false);
  const canSave = name.trim() !== '' && prompt.trim() !== '';

  function save() {
    if (!canSave || saving) return;
    setSaving(true);
    const request = rule
      ? trackerApi.updateRule(rule.id, { name: name.trim(), prompt: prompt.trim() })
      : trackerApi.createRule({ name: name.trim(), prompt: prompt.trim() });
    request.then(onSaved).catch(onError).finally(() => setSaving(false));
  }

  return (
    <Modal onClose={onClose} ariaLabel={rule ? t('trkEditRule') : t('trkNewRule')} shellStyle={{ width: 520 }}>
      <div className="modal-head">
        <div className="modal-title">{rule ? t('trkEditRule') : t('trkNewRule')}</div>
      </div>
      <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="field">
          <label className="label" htmlFor="trk-rule-name">{t('trkRuleName')}</label>
          <input id="trk-rule-name" className="input" value={name}
            onChange={e => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="trk-rule-prompt">{t('trkRulePrompt')}</label>
          <textarea id="trk-rule-prompt" className="textarea" rows={6} value={prompt}
            onChange={e => setPrompt(e.target.value)} />
          <span className="help">{t('trkRulePromptHelp')}</span>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>{t('cancel')}</button>
        <button className="btn primary" disabled={!canSave || saving} onClick={save}>
          {t('save')}
        </button>
      </div>
    </Modal>
  );
}
