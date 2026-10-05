import { useEffect, useRef, useState } from 'react';
import type RFB from '@novnc/novnc';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { coordinatorApi, VNC_SESSION_LAPSED, vncSocketUrl, type FleetAccount } from '../../lib/coordinator';
import { liveness } from '../../lib/fleetView';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { hrefFor, onLinkClick } from '../../lib/route';
import { ReloginButton, stateLabel } from './FleetAccounts';

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

type Phase =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'closed'; title: string; text: string };

export function FleetWatch({ workerId }: { workerId: string }) {
  const { t, locale } = useT();
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    coordinatorApi.fleet()
      .then(doc => { if (!cancelled) setAccount(doc.workers.find(w => w.worker_id === workerId) ?? null); })
      // The header is decoration; the viewer works without it.
      .catch(() => { if (!cancelled) setAccount(null); });
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

  const h = account?.health ?? null;
  const status = phase.kind === 'connected'
    ? { tone: 'pos', text: control ? t('fbcWatchInControl') : t('fbcWatchWatching') }
    : phase.kind === 'connecting'
      ? { tone: '', text: t('fbcWatchConnecting') }
      : { tone: 'neg', text: t('fbcWatchDisconnected') };

  return (
    <>
      <div className="page-head">
        <div>
          <a className="fl-back" href={hrefFor('/fleet')} onClick={onLinkClick('/fleet')}>
            <Icon name="chevronLeft" size={13} />
            {t('fbcTitle')}
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
          <span className={`fl-watch-status ${status.tone}`} aria-live="polite">
            <span className="dot" />{status.text}
          </span>
          <label className="fl-watch-toggle" title={t('fbcWatchControlHint')}>
            <input type="checkbox" checked={control} onChange={e => setControl(e.target.checked)} />
            <span>{t('fbcWatchControl')}</span>
          </label>
          <ReloginButton workerId={workerId} account={account} />
          {phase.kind === 'closed' && (
            <button type="button" className="btn sm" onClick={() => setAttempt(n => n + 1)}>
              <Icon name="rotate" size={13} />
              {t('fbcWatchReconnect')}
            </button>
          )}
        </div>
      </div>

      <div className={`card fl-watch${control ? ' in-control' : ''}`}>
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
        <div className="fl-watch-note">
          <Icon name="info" size={14} />
          <span>{t('fbcWatchNote')}</span>
        </div>
      </div>
    </>
  );
}
