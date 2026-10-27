import { useEffect, useState } from 'react';
import { coordinatorApi, vncSocketUrl, type FleetAccount } from '../../lib/coordinator';
import { heldByWorker, poolApi } from '../../lib/facebookPool';
import { liveness, reloginProgress, whoIs, type ReloginPhase } from '../../lib/fleetView';
import { relTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { fleetWorkerPath } from '../../lib/route';
import { BuildChip, fmtDays, ReloginButton, stateLabel } from './FleetAccounts';
import { ProxyExit } from './FleetWorker';
import { WatchAccountPanel, type PoolLookup, type WatchFact } from './fleet/watchAccount';
import { WatchView } from './fleet/watchView';

// ─── Watch a homelab worker's browser ─────────────────────────────────────────
// The watch page (fleet/watchView.tsx) fed by the coordinator: the worker's
// fleet-document row, its pool login, and the coordinator bridge
// (/api/coordinator/vnc/<worker>/ws), which the backend relays to the
// rs-console facade so the facade's token and the Cloudflare Access service
// token stay server-side.

const FLEET_REFRESH_MS = 30_000;
// While a re-login is in flight the fleet is re-read this often, so the strip
// above the viewer flags a captcha while the worker still waits for a human.
const RELOGIN_REFRESH_MS = 3000;

const STRIP_KEY: Record<ReloginPhase, string> = {
  queued: 'fbcReloginStripQueued',
  signing_in: 'fbcReloginStripSigningIn',
  needs_you: 'fbcReloginStripNeedsYou',
  done: 'fbcReloginStripDone',
  failed: 'fbcReloginStripFailed',
};

export function FleetWatch({ workerId }: { workerId: string }) {
  const { t, locale } = useT();
  // undefined while loading; null when the fleet document has no such worker.
  const [account, setAccount] = useState<FleetAccount | null | undefined>(undefined);
  const [coordinatorVersion, setCoordinatorVersion] = useState<string | null>(null);
  const [pool, setPool] = useState<PoolLookup>({ kind: 'loading' });
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

  const h = account?.health ?? null;
  const who = account ? whoIs(account) : null;
  const muted = (text: string) => <span className="fp-muted">{text}</span>;
  const stored = Object.entries(account?.account?.secrets ?? {}).filter(([, on]) => on).map(([k]) => k);
  const missing: WatchFact[] = [
    { key: 'login', label: t('fbcWatchAcctLogin'), value: who?.login ? <span className="mono">{who.login}</span> : muted(t('fbcNotInVault')) },
    { key: 'secrets', label: t('fbcDetailSecrets'), value: stored.length ? stored.join(', ') : muted(t('fbcNone')) },
  ];
  const facts: WatchFact[] | null = account ? [
    { key: 'state', label: t('fbcWatchAcctState'), value: h?.state ? stateLabel(t, h.state) : muted('—') },
    { key: 'region', label: t('fbcWatchAcctRegion'), value: account.region.name },
    { key: 'session', label: t('fbcColSession'), value: h?.session_expiry
      ? <span title={h.session_expiry}>{fmtDays(t, h.session_days_left)}</span> : muted('—') },
    { key: 'heartbeat', label: t('fbcWatchAcctHeartbeat'), value: h?.last_heartbeat_at
      ? <span title={h.last_heartbeat_at}>{relTime(h.last_heartbeat_at, locale)}</span> : muted(t('fbcNever')) },
    { key: 'proxy', label: t('fbcDetailProxy'), value: <ProxyExit worker={account} /> },
    { key: 'build', label: t('fbcColBuild'), value: <BuildChip health={h} coordinatorVersion={coordinatorVersion} /> },
  ] : null;

  return (
    <WatchView
      workerId={workerId}
      socketUrl={vncSocketUrl}
      back={{ path: fleetWorkerPath(workerId), label: account ? (account.account?.fb_username ?? workerId) : workerId }}
      sub={account
        ? <>
            {account.region.name}
            {h?.state && <> · {stateLabel(t, h.state)}</>}
            {h?.last_heartbeat_at && <> · {t('fbcWatchHeartbeat', { age: relTime(h.last_heartbeat_at, locale) })}</>}
            {liveness(account) === 'none' && <> · {t('fbcNotDeployed')}</>}
          </>
        : account === null ? t('fbcWatchSub') : '…'}
      relogin={<ReloginButton workerId={workerId} account={account} onQueued={() => setFleetRead(n => n + 1)} />}
      strip={relogin && { phase: relogin.phase, text: t(STRIP_KEY[relogin.phase], { age: relTime(relogin.since, locale) }) }}
      panel={typing => (
        <WatchAccountPanel pool={pool} asking={h?.state === 'CHALLENGE_2FA'} profileId={who?.userId ?? null}
          missing={missing} facts={facts} {...typing} />
      )}
    />
  );
}
