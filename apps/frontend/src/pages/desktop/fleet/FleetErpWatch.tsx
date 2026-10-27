import { useCallback, useEffect, useState } from 'react';
import { poolApi } from '../../../lib/facebookPool';
import { fleetApi, fleetVncSocketUrl, type FleetWorkerDetail } from '../../../lib/fleet';
import type { ReloginPhase } from '../../../lib/fleetView';
import { relTime } from '../../../lib/format';
import { useT } from '../../../lib/i18n';
import { fleetWorkerPath } from '../../../lib/route';
import { fmtDays, ReloginButton, stateLabel } from '../FleetAccounts';
import { erpProxyText, erpReloginProgress, erpWorkerStatus, sessionDaysLeft } from './fleetWorkerView';
import { useFleetPoll } from './shared';
import { WatchAccountPanel, type PoolLookup, type WatchFact } from './watchAccount';
import { WatchView } from './watchView';
import { ErpBuildChip, Muted } from './workerDetail';

// ─── Watch an ERP-fleet worker's browser ──────────────────────────────────────
// The watch page (watchView.tsx) fed by the ERP's own fleet: the worker row,
// its slot's pool account (login, password and 2FA from the pool snapshot,
// the Pool tab's own read), the listed proxy, and the ERP's VNC relay
// (/api/fleet/vnc/<worker>/ws), which the worker dialled in to. Re-login is
// the fleet's: a one-shot heartbeat directive (POST /api/fleet/workers/:id/relogin).
//
// What the coordinator knows and the fleet does not reads "—" or is left out:
// the fleet has no region (the host stands in) and no proxy exit lookup (the
// listed proxy's host:port and clock stand in).

const REFRESH_MS = 30_000;
// While a re-login is under way, so the strip turns to "needs you" while the
// worker still waits on Facebook's prompt.
const RELOGIN_REFRESH_MS = 3000;

const STRIP_KEY: Partial<Record<ReloginPhase, string>> = {
  queued: 'fleetReloginStripQueued',
  signing_in: 'fleetReloginStripTaken',
  needs_you: 'fbcReloginStripNeedsYou',
};

export function FleetErpWatch({ initial, now = Date.now() }: { initial: FleetWorkerDetail; now?: number }) {
  const { t, locale } = useT();
  const workerId = initial.worker.worker_id;
  const [following, setFollowing] = useState(false);
  const load = useCallback(() => fleetApi.worker(workerId), [workerId]);
  const { data, reload } = useFleetPoll(load, following ? RELOGIN_REFRESH_MS : REFRESH_MS);
  // A failed re-read keeps the last answer: the viewer works without it.
  const d = data && data !== 'unavailable' ? data : initial;
  const [pool, setPool] = useState<PoolLookup>({ kind: 'loading' });
  const accountNo = d.account?.no ?? null;

  useEffect(() => {
    let cancelled = false;
    if (accountNo === null) { setPool({ kind: 'ok', account: null }); return; }
    poolApi.snapshot()
      .then(snap => { if (!cancelled) setPool({ kind: 'ok', account: snap.accounts.find(a => a.no === accountNo) ?? null }); })
      .catch(() => { if (!cancelled) setPool({ kind: 'unavailable' }); });
    return () => { cancelled = true; };
  }, [accountNo]);

  const w = d.worker;
  const acct = d.account;
  const relogin = erpReloginProgress(w, now);
  const active = relogin?.active ?? false;
  useEffect(() => setFollowing(active), [active]);
  const offline = erpWorkerStatus(w, now) === 'offline';
  const days = sessionDaysLeft(w, now);
  const proxy = erpProxyText(d);

  const missing: WatchFact[] = [
    { key: 'login', label: t('fbcWatchAcctLogin'), value: acct
      ? <span className="mono">{acct.email ?? acct.uid ?? `#${acct.no}`}</span>
      : <Muted>{t('fleetNoPoolAccount')}</Muted> },
    { key: 'secrets', label: t('fbcDetailSecrets'), value: acct?.secrets.length ? acct.secrets.join(', ') : <Muted>{t('fbcNone')}</Muted> },
  ];
  const facts: WatchFact[] = [
    { key: 'state', label: t('fbcWatchAcctState'), value: w.state ? stateLabel(t, w.state) : <Muted>—</Muted> },
    { key: 'host', label: t('fleetDetailHost'), value: w.host_id ? <span className="mono">{w.host_id}</span> : <Muted>—</Muted> },
    { key: 'session', label: t('fbcColSession'), value: days !== null
      ? <span title={String(w.detail?.session_expiry)}>{fmtDays(t, days)}</span> : <Muted>—</Muted> },
    { key: 'heartbeat', label: t('fbcWatchAcctHeartbeat'), value: w.last_heartbeat_at
      ? <span title={w.last_heartbeat_at}>{relTime(w.last_heartbeat_at, locale)}</span> : <Muted>{t('fbcNever')}</Muted> },
    { key: 'proxy', label: t('fbcDetailProxy'), value: proxy === null ? <Muted>—</Muted>
      : proxy === 'unlisted' ? <Muted>{t('fleetProxyUnlisted')}</Muted>
      : <span>{proxy.label}<br /><small className="fp-muted mono">{proxy.where}</small></span> },
    { key: 'build', label: t('fbcColBuild'), value: <ErpBuildChip version={w.version} release={d.release_version} /> },
  ];
  const stripKey = relogin ? STRIP_KEY[relogin.phase] : undefined;

  return (
    <WatchView
      workerId={workerId}
      socketUrl={fleetVncSocketUrl}
      back={{ path: fleetWorkerPath(workerId), label: acct?.email ?? acct?.uid ?? workerId }}
      sub={<>
        {w.host_id ?? '—'}
        {w.state && <> · {stateLabel(t, w.state)}</>}
        {w.last_heartbeat_at
          ? <> · {t('fbcWatchHeartbeat', { age: relTime(w.last_heartbeat_at, locale) })}</>
          : <> · {t('fbcNeverReported')}</>}
      </>}
      relogin={<ReloginButton workerId={workerId} fleet onQueued={reload}
        disabledReason={offline || !d.holds_slot ? t('fleetWorkerNotRunning') : null} />}
      strip={relogin && stripKey ? { phase: relogin.phase, text: t(stripKey, { age: relTime(relogin.since, locale) }) } : null}
      panel={typing => (
        <WatchAccountPanel pool={pool} asking={w.state === 'CHALLENGE_2FA'}
          profileId={acct?.uid && /^\d+$/.test(acct.uid) ? acct.uid : null}
          missing={missing} facts={facts} {...typing} />
      )}
    />
  );
}
