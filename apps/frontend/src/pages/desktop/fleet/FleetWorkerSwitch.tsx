import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type RFB from '@novnc/novnc';
import { Icon } from '../../../components/Icon';
import { FormSkeleton } from '../../../components/Skeleton';
import { api } from '../../../lib/api';
import { fleetApi, fleetVncSocketUrl, type FleetWorker } from '../../../lib/fleet';
import { useT } from '../../../lib/i18n';
import { hrefFor, onLinkClick } from '../../../lib/route';
import { dueLabel } from './fleetBoard';
import { Clock, SeenChip, TabCard, useFleetPoll } from './shared';
import '../../../styles/facebookPool.css';
import '../../../styles/fleet.css';

// ─── One worker: fleet or coordinator ─────────────────────────────────────────
// /fleet/worker/<id> serves both kinds. A worker the ERP's fleet knows (it
// claimed a slot here) gets this page: its slot, its state, the task it holds
// and its browser through the ERP's own relay. Any other id falls through to
// the coordinator's worker page, which is what the route always showed.

const CoordinatorWorker = lazy(() => import('../FleetWorker').then(m => ({ default: m.FleetWorker })));

export function FleetWorkerSwitch({ workerId }: { workerId: string }) {
  const { data } = useFleetPoll(() => fleetApi.workers());
  if (data === null) return <FormSkeleton fields={6} />;
  const worker = data === 'unavailable' ? undefined : data.find(w => w.worker_id === workerId);
  if (!worker) {
    return (
      <Suspense fallback={<FormSkeleton fields={6} />}>
        <CoordinatorWorker key={workerId} workerId={workerId} />
      </Suspense>
    );
  }
  return <FleetWorkerPage worker={worker} />;
}

const STATE_CHIP: Record<string, string> = {
  HEALTHY: 'chip pos', DEGRADED: 'chip warn', SESSION_EXPIRED: 'chip warn', CHECKPOINT: 'chip accent',
  CHALLENGE_2FA: 'chip accent', CHALLENGE_EMAIL: 'chip accent', CHALLENGE_CAPTCHA: 'chip accent', DEAD: 'chip neg',
};

export function FleetWorkerPage({ worker: w }: { worker: FleetWorker }) {
  const { t } = useT();
  const [watching, setWatching] = useState(false);
  const task = w.task;
  return (
    <>
      <div className="page-head">
        <div>
          <a className="fl-back" href={hrefFor('/fleet/slots')} onClick={onLinkClick('/fleet/slots')}>
            <Icon name="chevronLeft" size={13} />{t('fleetSlotsTitle')}
          </a>
          <h1 className="page-title mono">{w.worker_id}</h1>
          <div className="page-sub">{t('fleetWorkerSub', { host: w.host_id ?? '—' })}</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn sm" onClick={() => setWatching(v => !v)} disabled={!w.vnc_port}
            title={w.vnc_port ? undefined : t('fleetWatchNoVnc')}>
            <Icon name="eye" size={13} />{t(watching ? 'fleetWatchHide' : 'fleetWatch')}
          </button>
        </div>
      </div>
      <div className="fp-pool">
        <TabCard title={t('fleetWorkerTitle')}>
          <dl className="fleet-facts">
            <dt>{t('fleetColState')}</dt>
            <dd>{w.state ? <span className={STATE_CHIP[w.state] ?? 'chip muted'}>{w.state}</span> : <span className="fp-muted">—</span>}</dd>
            <dt>{t('fleetColLastSeen')}</dt>
            <dd><SeenChip at={w.last_heartbeat_at} /></dd>
            <dt>{t('fleetColAccount')}</dt>
            <dd className="mono">{w.account_no !== null ? `#${w.account_no}` : '—'}{w.epoch !== null && <span className="fp-muted"> · {t('fleetEpochN', { n: w.epoch })}</span>}</dd>
            <dt>{t('fleetColVersion')}</dt>
            <dd className="mono">{w.version ?? '—'}</dd>
            <dt>{t('fleetColTask')}</dt>
            <dd>
              {task ? (
                <span className="fp-holder">
                  <span>{task.city_name ?? task.city} <span className="mono fp-muted">{task.item}</span></span>
                  <small>
                    {t('fleetTaskSince')} <Clock at={task.leased_at ?? task.due_at} />
                    {task.lease_expires_at && <> · {t('fleetLeaseUntil', { time: dueLabel(t, task.lease_expires_at) })}</>}
                  </small>
                </span>
              ) : <span className="fp-muted">{t('fleetTaskNone')}</span>}
            </dd>
          </dl>
        </TabCard>
        {watching && <FleetVncView workerId={w.worker_id} />}
      </div>
    </>
  );
}

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
