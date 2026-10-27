import { useEffect, useRef, useState, type ReactNode } from 'react';
import type RFB from '@novnc/novnc';
import { Icon, type IconName } from '../../../components/Icon';
import { api } from '../../../lib/api';
import { VNC_SESSION_LAPSED } from '../../../lib/coordinator';
import { keysymsFor, type ReloginPhase } from '../../../lib/fleetView';
import { useT } from '../../../lib/i18n';
import { usePreference } from '../../../lib/preferences';
import { hrefFor, onLinkClick } from '../../../lib/route';

// ─── Watch a worker's browser ─────────────────────────────────────────────────
// The live Chromium a Facebook worker is driving, through noVNC, with the
// sign-in panel beside it. Both kinds of worker get this page: a homelab
// worker through the coordinator bridge (/api/coordinator/vnc/<id>/ws,
// FleetWatch.tsx) and an ERP-fleet worker through the ERP's own relay
// (/api/fleet/vnc/<id>/ws, FleetErpWatch.tsx). Either socket is same-origin,
// so the manager's session is the only credential the browser holds.
//
// View-only by default. The session is shared with the scraper, so a stray
// click would land mid-sweep; input is forwarded only while "Take control" is
// on, and control is handed back whenever the tab is hidden. Neither relay
// filters input: noVNC's viewOnly is what keeps a watcher's mouse out.
//
// noVNC (~200 KB, with a top-level await) is imported here, on demand, so it
// never weighs on the fleet page itself.

export const RELOGIN_STRIP_LOOK: Record<ReloginPhase, { tone: string; icon: IconName }> = {
  queued: { tone: '', icon: 'clock' },
  signing_in: { tone: '', icon: 'refresh' },
  needs_you: { tone: 'warn', icon: 'alert' },
  done: { tone: 'pos', icon: 'check' },
  failed: { tone: 'neg', icon: 'alert' },
};

/** The strip above the viewer while a re-login is under way. */
export type WatchStrip = { phase: ReloginPhase; text: string };

type Phase =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'closed'; title: string; text: string };

/** What the page hands its side panel: whether keys can go to the browser, and how. */
export type WatchTyping = { canType: boolean; onType: (text: string) => boolean };

type Props = {
  workerId: string;
  /** The relay's socket for a worker; a module function, so it is stable. */
  socketUrl: (workerId: string) => string;
  back: { path: string; label: string };
  sub: ReactNode;
  relogin: ReactNode;
  strip: WatchStrip | null;
  panel: (typing: WatchTyping) => ReactNode;
};

export function WatchView({ workerId, socketUrl, back, sub, relogin, strip, panel }: Props) {
  const { t } = useT();
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
  // Bumped to reconnect: every attempt opens a fresh socket.
  const [attempt, setAttempt] = useState(0);
  const [accountHidden, setAccountHidden] = usePreference('fleetWatch.accountHidden', false);

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
      // VNC target for se-1", "worker-60-14-1 has no VNC relay connected")
      // reaches the overlay — noVNC only logs it.
      let lastClose: { code: number; reason: string } | null = null;
      const sock = new WebSocket(socketUrl(workerId));
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
        // Both relays send it only on a re-check after a handshake that
        // succeeded, so this cannot loop: a refused handshake closes 1006.
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
  }, [workerId, socketUrl, attempt]);

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
  const reloginStrip = strip && (
    <div className={`fl-relogin ${RELOGIN_STRIP_LOOK[strip.phase].tone}`} role="status" aria-live="polite">
      <Icon name={RELOGIN_STRIP_LOOK[strip.phase].icon} size={15} />
      <span>{strip.text}</span>
      {strip.phase === 'needs_you' && !control && phase.kind === 'connected' && (
        <button type="button" className="btn sm" onClick={() => changeControl(true)}>{t('fbcWatchControl')}</button>
      )}
    </div>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <a className="fl-back" href={hrefFor(back.path)} onClick={onLinkClick(back.path)}>
            <Icon name="chevronLeft" size={13} />
            {back.label}
          </a>
          <h1 className="page-title mono">{workerId}</h1>
          <div className="page-sub">{sub}</div>
        </div>
        <div className="page-actions">
          {statusChip}
          {controlToggle}
          {relogin}
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
              {relogin}
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
          {!accountHidden && panel({ canType: phase.kind === 'connected' && control, onType: typeText })}
        </div>
        <div className="fl-watch-note">
          <Icon name="info" size={14} />
          <span>{t('fbcWatchNote')}</span>
        </div>
      </div>
    </>
  );
}
