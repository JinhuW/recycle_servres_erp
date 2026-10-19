import { useEffect, useRef, useState } from 'react';
import type RFB from '@novnc/novnc';
import { Icon, type IconName } from '../../components/Icon';
import { api } from '../../lib/api';
import { coordinatorApi, VNC_SESSION_LAPSED, vncSocketUrl, type FleetAccount } from '../../lib/coordinator';
import { heldByWorker, poolApi } from '../../lib/facebookPool';
import { keysymsFor, liveness, reloginProgress, type ReloginPhase } from '../../lib/fleetView';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { usePreference } from '../../lib/preferences';
import { fleetWorkerPath, hrefFor, onLinkClick } from '../../lib/route';
import { ReloginButton, stateLabel } from './FleetAccounts';
import { FleetWatchAccount, type PoolLookup } from './FleetWatchAccount';

// ─── Watch a worker's browser ─────────────────────────────────────────────────
// The live Chromium a Facebook worker is driving, through noVNC. The socket is
// same-origin (/api/coordinator/vnc/<worker>/ws) and the backend relays it to
// the rs-console facade, so the facade's token and the Cloudflare Access
// service token stay server-side — the manager's session is the only
// credential the browser holds.
//
// View-only by default. The session is shared with the scraper, so a stray
// click would land mid-sweep; input is forwarded only while "Take control" is
// on, and control is handed back whenever the tab is hidden.
//
// noVNC (~200 KB, with a top-level await) is imported here, on demand, so it
// never weighs on the fleet page itself.

const FLEET_REFRESH_MS = 30_000;
// While a re-login is in flight the fleet is re-read this often, so the strip
// above the viewer flags a captcha while the worker still waits for a human.
const RELOGIN_REFRESH_MS = 3000;

const RELOGIN_STRIP: Record<ReloginPhase, { tone: string; icon: IconName; key: string }> = {
  queued: { tone: '', icon: 'clock', key: 'fbcReloginStripQueued' },
  signing_in: { tone: '', icon: 'refresh', key: 'fbcReloginStripSigningIn' },
  needs_you: { tone: 'warn', icon: 'alert', key: 'fbcReloginStripNeedsYou' },
  done: { tone: 'pos', icon: 'check', key: 'fbcReloginStripDone' },
  failed: { tone: 'neg', icon: 'alert', key: 'fbcReloginStripFailed' },
};

type Phase =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'closed'; title: string; text: string };

export function FleetWatch({ workerId }: { workerId: string }) {
  const { t, locale } = useT();
  const screenRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' });
  const [control, setControl] = useState(false);
  const controlRef = useRef(control);
  controlRef.current = control;
  // Read through a ref inside the socket's callbacks: a language switch must
  // not tear down the session.
  const tRef = useRef(t);
  tRef.current = t;
  // Bumped to reconnect: every attempt mints a fresh single-use ticket.
  const [attempt, setAttempt] = useState(0);
  // undefined while loading; null when the fleet document has no such worker.
  const [account, setAccount] = useState<FleetAccount | null | undefined>(undefined);
  const [coordinatorVersion, setCoordinatorVersion] = useState<string | null>(null);
  const [pool, setPool] = useState<PoolLookup>({ kind: 'loading' });
  const [accountHidden, setAccountHidden] = usePreference('fleetWatch.accountHidden', false);
  // Bumped to re-read the fleet at once, after a re-login is queued.
  const [fleetRead, setFleetRead] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const relogin = reloginProgress(account, now);
  const following = relogin?.active ?? false;

  // Polled so the panel sees a worker drop into CHALLENGE_2FA while watched,
  // and faster while a re-login is in flight.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.hidden) return;
      coordinatorApi.fleet()
        .then(doc => {
          if (cancelled) return;
          setAccount(doc.workers.find(w => w.worker_id === workerId) ?? null);
          setCoordinatorVersion(doc.versions.coordinator);
          setNow(Date.now());
        })
        // The header and panel are help; the viewer works without them.
        .catch(() => { if (!cancelled) setAccount(a => a ?? null); });
    };
    load();
    const timer = setInterval(load, following ? RELOGIN_REFRESH_MS : FLEET_REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [workerId, following, fleetRead]);

  useEffect(() => {
    let cancelled = false;
    poolApi.snapshot()
      .then(snap => { if (!cancelled) setPool({ kind: 'ok', account: heldByWorker(snap.accounts, workerId) ?? null }); })
      .catch(() => { if (!cancelled) setPool({ kind: 'unavailable' }); });
    return () => { cancelled = true; };
  }, [workerId]);

  useEffect(() => {
    let cancelled = false;
    let rfb: RFB | null = null;
    const tr = (key: string) => tRef.current(key);
    setPhase({ kind: 'connecting' });

    // A socket handshake can't run api.ts's 401 → refresh → retry, and the
    // `at` cookie is gone the moment its token expires — which is exactly
    // when the relay cuts a socket. An ordinary call first puts a live cookie
    // on the handshake, or signs out a session that is really over.
    Promise.all([import('@novnc/novnc'), api.get('/api/me').catch(() => undefined)]).then(([{ default: RFBClass }]) => {
      if (cancelled || !screenRef.current) return;
      // Our own socket rather than noVNC's, so the relay's close reason ("no
      // VNC target for se-1", "rs-monitor-ne:5900 is not answering") reaches
      // the overlay — noVNC only logs it.
      let lastClose: { code: number; reason: string } | null = null;
      const sock = new WebSocket(vncSocketUrl(workerId));
      sock.addEventListener('close', e => { lastClose = { code: e.code, reason: e.reason }; });

      rfb = new RFBClass(screenRef.current, sock, { shared: true });
      rfbRef.current = rfb;
      rfb.viewOnly = !controlRef.current;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.showDotCursor = true;
      // The far end is a tunnel away; trade a little sharpness for speed.
      rfb.qualityLevel = 5;
      rfb.compressionLevel = 6;

      rfb.addEventListener('connect', () => { if (!cancelled) setPhase({ kind: 'connected' }); });
      rfb.addEventListener('disconnect', (e) => {
        if (cancelled) return;
        const clean = (e as CustomEvent<{ clean?: boolean }>).detail?.clean;
        const close = lastClose as { code: number; reason: string } | null;
        // Sent only by a re-check after a handshake that succeeded, so this
        // cannot loop: a refused handshake closes 1006 and shows the overlay.
        if (close?.code === VNC_SESSION_LAPSED) {
          setAttempt(n => n + 1);
          return;
        }
        setPhase({
          kind: 'closed',
          title: clean && !close?.reason ? tr('fbcWatchEnded') : tr('fbcWatchLost'),
          text: close?.reason
            ? close.reason
            : close?.code === 1006 || close === null
              ? tr('fbcWatchRefused')
              : tr('fbcWatchDropped'),
        });
      });
      rfb.addEventListener('securityfailure', (e) => {
        if (cancelled) return;
        const reason = (e as CustomEvent<{ reason?: string }>).detail?.reason;
        setPhase({ kind: 'closed', title: tr('fbcWatchSecurity'), text: reason ?? tr('fbcWatchSecurityText') });
      });
    }).catch(() => {
      if (!cancelled) setPhase({ kind: 'closed', title: tr('fbcWatchLost'), text: tr('fbcWatchLoadFailed') });
    });

    return () => {
      cancelled = true;
      rfbRef.current = null;
      try { rfb?.disconnect(); } catch { /* already gone */ }
    };
  }, [workerId, attempt]);

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = !control;
  }, [control]);

  // Give the browser back to the scraper if the operator wanders off mid-control.
  useEffect(() => {
    const onHide = () => { if (document.hidden) setControl(false); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  // Esc leaves full screen without telling us, so follow the document.
  useEffect(() => {
    const onChange = () => setFullscreen(!!cardRef.current && document.fullscreenElement === cardRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const enterFullscreen = () => {
    if (!document.fullscreenElement) cardRef.current?.requestFullscreen().catch(() => { /* denied: stay inline */ });
  };
  const exitFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => { /* already out */ });
  };

  // Control is when a checkpoint needs every pixel, so taking it goes full
  // screen in the same click (the gesture requestFullscreen insists on).
  // Leaving full screen keeps control; handing control back leaves it.
  const changeControl = (on: boolean) => {
    setControl(on);
    if (on) enterFullscreen(); else exitFullscreen();
  };

  // Types into whichever field has focus in the remote browser, then hands
  // the keyboard back to the viewer so Enter goes to Facebook too.
  const typeText = (text: string): boolean => {
    const rfb = rfbRef.current;
    if (!rfb || rfb.viewOnly) return false;
    for (const keysym of keysymsFor(text)) rfb.sendKey(keysym, null);
    rfb.focus();
    return true;
  };

  const h = account?.health ?? null;
  const status = phase.kind === 'connected'
    ? { tone: 'pos', text: control ? t('fbcWatchInControl') : t('fbcWatchWatching') }
    : phase.kind === 'connecting'
      ? { tone: '', text: t('fbcWatchConnecting') }
      : { tone: 'neg', text: t('fbcWatchDisconnected') };

  // The page head sits outside the full-screen card, so the bar inside it
  // repeats these.
  const statusChip = (
    <span className={`fl-watch-status ${status.tone}`} aria-live="polite">
      <span className="dot" />{status.text}
    </span>
  );
  const controlToggle = (
    <label className="fl-watch-toggle" title={t('fbcWatchControlHint')}>
      <input type="checkbox" checked={control} onChange={e => changeControl(e.target.checked)} />
      <span>{t('fbcWatchControl')}</span>
    </label>
  );
  const reloginButton = (
    <ReloginButton workerId={workerId} account={account} onQueued={() => setFleetRead(n => n + 1)} />
  );
  const reconnectButton = phase.kind === 'closed' && (
    <button type="button" className="btn sm" onClick={() => setAttempt(n => n + 1)}>
      <Icon name="rotate" size={13} />
      {t('fbcWatchReconnect')}
    </button>
  );
  const accountToggle = (
    <button type="button" className="btn sm" aria-pressed={!accountHidden}
      onClick={() => setAccountHidden(!accountHidden)}>
      <Icon name="panelRight" size={13} />
      {t(accountHidden ? 'fbcWatchAcctShow' : 'fbcWatchAcctHide')}
    </button>
  );
  const reloginStrip = relogin && (
    <div className={`fl-relogin ${RELOGIN_STRIP[relogin.phase].tone}`} role="status" aria-live="polite">
      <Icon name={RELOGIN_STRIP[relogin.phase].icon} size={15} />
      <span>{t(RELOGIN_STRIP[relogin.phase].key, { age: relTime(relogin.since, locale) })}</span>
      {relogin.phase === 'needs_you' && !control && phase.kind === 'connected' && (
        <button type="button" className="btn sm" onClick={() => changeControl(true)}>{t('fbcWatchControl')}</button>
      )}
    </div>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <a className="fl-back" href={hrefFor(fleetWorkerPath(workerId))} onClick={onLinkClick(fleetWorkerPath(workerId))}>
            <Icon name="chevronLeft" size={13} />
            {account ? (account.account?.fb_username ?? workerId) : workerId}
          </a>
          <h1 className="page-title mono">{workerId}</h1>
          <div className="page-sub">
            {account
              ? <>
                  {account.region.name}
                  {h?.state && <> · {stateLabel(t, h.state)}</>}
                  {h?.last_heartbeat_at && <> · {t('fbcWatchHeartbeat', { age: relTime(h.last_heartbeat_at, locale) })}</>}
                  {liveness(account) === 'none' && <> · {t('fbcNotDeployed')}</>}
                </>
              : account === null ? t('fbcWatchSub') : '…'}
          </div>
        </div>
        <div className="page-actions">
          {statusChip}
          {controlToggle}
          {reloginButton}
          {reconnectButton}
          {accountToggle}
          <button type="button" className="btn sm" onClick={enterFullscreen}>
            <Icon name="maximize" size={13} />
            {t('fbcWatchFullscreen')}
          </button>
        </div>
      </div>

      {!fullscreen && reloginStrip}

      <div ref={cardRef} className={`card fl-watch${control ? ' in-control' : ''}${accountHidden ? '' : ' with-account'}`}>
        {fullscreen && (
          <>
            <div className="fl-watch-fsbar">
              <span className="fl-watch-fsbar-id mono">{workerId}</span>
              {statusChip}
              <span className="fl-watch-fsbar-gap" />
              {controlToggle}
              {reloginButton}
              {reconnectButton}
              {accountToggle}
              <button type="button" className="btn sm" onClick={exitFullscreen}>
                <Icon name="minimize" size={13} />
                {t('fbcWatchExitFullscreen')}
              </button>
            </div>
            {reloginStrip}
          </>
        )}
        <div className="fl-watch-body">
          <div className="fl-watch-stage">
            <div className="fl-watch-screen" ref={screenRef} />
            {phase.kind === 'closed' && (
              <div className="fl-watch-overlay">
                <div className="fl-watch-overlay-card" role="alert">
                  <div className="fl-watch-overlay-title">{phase.title}</div>
                  <p>{phase.text}</p>
                  <button type="button" className="btn primary" onClick={() => setAttempt(n => n + 1)}>
                    {t('fbcWatchReconnect')}
                  </button>
                </div>
              </div>
            )}
          </div>
          {!accountHidden && (
            <FleetWatchAccount worker={account} coordinatorVersion={coordinatorVersion} pool={pool}
              canType={phase.kind === 'connected' && control} onType={typeText} />
          )}
        </div>
        <div className="fl-watch-note">
          <Icon name="info" size={14} />
          <span>{t('fbcWatchNote')}</span>
        </div>
      </div>
    </>
  );
}
