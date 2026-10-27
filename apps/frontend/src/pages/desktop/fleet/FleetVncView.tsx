import { useEffect, useRef, useState } from 'react';
import type RFB from '@novnc/novnc';
import { api } from '../../../lib/api';
import { fleetVncSocketUrl } from '../../../lib/fleet';
import { useT } from '../../../lib/i18n';

type Phase = { kind: 'connecting' } | { kind: 'connected' } | { kind: 'closed'; text: string };

// The worker's browser through the ERP's relay (the worker dials in; nothing
// listens on its host). noVNC is its own chunk, fetched on the first watch.
// View-only: the session is the scraper's, and a stray click lands mid-search.
export function FleetVncView({ workerId }: { workerId: string }) {
  const { t } = useT();
  const screenRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    let cancelled = false;
    let rfb: RFB | null = null;
    setPhase({ kind: 'connecting' });
    // A socket handshake cannot refresh an expired access cookie; an ordinary
    // call first puts a live one on it.
    Promise.all([import('@novnc/novnc'), api.get('/api/me').catch(() => undefined)]).then(([{ default: RFBClass }]) => {
      if (cancelled || !screenRef.current) return;
      let lastClose: { code: number; reason: string } | null = null;
      const sock = new WebSocket(fleetVncSocketUrl(workerId));
      sock.addEventListener('close', e => { lastClose = { code: e.code, reason: e.reason }; });
      rfb = new RFBClass(screenRef.current, sock, { shared: true });
      rfb.viewOnly = true;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.qualityLevel = 5;
      rfb.compressionLevel = 6;
      rfb.addEventListener('connect', () => { if (!cancelled) setPhase({ kind: 'connected' }); });
      rfb.addEventListener('disconnect', () => {
        if (cancelled) return;
        const close = lastClose as { code: number; reason: string } | null;
        setPhase({ kind: 'closed', text: close?.reason || tRef.current('fleetWatchClosed') });
      });
    }).catch(() => {
      if (!cancelled) setPhase({ kind: 'closed', text: tRef.current('fleetWatchLoadFailed') });
    });
    return () => {
      cancelled = true;
      try { rfb?.disconnect(); } catch { /* already gone */ }
    };
  }, [workerId, attempt]);

  return (
    <section className="card fleet-vnc" aria-label={t('fleetWatch')}>
      <div className="card-head">
        <h2 className="card-title">{t('fleetWatchTitle', { worker: workerId })}</h2>
        <span className="card-sub">{t('fleetWatchViewOnly')}</span>
      </div>
      <div className="fleet-vnc-screen">
        <div ref={screenRef} className="fleet-vnc-canvas" />
        {phase.kind !== 'connected' && (
          <div className="fleet-vnc-overlay">
            {phase.kind === 'connecting' ? <span>{t('fleetWatchConnecting')}</span> : <>
              <span>{phase.text}</span>
              <button type="button" className="btn sm" onClick={() => setAttempt(n => n + 1)}>{t('fleetWatchRetry')}</button>
            </>}
          </div>
        )}
      </div>
    </section>
  );
}
