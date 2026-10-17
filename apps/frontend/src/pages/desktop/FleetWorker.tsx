import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { ImageLightbox } from '../../components/ImageLightbox';
import { FormSkeleton } from '../../components/Skeleton';
import { ApiError } from '../../lib/api';
import {
  challengeScreenshotUrl, coordinatorApi, type AlertHitRow, type Challenge, type FleetDoc,
} from '../../lib/coordinator';
import { handleFetchError, showSuccessToast } from '../../lib/errorToast';
import {
  accountAlerts, browserLabel, canWatch, externalVncUrl, fleetActivity, fleetStatus, hitsByCity, parkedWorkers, whoIs,
} from '../../lib/fleetView';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { hrefFor, onLinkClick } from '../../lib/route';
import { BuildChip, CityChip, EditCredentialsButton, fmtDays, HITS_DAYS, ReloginButton, WatchButton } from './FleetAccounts';
import { StatusChip, statusNote } from './FleetWorkers';
import '../../styles/facebookPool.css';

// ─── One worker ───────────────────────────────────────────────────────────────
// Opened from the eye on the fleet list. Everything known about one Facebook
// worker in the Account pool's credential-card style, its open checkpoints
// and recent events, and every action the control plane offers on it today:
// watch its browser, queue a re-login, set its credentials, clear a
// checkpoint. Edits that need master.toml (cities, pacing) are not here yet.

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

  const load = useCallback(() => {
    coordinatorApi.fleet().then(doc => { setFleet(doc); setFailed(false); }).catch(err => {
      if (!(err instanceof ApiError)) handleFetchError(err);
      setFailed(true);
    });
    coordinatorApi.listOpenChallenges().then(setChallenges).catch(() => setChallenges([]));
    coordinatorApi.alertHits(HITS_DAYS).then(setHits).catch(() => setHits([]));
  }, []);
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
  const mine = (challenges ?? []).filter(c => c.worker_id === w.worker_id);
  const events = fleetActivity({ ...fleet, workers: [w] }, mine);
  const acct = w.account;
  const sess = w.session;
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
      ? <span className={h.session_days_left !== null && h.session_days_left <= 7 ? 'fp-warn' : 'fp-ok'} title={h.session_expiry}>{fmtDays(t, h.session_days_left)}</span>
      : muted('—')],
    [t('fbcDetailUa'), browserLabel(sess?.user_agent) ? <span title={sess?.user_agent ?? undefined}>{browserLabel(sess?.user_agent)}</span> : muted('—')],
    [t('fbcDetailBackup'), sess?.backed_up_at ? <span title={sess.backed_up_at}>{relTime(sess.backed_up_at, locale)}</span> : muted(t('fbcNeverBackedUp'))],
    [t('fbcDetailProxy'), w.proxy_env ? <span className="mono">${w.proxy_env}</span> : muted(t('fbcOwnIp'))],
    [t('fbcColCities'), w.cities.length
      ? <span className="fl-cities ff-wrap-cell">{w.cities.map(c => <CityChip key={c.slug} city={c} hits={byCity} terms={[]} tone={status === 'live' || status === 'stale' ? 'accent' : 'muted'} />)}</span>
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
              {h && <ReloginButton workerId={w.worker_id} account={w} className="btn" onQueued={load} />}
              <EditCredentialsButton account={w} onSaved={load} className="btn" />
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
                <i className={`fp-dot ff-${e.kind === 'checkpoint' || e.kind === 'silent' ? 'attention' : 'live'}`} />
                <div>
                  {t(`fbcHist_${e.kind}`, { kind: e.detail ?? '' })}
                  <time title={e.at}>{relTime(e.at, locale)}</time>
                </div>
              </li>
            ))}
            {events.length === 0 && <li className="fp-muted">{t('fbcActivityEmpty')}</li>}
          </ul>
        </aside>
      </div>

      {zoom && (
        <ImageLightbox url={challengeScreenshotUrl(zoom.id)} alt={t('fbcScreenshotAlt', { id: zoom.worker_id })}
          onClose={() => setZoom(null)} />
      )}
    </div>
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
