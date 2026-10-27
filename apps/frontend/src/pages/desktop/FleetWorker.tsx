import { FB_PROXY_DEAD_AFTER, type FbStintOutcome } from '@recycle-erp/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { ImageLightbox } from '../../components/ImageLightbox';
import { FormSkeleton } from '../../components/Skeleton';
import { ApiError } from '../../lib/api';
import {
  challengeScreenshotUrl, coordinatorApi, type AlertHitRow, type Challenge, type FleetAccount, type FleetDoc, type LedgerLogin,
} from '../../lib/coordinator';
import { handleFetchError, showSuccessToast } from '../../lib/errorToast';
import { loginTone, poolApi, proxyMarkFor, type FbProxyMark, type FbWorkerStint } from '../../lib/facebookPool';
import {
  accountAlerts, browserLabel, canWatch, externalVncUrl, fleetActivity, fleetStatus, hitsByCity, parkedWorkers, retiredAt, searchedToday, SESSION_WARN_DAYS, whoIs,
  workerHistory, type HistoryLine,
} from '../../lib/fleetView';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { BuildChip, CityChip, EditCredentialsButton, fmtDays, HITS_DAYS, ReloginButton, WatchButton } from './FleetAccounts';
import { EditCitiesButton } from './FleetCities';
import { CityLogCard, loadCityLog, type CityLogState } from './FleetCityLog';
import { QueueButton, QueueField } from './FleetQueue';
import { eventDetail, ProxyDeadChip, statusNote } from './FleetWorkers';
import {
  AccountsUsed, CheckpointsCard, LOGIN_DOT, LoginWords, Muted, NoThumb, WorkerCard, WorkerHead, WorkerHistory, WorkerMissing,
  type HistoryEntry, type WorkerField,
} from './fleet/workerDetail';
import '../../styles/facebookPool.css';

// ─── One worker ───────────────────────────────────────────────────────────────
// Opened from the eye on the fleet list. Everything known about one Facebook
// worker in the Account pool's credential-card style, its open checkpoints
// and recent events, and every action the control plane offers on it today:
// watch its browser, queue a re-login, set its credentials, set its cities
// (FleetCities.tsx), clear a checkpoint, revive a DEAD proxy. Under them, every
// pool account it has signed in with; beside them all, the worker's History.
// Pacing still lives in fleet.toml. The layout is fleet/workerDetail.tsx,
// which the ERP fleet's worker page shares.

const REFRESH_MS = 30_000;

export type LedgerLogins = LedgerLogin[] | 'not_served' | 'unreachable' | null;

export function FleetWorker({ workerId }: { workerId: string }) {
  const { t } = useT();
  const [fleet, setFleet] = useState<FleetDoc | null>(null);
  const [challenges, setChallenges] = useState<Challenge[] | null>(null);
  const [hits, setHits] = useState<AlertHitRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [marks, setMarks] = useState<FbProxyMark[] | null>(null);
  const [stints, setStints] = useState<FbWorkerStint[] | null>(null);
  const [logins, setLogins] = useState<LedgerLogins>(null);
  const [cityLog, setCityLog] = useState<CityLogState>(null);

  const load = useCallback(() => {
    coordinatorApi.fleet().then(doc => { setFleet(doc); setFailed(false); }).catch(err => {
      if (!(err instanceof ApiError)) handleFetchError(err);
      setFailed(true);
    });
    coordinatorApi.listOpenChallenges().then(setChallenges).catch(() => setChallenges([]));
    coordinatorApi.alertHits(HITS_DAYS).then(setHits).catch(() => setHits([]));
    poolApi.proxies().then(r => setMarks(r.proxies)).catch(() => setMarks([]));
    poolApi.workerAccounts(workerId).then(r => setStints(r.stints)).catch(() => setStints([]));
    coordinatorApi.workerLogins(workerId).then(setLogins)
      .catch(err => setLogins(err instanceof ApiError && err.status === 404 ? 'not_served' : 'unreachable'));
    loadCityLog({ worker: workerId }, setCityLog);
  }, [workerId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) load(); };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [load]);

  if (!fleet) return failed ? <WorkerMissing workerId={workerId} note={t('fbcFleetUnavailableNote')} /> : <FormSkeleton fields={6} />;
  return (
    <HomelabWorkerView workerId={workerId} fleet={fleet} challenges={challenges} hits={hits} marks={marks} stints={stints}
      logins={logins} cityLog={cityLog} onReload={load} onMarks={setMarks} />
  );
}

/** The coordinator worker's page, from what the loader read. */
export function HomelabWorkerView({ workerId, fleet, challenges, hits, marks, stints, logins, cityLog, onReload, onMarks }: {
  workerId: string; fleet: FleetDoc; challenges: Challenge[] | null; hits: AlertHitRow[] | null; marks: FbProxyMark[] | null;
  stints: FbWorkerStint[] | null; logins: LedgerLogins; cityLog: CityLogState; onReload: () => void; onMarks: (m: FbProxyMark[]) => void;
}) {
  const { t, locale } = useT();
  const [zoom, setZoom] = useState<Challenge | null>(null);
  const [resolving, setResolving] = useState<number | null>(null);
  const byCity = useMemo(() => hitsByCity(hits ?? []), [hits]);
  const parked = useMemo(() => parkedWorkers(challenges), [challenges]);

  const w = fleet.workers.find(x => x.worker_id === workerId);
  if (!w) return <WorkerMissing workerId={workerId} note={t('fbcWorkerMissing')} />;

  const h = w.health;
  const who = whoIs(w);
  const name = who.login ?? who.label ?? w.worker_id;
  const status = fleetStatus(w, parked);
  // A retired worker has no container, so its page is a record: the date
  // replaces the status note and there is nothing to log back in.
  const retired = retiredAt(w);
  const note = retired ? t('fleetRetiredOn', { date: new Date(retired).toLocaleDateString(locale) }) : statusNote(t, w, parked, locale);
  const searched = searchedToday(w, status);
  const mine = (challenges ?? []).filter(c => c.worker_id === w.worker_id);
  const events = fleetActivity({
    ...fleet, workers: [w], status_changes: fleet.status_changes?.filter(c => c.worker_id === w.worker_id),
  }, mine);
  const history = workerHistory(events, stints ?? [], Array.isArray(logins) ? logins : []);
  const acct = w.account;
  const sess = w.session;
  const mark = proxyMarkFor(marks, w);
  const stored = acct ? Object.entries(acct.secrets).filter(([, on]) => on).map(([k]) => k) : [];
  const configVnc = canWatch(w) ? null
    : externalVncUrl(w.vnc_url) ?? externalVncUrl(h?.vnc_url) ?? externalVncUrl(acct?.vnc_url);
  const pace = w.pacing.search_interval
    ? `${t('fbcPacingText', { pace: `${w.pacing.search_interval} – ${w.pacing.max_search_interval ?? w.pacing.search_interval}` })}${w.pacing.overridden ? ` · ${t('fbcPacingOverride')}` : ''}`
    : t('fbcPacingDefault');

  const fields: WorkerField[] = [
    { label: t('fbcDetailFbLogin'), value: who.login ?? <Muted>{t('fbcNotInVault')}</Muted> },
    { label: t('fbcDetailFbUser'), value: who.userId
      ? <a className="mono" href={`https://www.facebook.com/profile.php?id=${encodeURIComponent(who.userId)}`} target="_blank" rel="noopener">{who.userId}</a>
      : <Muted>{t('fbcFbUserUnknown')}</Muted> },
    { label: t('fbcDetailVaultAccount'), value: acct
      ? <>{acct.account_id}{acct.allow_password_login && <> <span className="chip warn">{t('fbcPasswordLoginOn')}</span></>}</>
      : <Muted>{t('fbcNoVaultAccount')}</Muted> },
    { label: t('fbcDetailSecrets'), value: stored.length ? stored.map(k => <span key={k} className="chip muted mono" style={{ marginRight: 4 }}>{k}</span>) : <Muted>{t('fbcNone')}</Muted> },
    { label: t('fbcColSession'), value: h?.session_expiry
      ? <span className={h.session_days_left !== null && h.session_days_left <= SESSION_WARN_DAYS ? 'fp-warn' : 'fp-ok'} title={h.session_expiry}>{fmtDays(t, h.session_days_left)}</span>
      : <Muted>—</Muted> },
    { label: t('fbcDetailUa'), value: browserLabel(sess?.user_agent) ? <span title={sess?.user_agent ?? undefined}>{browserLabel(sess?.user_agent)}</span> : <Muted>—</Muted> },
    { label: t('fbcDetailBackup'), value: sess?.backed_up_at ? <span title={sess.backed_up_at}>{relTime(sess.backed_up_at, locale)}</span> : <Muted>{t('fbcNeverBackedUp')}</Muted> },
    { label: t('fbcDetailProxy'), value: <>
      <ProxyExit worker={w} />
      {mark && <ProxyMarkNote mark={mark} onRevived={onMarks} />}
    </> },
    ...(w.queue ? [{ label: t('fbcQueueField'), value: <QueueField worker={w} fleet={fleet} />, wrap: true }] : []),
    // An enrolled worker's own list is only where the queue starts it.
    { label: w.queue?.enrolled && w.queue.capable ? t('fbcQueueHomeLabel') : t('fbcColCities'), wrap: true, value: w.cities.length
      ? <span className="fl-cities ff-wrap-cell">{w.cities.map(c => <CityChip key={c.slug} city={c} hits={byCity} terms={[]} tone={searched(c.slug) ? 'accent' : 'muted'} runsPerDay={w.plan?.runs_per_day} />)}</span>
      : <Muted>{t('fbcNoCities')}</Muted> },
    { label: t('fbcFoldPacing'), value: pace },
    { label: t('fbcDetailSessionFile'), value: w.session_file ? <span className="mono">{w.session_file}</span> : <Muted>—</Muted> },
    { label: t('fbcColBuild'), value: <BuildChip health={h} coordinatorVersion={fleet.versions.coordinator} /> },
  ];

  return (
    <div className="fp-pool">
      <WorkerHead title={name} status={status}
        sub={<><span className="mono">{w.worker_id}</span> · {w.region.name}{note && ` · ${note}`}</>} />

      <div className="ff-worker-layout">
        <div className="ff-worker-main">
          <WorkerCard name={name} status={status} userId={who.userId}
            stubNote={h ? t('fbcHeartbeatAge', { age: h.last_heartbeat_at ? relTime(h.last_heartbeat_at, locale) : t('fbcNever') }) : t('fbcNotDeployed')}
            headSub={<>{w.region.name} · {t('fbcCities', { n: w.cities.length })}</>}
            stats={[
              { label: t('fbcColAlerts', { days: HITS_DAYS }), value: h ? accountAlerts(w, byCity) : '—' },
              { label: t('fbcColLastSearch'), value: h?.last_search_at ? relTime(h.last_search_at, locale) : '—' },
              { label: t('fbcDetailLastListing'), value: h?.last_listing_at ? relTime(h.last_listing_at, locale) : '—' },
              { label: t('fbcDetailErrors'), value: h ? h.error_count : '—' },
              { label: t('fbcOpenCheckpoints'), value: mine.length },
            ]}
            fields={fields}
            actions={<>
              {canWatch(w)
                ? <WatchButton workerId={w.worker_id} className="btn" />
                : configVnc
                  ? <a className="btn" href={configVnc} target="_blank" rel="noopener"><Icon name="eye" size={13} />{t('fbcOpenVnc')}</a>
                  : <span className="fp-muted" style={{ fontSize: 12 }}>{t('fbcNoVnc')}</span>}
              {h && !retired && <ReloginButton workerId={w.worker_id} account={w} className="btn" onQueued={onReload} offerWatch={canWatch(w)} />}
              <EditCredentialsButton account={w} onSaved={onReload} className="btn" />
              {w.cities_editable && <EditCitiesButton worker={w} fleet={fleet} onSaved={onReload} />}
              <QueueButton worker={w} onSaved={onReload} />
            </>} />

          <CheckpointsCard sub={t('fbcCheckpointsSub')} items={mine.map(c => ({
            key: c.id,
            thumb: <Thumbnail challenge={c} onZoom={() => setZoom(c)} />,
            kind: c.kind,
            what: <><span className="mono">{w.worker_id}</span> {t('fbcAttnParked', { kind: c.kind })}</>,
            sub: <>{t('fbcFlagged', { age: relTime(c.created_at, locale) })}{c.account_id && ` · ${c.account_id}`} · {t('fbcAttnClearIt')}</>,
            actions: <>
              {canWatch(w) && <WatchButton workerId={w.worker_id} />}
              <button type="button" className="btn primary sm" disabled={resolving === c.id}
                onClick={() => {
                  setResolving(c.id);
                  coordinatorApi.resolveChallenge(c.id)
                    .then(() => { showSuccessToast(t('fbcResolved')); onReload(); })
                    .catch(handleFetchError)
                    .finally(() => setResolving(null));
                }}>
                <Icon name="check" size={13} />{t('fbcResolve')}
              </button>
            </>,
          }))} />

          <AccountsUsed stints={stints} locale={locale} />
          <CityLogCard log={cityLog} />
        </div>
        <WorkerHistory entries={history.map(historyEntry)} locale={locale}
          note={logins === 'not_served' ? t('fbcHistLoginsNotServed') : logins === 'unreachable' ? t('fbcHistLoginsUnreachable') : null} />
      </div>

      {zoom && (
        <ImageLightbox url={challengeScreenshotUrl(zoom.id)} alt={t('fbcScreenshotAlt', { id: zoom.worker_id })}
          onClose={() => setZoom(null)} />
      )}
    </div>
  );
}

// The proxy as Facebook sees it: the URL dialled, then the address and city it
// exits from. A facade that predates the lookup sends only the env var's name.
export function ProxyExit({ worker }: { worker: FleetAccount }) {
  const { t } = useT();
  const p = worker.proxy;
  if (!p) {
    return worker.proxy_env ? <span className="mono">${worker.proxy_env}</span> : <span className="fp-muted">{t('fbcOwnIp')}</span>;
  }
  const where = [p.city, p.region, p.country].filter(Boolean).join(', ');
  return (
    <span>
      {p.url
        ? <span className="mono">{p.url}</span>
        : <span className="fp-muted">{worker.proxy_env ? t('fbcProxyUnset', { env: `$${worker.proxy_env}` }) : t('fbcOwnIp')}</span>}
      <br />
      <small className={p.error ? 'fp-warn' : 'fp-muted'} title={p.org ?? undefined}>
        {p.pending ? t('fbcProxyLookingUp')
          : p.error ? t('fbcProxyLookupFailed')
          : <><span className="mono">{p.ip ?? '—'}</span>{where && ` · ${where}`}</>}
      </small>
    </span>
  );
}

// How many accounts failed behind the proxy since its last revive. Revive is
// for after the IP behind it has been swapped: the count starts again.
function ProxyMarkNote({ mark, onRevived }: { mark: FbProxyMark; onRevived: (marks: FbProxyMark[]) => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const revive = () => {
    setBusy(true);
    poolApi.reviveProxy(mark.url)
      .then(r => { onRevived(r.proxies); showSuccessToast(t('fbcProxyRevived', { url: mark.url })); })
      .catch(handleFetchError)
      .finally(() => setBusy(false));
  };
  return (
    <div className="ff-proxy-mark">
      {mark.dead && <ProxyDeadChip mark={mark} />}
      <small className={mark.dead ? 'fp-bad' : 'fp-warn'}>
        {t(mark.dead ? 'fbcProxyDeadNote' : 'fbcProxyFailedNote', { n: mark.failed, max: FB_PROXY_DEAD_AFTER })}
      </small>
      {mark.dead && (
        <button type="button" className="btn sm" disabled={busy} onClick={revive} title={t('fbcProxyReviveHint')}>
          <Icon name="refresh" size={12} />{t('fbcProxyRevive')}
        </button>
      )}
    </div>
  );
}

const LEFT_DOT: Partial<Record<FbStintOutcome, string>> = { problem: 'ff-attention', retired: 'ff-offline', removed: 'ff-offline' };

function historyDot(line: HistoryLine): string {
  if (line.kind === 'event') {
    const e = line.event;
    return `ff-${e.status ?? (e.kind === 'checkpoint' || e.kind === 'silent' ? 'attention' : 'live')}`;
  }
  if (line.kind === 'login') return LOGIN_DOT[loginTone(line.login.outcome)];
  if (line.kind === 'left' && line.stint.outcome) return LEFT_DOT[line.stint.outcome] ?? 'ff-tl-muted';
  return 'ff-tl-muted';
}

function historyEntry(line: HistoryLine): HistoryEntry {
  return {
    at: line.at,
    dot: historyDot(line),
    text: <HistoryText line={line} />,
    since: line.kind === 'login' && line.count > 1 ? line.since : undefined,
  };
}

function HistoryText({ line }: { line: HistoryLine }) {
  const { t } = useT();
  if (line.kind === 'event') return <>{t(`fbcHist_${line.event.kind}`, { kind: eventDetail(t, line.event) })}</>;
  if (line.kind === 'signon') {
    return <>{t('fbcHistSignOn', { n: line.stint.accountNo, login: line.stint.email ?? line.stint.uid })}</>;
  }
  if (line.kind === 'left') {
    return <>{t('fbcHistLeft', { n: line.stint.accountNo, outcome: t(`fbcStint_${line.stint.outcome}`) })}</>;
  }
  const l = line.login;
  return (
    <>
      {line.accountNo !== null && <span className="mono">#{line.accountNo} </span>}
      <LoginWords outcome={l.outcome} detail={l.detail?.kind ?? null} trigger={l.trigger} count={line.count}
        url={l.detail?.url ?? null} />
    </>
  );
}

function Thumbnail({ challenge, onZoom }: { challenge: Challenge; onZoom: () => void }) {
  const { t } = useT();
  const [broken, setBroken] = useState(false);
  if (!challenge.screenshot_url || broken) return <NoThumb />;
  return (
    <button type="button" className="ff-thumb" onClick={onZoom} title={t('fbcZoom')} style={{ cursor: 'zoom-in' }}>
      <img src={challengeScreenshotUrl(challenge.id)} alt={t('fbcScreenshotAlt', { id: challenge.worker_id })}
        onError={() => setBroken(true)} />
    </button>
  );
}
