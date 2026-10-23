import { FB_FAILED_OUTCOMES, FB_PROXY_DEAD_AFTER, type FbStintOutcome } from '@recycle-erp/shared';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { ImageLightbox } from '../../components/ImageLightbox';
import { FormSkeleton } from '../../components/Skeleton';
import { ApiError } from '../../lib/api';
import {
  challengeScreenshotUrl, coordinatorApi, type AlertHitRow, type Challenge, type FleetAccount, type FleetDoc,
} from '../../lib/coordinator';
import { handleFetchError, showSuccessToast } from '../../lib/errorToast';
import { poolApi, proxyMarkFor, type FbProxyMark, type FbWorkerStint } from '../../lib/facebookPool';
import {
  accountAlerts, browserLabel, canWatch, externalVncUrl, fleetActivity, fleetStatus, hitsByCity, parkedWorkers, searchedToday, SESSION_WARN_DAYS, whoIs,
} from '../../lib/fleetView';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { hrefFor, onLinkClick } from '../../lib/route';
import { BuildChip, CityChip, EditCredentialsButton, fmtDays, HITS_DAYS, ReloginButton, WatchButton } from './FleetAccounts';
import { EditCitiesButton } from './FleetCities';
import { eventDetail, ProxyDeadChip, StatusChip, statusNote } from './FleetWorkers';
import '../../styles/facebookPool.css';

// ─── One worker ───────────────────────────────────────────────────────────────
// Opened from the eye on the fleet list. Everything known about one Facebook
// worker in the Account pool's credential-card style, its open checkpoints
// and recent events, and every action the control plane offers on it today:
// watch its browser, queue a re-login, set its credentials, set its cities
// (FleetCities.tsx), clear a checkpoint, revive a DEAD proxy. Under them, every
// pool account it has signed in with. Pacing still lives in fleet.toml.

const REFRESH_MS = 30_000;
const STUB_TONE = { live: 'accent', stale: 'warn', attention: 'warn', offline: 'neg' } as const;

export function FleetWorker({ workerId }: { workerId: string }) {
  const { t, locale } = useT();
  const [fleet, setFleet] = useState<FleetDoc | null>(null);
  const [challenges, setChallenges] = useState<Challenge[] | null>(null);
  const [hits, setHits] = useState<AlertHitRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState<Challenge | null>(null);
  const [resolving, setResolving] = useState<number | null>(null);
  const [marks, setMarks] = useState<FbProxyMark[] | null>(null);
  const [stints, setStints] = useState<FbWorkerStint[] | null>(null);

  const load = useCallback(() => {
    coordinatorApi.fleet().then(doc => { setFleet(doc); setFailed(false); }).catch(err => {
      if (!(err instanceof ApiError)) handleFetchError(err);
      setFailed(true);
    });
    coordinatorApi.listOpenChallenges().then(setChallenges).catch(() => setChallenges([]));
    coordinatorApi.alertHits(HITS_DAYS).then(setHits).catch(() => setHits([]));
    poolApi.proxies().then(r => setMarks(r.proxies)).catch(() => setMarks([]));
    poolApi.workerAccounts(workerId).then(r => setStints(r.stints)).catch(() => setStints([]));
  }, [workerId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) load(); };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [load]);

  const byCity = useMemo(() => hitsByCity(hits ?? []), [hits]);
  const parked = useMemo(() => parkedWorkers(challenges), [challenges]);
  const back = (
    <a className="fl-back" href={hrefFor('/fleet')} onClick={onLinkClick('/fleet')}>
      <Icon name="chevronLeft" size={13} />{t('fbcFleetTitle')}
    </a>
  );

  if (!fleet) {
    return failed
      ? <div className="page-head"><div>{back}<h1 className="page-title mono">{workerId}</h1><div className="page-sub">{t('fbcFleetUnavailableNote')}</div></div></div>
      : <FormSkeleton fields={6} />;
  }
  const w = fleet.workers.find(x => x.worker_id === workerId);
  if (!w) {
    return <div className="page-head"><div>{back}<h1 className="page-title mono">{workerId}</h1><div className="page-sub">{t('fbcWorkerMissing')}</div></div></div>;
  }

  const h = w.health;
  const who = whoIs(w);
  const name = who.login ?? who.label ?? w.worker_id;
  const status = fleetStatus(w, parked);
  const note = statusNote(t, w, parked, locale);
  const searched = searchedToday(w, status);
  const mine = (challenges ?? []).filter(c => c.worker_id === w.worker_id);
  const events = fleetActivity({
    ...fleet, workers: [w], status_changes: fleet.status_changes?.filter(c => c.worker_id === w.worker_id),
  }, mine);
  const acct = w.account;
  const sess = w.session;
  const mark = proxyMarkFor(marks, w);
  const stored = acct ? Object.entries(acct.secrets).filter(([, on]) => on).map(([k]) => k) : [];
  const configVnc = canWatch(w) ? null
    : externalVncUrl(w.vnc_url) ?? externalVncUrl(h?.vnc_url) ?? externalVncUrl(acct?.vnc_url);
  const pace = w.pacing.search_interval
    ? `${t('fbcPacingText', { pace: `${w.pacing.search_interval} – ${w.pacing.max_search_interval ?? w.pacing.search_interval}` })}${w.pacing.overridden ? ` · ${t('fbcPacingOverride')}` : ''}`
    : t('fbcPacingDefault');
  const muted = (text: string) => <span className="fp-muted">{text}</span>;
  const initials = name.replace(/[^a-z0-9]/gi, ' ').trim().split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase() || '?';

  const fields: Array<[string, ReactNode]> = [
    [t('fbcDetailFbLogin'), who.login ?? muted(t('fbcNotInVault'))],
    [t('fbcDetailFbUser'), who.userId
      ? <a className="mono" href={`https://www.facebook.com/profile.php?id=${encodeURIComponent(who.userId)}`} target="_blank" rel="noopener">{who.userId}</a>
      : muted(t('fbcFbUserUnknown'))],
    [t('fbcDetailVaultAccount'), acct
      ? <>{acct.account_id}{acct.allow_password_login && <> <span className="chip warn">{t('fbcPasswordLoginOn')}</span></>}</>
      : muted(t('fbcNoVaultAccount'))],
    [t('fbcDetailSecrets'), stored.length ? stored.map(k => <span key={k} className="chip muted mono" style={{ marginRight: 4 }}>{k}</span>) : muted(t('fbcNone'))],
    [t('fbcColSession'), h?.session_expiry
      ? <span className={h.session_days_left !== null && h.session_days_left <= SESSION_WARN_DAYS ? 'fp-warn' : 'fp-ok'} title={h.session_expiry}>{fmtDays(t, h.session_days_left)}</span>
      : muted('—')],
    [t('fbcDetailUa'), browserLabel(sess?.user_agent) ? <span title={sess?.user_agent ?? undefined}>{browserLabel(sess?.user_agent)}</span> : muted('—')],
    [t('fbcDetailBackup'), sess?.backed_up_at ? <span title={sess.backed_up_at}>{relTime(sess.backed_up_at, locale)}</span> : muted(t('fbcNeverBackedUp'))],
    [t('fbcDetailProxy'), <>
      <ProxyExit worker={w} />
      {mark && <ProxyMarkNote mark={mark} onRevived={setMarks} />}
    </>],
    [t('fbcColCities'), w.cities.length
      ? <span className="fl-cities ff-wrap-cell">{w.cities.map(c => <CityChip key={c.slug} city={c} hits={byCity} terms={[]} tone={searched(c.slug) ? 'accent' : 'muted'} runsPerDay={w.plan?.runs_per_day} />)}</span>
      : muted(t('fbcNoCities'))],
    [t('fbcFoldPacing'), pace],
    [t('fbcDetailSessionFile'), w.session_file ? <span className="mono">{w.session_file}</span> : muted('—')],
    [t('fbcColBuild'), <BuildChip health={h} coordinatorVersion={fleet.versions.coordinator} />],
  ];

  return (
    <div className="fp-pool">
      <div className="page-head">
        <div>
          {back}
          <h1 className="page-title">{name}</h1>
          <div className="page-sub"><span className="mono">{w.worker_id}</span> · {w.region.name}{note && ` · ${note}`}</div>
        </div>
        <div className="page-actions">
          <StatusChip status={status} />
        </div>
      </div>

      <article className="fp-credential ff-worker-card" aria-label={name}>
        <div className={`fp-stub ff-stub-${STUB_TONE[status]}`}>
          <b>{initials}</b>
          <small>{h ? t('fbcHeartbeatAge', { age: h.last_heartbeat_at ? relTime(h.last_heartbeat_at, locale) : t('fbcNever') }) : t('fbcNotDeployed')}</small>
        </div>
        <div className="fp-credential-main">
          <div className="fp-credential-head">
            <span><b>{name}</b> {who.userId && <span className="mono fp-muted">{who.userId}</span>}</span>
            <small>{w.region.name} · {t('fbcCities', { n: w.cities.length })}</small>
          </div>
          <div className="ff-ledger">
            <div><b>{h ? accountAlerts(w, byCity) : '—'}</b><small>{t('fbcColAlerts', { days: HITS_DAYS })}</small></div>
            <div><b>{h?.last_search_at ? relTime(h.last_search_at, locale) : '—'}</b><small>{t('fbcColLastSearch')}</small></div>
            <div><b>{h?.last_listing_at ? relTime(h.last_listing_at, locale) : '—'}</b><small>{t('fbcDetailLastListing')}</small></div>
            <div><b>{h ? h.error_count : '—'}</b><small>{t('fbcDetailErrors')}</small></div>
            <div><b>{mine.length}</b><small>{t('fbcOpenCheckpoints')}</small></div>
          </div>
          <dl className="fp-fields">
            {fields.map(([k, v]) => (
              <div key={k}><dt>{k}</dt><dd className={k === t('fbcColCities') ? 'ff-wrap-cell' : undefined}>{v}</dd></div>
            ))}
          </dl>
          <div className="fp-credential-foot">
            <div className="fp-row" style={{ flexWrap: 'wrap' }}>
              {canWatch(w)
                ? <WatchButton workerId={w.worker_id} className="btn" />
                : configVnc
                  ? <a className="btn" href={configVnc} target="_blank" rel="noopener"><Icon name="eye" size={13} />{t('fbcOpenVnc')}</a>
                  : <span className="fp-muted" style={{ fontSize: 12 }}>{t('fbcNoVnc')}</span>}
              {h && <ReloginButton workerId={w.worker_id} account={w} className="btn" onQueued={load} offerWatch={canWatch(w)} />}
              <EditCredentialsButton account={w} onSaved={load} className="btn" />
              {w.cities_editable && <EditCitiesButton worker={w} fleet={fleet} onSaved={load} />}
            </div>
          </div>
        </div>
      </article>

      <div className="fp-split ff-split">
        <section className="card" aria-label={t('fbcOpenCheckpoints')}>
          <div className="card-head"><h2 className="card-title">{t('fbcOpenCheckpoints')}</h2><span className="card-sub">{t('fbcCheckpointsSub')}</span></div>
          {mine.length === 0 && <div className="fp-empty">{t('fbcNoCheckpoint')}</div>}
          {mine.map(c => (
            <div key={c.id} className="ff-checkpoint">
              <Thumbnail challenge={c} onZoom={() => setZoom(c)} />
              <div className="ff-checkpoint-what">
                <div><span className="chip accent">{c.kind}</span> <span className="mono">{w.worker_id}</span> {t('fbcAttnParked', { kind: c.kind })}</div>
                <small>{t('fbcFlagged', { age: relTime(c.created_at, locale) })}{c.account_id && ` · ${c.account_id}`} · {t('fbcAttnClearIt')}</small>
                <div className="fp-row" style={{ marginTop: 8 }}>
                  {canWatch(w) && <WatchButton workerId={w.worker_id} />}
                  <button type="button" className="btn primary sm" disabled={resolving === c.id}
                    onClick={() => {
                      setResolving(c.id);
                      coordinatorApi.resolveChallenge(c.id)
                        .then(() => { showSuccessToast(t('fbcResolved')); load(); })
                        .catch(handleFetchError)
                        .finally(() => setResolving(null));
                    }}>
                    <Icon name="check" size={13} />{t('fbcResolve')}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </section>
        <aside className="card fp-activity ff-activity" aria-label={t('fbcHistory')}>
          <div className="card-head"><h2 className="card-title">{t('fbcHistory')}</h2></div>
          <ul className="fp-log">
            {events.map((e, i) => (
              <li key={i}>
                <i className={`fp-dot ff-${e.status ?? (e.kind === 'checkpoint' || e.kind === 'silent' ? 'attention' : 'live')}`} />
                <div>
                  {t(`fbcHist_${e.kind}`, { kind: eventDetail(t, e) })}
                  <time title={e.at}>{relTime(e.at, locale)}</time>
                </div>
              </li>
            ))}
            {events.length === 0 && <li className="fp-muted">{t('fbcActivityEmpty')}</li>}
          </ul>
        </aside>
      </div>

      <AccountsUsed stints={stints} locale={locale} />

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

const OUTCOME_TONE: Record<FbStintOutcome, string> = {
  available: 'muted', taken: 'muted', fleet: 'muted', removed: 'muted', problem: 'warn', retired: 'neg',
};

// Every pool account the worker has signed in with, newest first, each with
// the proxy it went out through. Problem and Retired count against that proxy.
function AccountsUsed({ stints, locale }: { stints: FbWorkerStint[] | null; locale: string }) {
  const { t } = useT();
  const when = (at: number) => new Date(at).toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const failed = stints?.filter(s => s.outcome && FB_FAILED_OUTCOMES.includes(s.outcome)).length ?? 0;
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
                  <th>#</th>
                  <th>{t('fbcStintLogin')}</th>
                  <th>{t('fbcColProxy')}</th>
                  <th>{t('fbcStintFrom')}</th>
                  <th>{t('fbcStintUntil')}</th>
                  <th>{t('fbcStintOutcome')}</th>
                </tr>
              </thead>
              <tbody>
                {stints.map(s => (
                  <tr key={`${s.accountNo}-${s.startedAt}`}>
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
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

function Thumbnail({ challenge, onZoom }: { challenge: Challenge; onZoom: () => void }) {
  const { t } = useT();
  const [broken, setBroken] = useState(false);
  if (!challenge.screenshot_url || broken) {
    return <div className="ff-thumb" title={t('fbcNoScreenshot')}><Icon name="image" size={16} /></div>;
  }
  return (
    <button type="button" className="ff-thumb" onClick={onZoom} title={t('fbcZoom')} style={{ cursor: 'zoom-in' }}>
      <img src={challengeScreenshotUrl(challenge.id)} alt={t('fbcScreenshotAlt', { id: challenge.worker_id })}
        onError={() => setBroken(true)} />
    </button>
  );
}
