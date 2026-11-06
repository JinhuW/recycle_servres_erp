import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/Modal';
import { Skeleton } from '../../../components/Skeleton';
import { api, ApiError } from '../../../lib/api';
import type { Notification } from '../../../lib/types';
import { fleetApi, type FleetEngineLoss, type FleetEngineLossRow, type FleetHost, type FleetHostCreated, type FleetWorker, type FleetRelease, type FleetSettings } from '../../../lib/fleet';
import { handleFetchError, showSuccessToast } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import { usePreference } from '../../../lib/preferences';
import { capacityCuts, fleetAttention, hostLag, hostRunning, liveness, releaseSummary, rollProgress } from './fleetBoard';
import { FLEET_ROW_KINDS, fleetRowCounts, hostBays, type FleetRow, type FleetRowKind } from './fleetRows';
import { agoLabel, Clock, ConfirmDialogBody, Legend, useFleetMirror, useFleetPoll } from './shared';

// ─── Hosts ────────────────────────────────────────────────────────────────────
// The machines that run worker containers, one row each in the rack at the top
// of the Fleet tab. Each runs one agent that asks the ERP what it should run
// (count, image) and reports what it does run. A host is observe-only until a
// manager makes it authoritative, so a freshly registered agent starts
// nothing by accident. A release names an image and a version; the ERP then
// replaces one idle worker at a time across the fleet, and a host's row
// follows its part of the roll. The dialogs (add a host, roll out an image)
// open from the rack's head.

const CAPACITY_MAX = 64;
// The settings route's bound for cloak_max_slots.
const CLOAK_SEATS_MAX = 100;
const LOSS_DAYS = 30;
const ALERT_POLL_MS = 60_000;
const FLEET_ALERT_KINDS = ['fleet_proxy_exit', 'fleet_licence_outage'];

const KIND_DOT: Record<FleetRowKind | 'all', string> = {
  all: 'fleet-dot-all', healthy: 'fleet-dot-pos', free: 'fleet-dot-muted', parked: 'fleet-dot-neg',
};
const KIND_KEY: Record<FleetRowKind | 'all', string> = {
  all: 'fleetKindAll', healthy: 'fleetKindHealthy', free: 'fleetKindFree', parked: 'fleetKindParked',
};

const RELEASE_CHIP: Record<FleetRelease['state'], string> = {
  rolling: 'chip info', staged: 'chip warn', done: 'chip pos', failed: 'chip neg', superseded: 'chip muted',
};

/** The Fleet tab's first read: how the fleet is, then each host as a row of
 *  bays, what needs a person, and the release and engine as a quiet row each.
 *  Every control a manager rarely touches waits in a row's fold, and everything
 *  under the headline folds as one for a manager who only wants the table. */
export function FleetRack({ rows, workers, hosts, release, settings, cloakUsed, filter, onFilter, onShowWorker, onChanged, settled, actions, now = Date.now() }: {
  rows: readonly FleetRow[]; workers: readonly FleetWorker[]; hosts: readonly FleetHost[]; release: FleetRelease | null;
  settings: FleetSettings | null | undefined; cloakUsed: number;
  filter: FleetRowKind | 'all'; onFilter: (k: FleetRowKind | 'all') => void; onShowWorker: (workerId: string) => void; onChanged: () => void;
  /** False until the coordinator has answered: its workers would move the headline. */
  settled: boolean;
  actions: ReactNode; now?: number;
}) {
  const { t } = useT();
  const attention = useFleetAttention(workers, hosts);
  const counts = fleetRowCounts(rows);
  const [folded, setFolded] = usePreference('fleet.rackFolded', false);
  return (
    <section className="card fleet-rack" aria-label={t('fleetRackLabel')}>
      <div className="fleet-rack-head">
        <div className="fleet-rack-verdict">
          <FoldButton open={!folded} onToggle={() => setFolded(!folded)} label={t('fleetFoldRack')} />
          {!settled ? <Skeleton width={230} height={22} />
            : counts.all === 0 ? <span className="fleet-rack-none">{t('fleetWorkersNone')}</span>
            : <h2>{t('fleetRackVerdict', { healthy: counts.healthy, total: counts.all })}</h2>}
          {attention.items > 0 && <span className="fleet-rack-needs">{t('fleetNeedsYou', { n: attention.items })}</span>}
          <span className="fleet-rack-about" role="img" tabIndex={0} aria-label={t('fleetLede')} title={t('fleetLede')}><Icon name="info" size={14} /></span>
        </div>
        <Legend buckets={FLEET_ROW_KINDS} counts={counts} value={filter} onChange={onFilter}
          label={k => t(KIND_KEY[k])} dotClass={k => KIND_DOT[k]} />
        <div className="fleet-rack-actions">{actions}</div>
      </div>
      {/* Hidden, not unmounted: a host fold or alert left open is still open on the way back. */}
      <div className="fleet-rack-body" hidden={folded}>
        <HostRows hosts={hosts} rows={rows} release={release} onChanged={onChanged} onShowWorker={onShowWorker} now={now} />
        <FleetAlerts attention={attention} onShowWorker={onShowWorker} />
        {release && (release.state === 'rolling' || release.state === 'staged' || release.state === 'failed') && <ReleaseBanner release={release} now={now} />}
        {settings && <EngineCard settings={settings} used={cloakUsed} onChanged={onChanged} />}
      </div>
    </section>
  );
}

type FleetAttention = ReturnType<typeof fleetAttention> & { alerts: Notification[]; items: number; dismiss: (id: string) => void };

/** What needs a manager's eye and shows nowhere else on a desktop: a licence
 *  outage, workers held for a person, and the alerts only the phone shell reads.
 *  A mirror's fleet is prod's to act on, so it asks nothing of this page. */
function useFleetAttention(workers: readonly FleetWorker[], hosts: readonly FleetHost[]): FleetAttention {
  const mirror = useFleetMirror();
  const inbox = useFleetPoll(() => mirror ? Promise.resolve(null) : api.get<{ items: Notification[] }>('/api/notifications'), ALERT_POLL_MS);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const dismiss = (id: string) => {
    setDismissed(d => new Set(d).add(id));
    api.post('/api/notifications/mark-read', { id }).catch(handleFetchError);
  };
  const found = fleetAttention(workers, hosts);
  const alerts = inbox.data && inbox.data !== 'unavailable'
    ? inbox.data.items.filter(n => n.unread && FLEET_ALERT_KINDS.includes(n.kind) && !dismissed.has(n.id)).slice(0, 3)
    : [];
  if (mirror) return { outage: 0, probing: 0, held: [], alerts: [], items: 0, dismiss };
  return { ...found, alerts, items: (found.outage ? 1 : 0) + found.held.length + alerts.length, dismiss };
}

function FleetAlerts({ attention: { outage, probing, held, alerts, items, dismiss }, onShowWorker }: {
  attention: FleetAttention; onShowWorker: (workerId: string) => void;
}) {
  const { t } = useT();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setOpen(prev => toggled(prev, id));
  if (!items) return null;
  return (
    <div className="fleet-rack-alerts" role="status">
      {outage > 0 && (
        <div className="fleet-rack-alert">
          <span><span className="chip warn">{t('fleetPark_license_outage')}</span>{' '}{t('fleetOutageBanner', { n: outage, probing })}</span>
        </div>
      )}
      {held.map(worker => (
        <div key={worker} className="fleet-rack-alert">
          <strong>{t('fleetHeldLine', { worker })}</strong>
          <span className="fleet-rack-alert-acts">
            <button type="button" className="btn sm" onClick={() => onShowWorker(worker)}>{t('fleetShowWorker')}</button>
          </span>
        </div>
      ))}
      {alerts.map(a => (
        <div key={a.id} className="fleet-rack-alert">
          <strong>{a.title}</strong>
          <span className="fleet-rack-alert-acts">
            {a.body && (
              <button type="button" className="btn sm ghost" aria-expanded={open.has(a.id)} onClick={() => toggle(a.id)}>
                {t(open.has(a.id) ? 'fleetAlertHide' : 'fleetAlertDetails')}
              </button>
            )}
            <button type="button" className="btn sm ghost" onClick={() => dismiss(a.id)}>{t('fleetAlertDismiss')}</button>
          </span>
          {a.body && open.has(a.id) && <p>{a.body}</p>}
        </div>
      ))}
    </div>
  );
}

/** The latest roll in one row: its state, how far it got, the worker being
 *  replaced now and why it stopped if it did. The full image is on the version's hover. */
export function ReleaseBanner({ release, now }: { release: FleetRelease; now?: number }) {
  const { t } = useT();
  const sum = releaseSummary(release)!;
  return (
    <div className="fleet-rack-quiet">
      <span />
      <span className="fleet-rack-quiet-name">{t('fleetReleaseCard')}</span>
      <span className="fleet-rack-quiet-body">
        <span className={RELEASE_CHIP[release.state]}>{t(`fleetReleaseState_${release.state}`)}</span>
        {' '}<span className="mono" title={release.image}>{release.version}</span>
        {' · '}{t('fleetReleaseCounts', { n: sum.upgraded, skipped: sum.skipped })}
        {sum.replacing && <> · {t('fleetRollReplacing', { worker: sum.replacing })}</>}
        {' · '}{t('fleetReleaseSince')} <Clock at={release.started_at} now={now} />
        {release.failure && <span className="fp-warn fleet-rack-failure">{release.failure}</span>}
      </span>
    </div>
  );
}

const toggled = (set: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(set);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
};

function FoldButton({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" className="btn ghost icon sm fleet-rack-fold" aria-expanded={open} aria-label={label} title={label} onClick={onToggle}>
      <Icon name="chevronRight" size={13} />
    </button>
  );
}

const naturally = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** One line per host: its bays and what it is short of; the rest in its fold.
 *  A host the rows name but nobody registered (the coordinator's, until
 *  cutover) has no agent to tell anything, so it has no fold. Each bay shows
 *  its worker in the table. Without a roll, workers on an older image get a
 *  quiet note, not a bar: nothing is replacing them. */
export function HostRows({ hosts, rows, release, onChanged, onShowWorker, now = Date.now() }: {
  hosts: readonly FleetHost[]; rows: readonly FleetRow[]; release: FleetRelease | null;
  onChanged: () => void; onShowWorker: (workerId: string) => void; now?: number;
}) {
  const { t } = useT();
  const mirror = useFleetMirror();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [removing, setRemoving] = useState<FleetHost | null>(null);
  const [lowering, setLowering] = useState<{ host: FleetHost; next: number } | null>(null);

  const act = async (id: string, run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(id);
    try {
      await run();
      onChanged();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(null);
    }
  };
  const capacity = (h: FleetHost, delta: number) => {
    const next = Math.min(CAPACITY_MAX, Math.max(0, h.capacity + delta));
    if (next === h.capacity) return;
    // The agent leaves every container above the new count in place, but a
    // running one then goes on past the capacity: say so before saving.
    if (capacityCuts(h, next).some(c => c.state === 'running')) setLowering({ host: h, next });
    else void act(h.host_id, () => fleetApi.updateHost(h.host_id, { capacity: next }));
  };
  const authoritative = (h: FleetHost) => act(h.host_id, () => fleetApi.updateHost(h.host_id, { authoritative: !h.authoritative }));

  const registered = new Set(hosts.map(h => h.host_id));
  const unregistered = [...new Set(rows.flatMap(r => r.host && !registered.has(r.host) ? [r.host] : []))].sort(naturally);
  if (hosts.length === 0 && unregistered.length === 0) {
    return <div className="fleet-rack-empty fp-muted">{t('fleetHostsNone')}</div>;
  }
  const bays = (hostId: string, cap: number) => (
    <span className="fleet-bays" role="group" aria-label={hostId}>
      {hostBays({ host_id: hostId, capacity: cap }, rows).map(({ key, row }) => {
        if (!row) return <span key={key} className="fleet-bay fleet-bay-empty" title={t('fleetBayEmpty', { worker: key })} />;
        const label = t('fleetBayTitle', { worker: row.workerId, state: t(KIND_KEY[row.kind]) });
        return <button key={key} type="button" className={`fleet-bay fleet-bay-${row.kind}`} title={label} aria-label={label} onClick={() => onShowWorker(row.workerId)} />;
      })}
    </span>
  );
  const sorted = [...hosts].sort((a, b) => Number(b.authoritative) - Number(a.authoritative) || naturally(a.host_id, b.host_id));
  return (
    <>
      {sorted.map(h => {
        const run = hostRunning(h);
        const roll = rollProgress(h, release);
        const lag = roll ? null : hostLag(h);
        const late = liveness(h.last_seen_at, now) !== 'live';
        const seen = t('fleetHostSeen', { ago: agoLabel(t, h.last_seen_at, now) });
        const rowBusy = busy === h.host_id;
        const folded = !open.has(h.host_id);
        return (
          <section key={h.host_id} className={`fleet-chassis${h.authoritative ? '' : ' fleet-chassis-observe'}`} aria-label={h.host_id}>
            <div className="fleet-chassis-line">
              <FoldButton open={!folded} onToggle={() => setOpen(o => toggled(o, h.host_id))} label={t('fleetFoldHost', { host: h.host_id })} />
              <span className="fleet-chassis-name mono" title={h.host_id}>{h.host_id}</span>
              {bays(h.host_id, h.capacity)}
              <span className="fleet-chassis-facts">
                {roll && (
                  <span className="fleet-chassis-roll">
                    <span>
                      {t('fleetHostRolling', { version: h.desired.version, done: roll.onTarget, total: roll.total })}
                      {roll.replacing && <> {t('fleetHostRollNext', { worker: roll.replacing })}</>}
                    </span>
                    <span className="fleet-chassis-bar"><i style={{ width: `${roll.total ? roll.onTarget / roll.total * 100 : 0}%` }} /></span>
                  </span>
                )}
                {lag && <span className="fleet-chassis-behind">{t('fleetHostOlderBuilds', { n: lag.behind })}</span>}
                {!h.authoritative && <span>{t('fleetAuthoritativeOff')}</span>}
                {late && <span className="fp-warn">{seen}</span>}
                <span className="fleet-chassis-count">{t('fleetHostRunningOf', { running: run.running, capacity: h.capacity })}</span>
              </span>
            </div>
            <div className="fleet-chassis-fold" hidden={folded}>
              <span>{t('fleetHostAgent')} <span className="mono">{h.version ?? '—'}</span>, {seen}</span>
              <span>
                {lag ? t('fleetHostBehind', { n: lag.behind, versions: lag.versions.join(', '), version: lag.target })
                  : h.desired.version ? t('fleetHostWorkerVersion', { version: h.desired.version }) : t('fleetHostNoImage')}
                {!h.authoritative && <> {t('fleetHostObserveNote')}</>}
              </span>
              <span className="fleet-chassis-controls">
                <button type="button" role="switch" aria-checked={h.authoritative} className={`fleet-switch${h.authoritative ? ' on' : ''}`}
                  onClick={() => authoritative(h)} disabled={rowBusy || mirror} title={t(h.authoritative ? 'fleetAuthoritativeOnHint' : 'fleetAuthoritativeOffHint')}>
                  <i /><span>{t(h.authoritative ? 'fleetAuthoritative' : 'fleetAuthoritativeOff')}</span>
                </button>
                <span className="fleet-stepper" title={t('fleetCapacityHint')}>
                  {!mirror && <button type="button" className="btn ghost icon sm" onClick={() => capacity(h, -1)} disabled={rowBusy || h.capacity <= 0}
                    aria-label={t('fleetCapacityLess')}><Icon name="minus" size={12} /></button>}
                  <b className="mono">{h.capacity}</b>
                  {!mirror && <button type="button" className="btn ghost icon sm" onClick={() => capacity(h, 1)} disabled={rowBusy || h.capacity >= CAPACITY_MAX}
                    aria-label={t('fleetCapacityMore')}><Icon name="plus" size={12} /></button>}
                  <small>{t('fleetCapacityWorkers')}</small>
                </span>
                {!mirror && (
                  <button type="button" className="btn sm ghost fleet-danger-text" onClick={() => setRemoving(h)} disabled={rowBusy}>
                    {t('fleetHostRemove')}
                  </button>
                )}
              </span>
            </div>
          </section>
        );
      })}
      {unregistered.map(id => (
        <section key={id} className="fleet-chassis" aria-label={id}>
          <div className="fleet-chassis-line">
            <span />
            <span className="fleet-chassis-name mono" title={id}>{id}</span>
            {bays(id, 0)}
            <span className="fleet-chassis-facts">
              <span className="fleet-chassis-count">{t('fleetRackWorkers', { n: rows.filter(r => r.host === id).length })}</span>
            </span>
          </div>
        </section>
      ))}
      {removing && (
        <RemoveHostDialog host={removing} onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); onChanged(); }} />
      )}
      {lowering && (
        <LowerCapacityDialog host={lowering.host} next={lowering.next} onClose={() => setLowering(null)}
          onDone={() => { setLowering(null); onChanged(); }} />
      )}
    </>
  );
}

export function LowerCapacityDialog({ host, next, onClose, onDone }: { host: FleetHost; next: number; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const cuts = capacityCuts(host, next);
  const running = cuts.filter(c => c.state === 'running').length;
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fleetApi.updateHost(host.host_id, { capacity: next });
      onDone();
    } catch (e) {
      handleFetchError(e);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 460 }}>
      <ConfirmDialogBody title={t('fleetCapacityLowerTitle', { host: host.host_id, n: next })} confirm={t('fleetCapacityLowerConfirm')} busy={busy}
        onClose={onClose} onConfirm={confirm}
        body={<>
          <p>{t('fleetCapacityLowerBody', { n: cuts.length })}</p>
          <ul className="fleet-capacity-cuts">
            {cuts.map(c => (
              <li key={c.worker_id}>
                <span className="mono">{c.worker_id}</span>{' '}
                <span className={c.state === 'running' ? 'chip pos' : 'chip'}>{c.state}</span>
              </li>
            ))}
          </ul>
          <p className="fp-warn">{t('fleetCapacityLowerRunning', { n: running })}</p>
        </>} />
    </Modal>
  );
}

function RemoveHostDialog({ host, onClose, onDone }: { host: FleetHost; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const running = hostRunning(host).running;
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fleetApi.removeHost(host.host_id);
      showSuccessToast(t('fleetHostRemovedToast', { host: host.host_id }));
      onDone();
    } catch (e) {
      handleFetchError(e);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 460 }}>
      <ConfirmDialogBody title={t('fleetHostRemoveTitle', { host: host.host_id })} confirm={t('fleetHostRemove')} busy={busy} danger
        onClose={onClose} onConfirm={confirm}
        body={<>
          <p>{t('fleetHostRemoveBody')}</p>
          {running > 0 && <p className="fp-warn">{t('fleetHostRemoveRunning', { n: running })}</p>}
        </>} />
    </Modal>
  );
}

// Register a host. The ERP answers with the host's bearer token once; it is
// shown here with a copy button and never again, so the dialog says so.
export function AddHostDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { t } = useT();
  const [hostId, setHostId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<FleetHostCreated | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const id = hostId.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) { setProblem(t('fleetHostBadId')); return; }
    setBusy(true);
    setProblem(null);
    try {
      const host = await fleetApi.addHost(id);
      setCreated(host);
      onChanged();
    } catch (err) {
      setProblem(err instanceof ApiError && err.status === 409 ? t('fleetHostDupe', { host: id }) : t('fleetHostAddFailed'));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 520 }}>
      <div className="modal-head">
        <div>
          <div className="modal-title">{created ? t('fleetHostAddedTitle', { host: created.host_id }) : t('fleetHostAddTitle')}</div>
          <div className="modal-sub">{created ? t('fleetHostTokenOnce') : t('fleetHostAddSub')}</div>
        </div>
      </div>
      {created ? (
        <>
          <div className="modal-body fleet-form">
            <label className="fleet-field">
              <span>{t('fleetHostToken')}</span>
              <span className="fleet-token">
                <code className="mono">{created.token}</code>
                <button type="button" className="btn sm" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={13} />{t(copied ? 'fleetCopied' : 'fleetCopy')}</button>
              </span>
            </label>
            <p className="fp-muted">{t('fleetHostAgentHint')}</p>
            <pre className="fleet-env mono">{`FLEET_URL=${window.location.origin}\nFLEET_HOST_ID=${created.host_id}\nFLEET_HOST_TOKEN=<the token above>`}</pre>
            <p className="fp-muted">{t('fleetHostObserveHint')}</p>
          </div>
          <div className="modal-foot">
            <button type="button" className="btn primary" onClick={onClose}>{t('done')}</button>
          </div>
        </>
      ) : (
        <form onSubmit={submit}>
          <div className="modal-body fleet-form">
            <label className="fleet-field">
              <span>{t('fleetColHost')}</span>
              <input className="input mono" value={hostId} onChange={e => setHostId(e.target.value)} placeholder="worker-60-14" autoFocus
                autoComplete="off" spellCheck={false} />
              <small className="fp-muted">{t('fleetHostIdHint')}</small>
            </label>
            {problem && <p role="alert" className="fp-warn">{problem}</p>}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
            <button type="submit" className="btn primary" disabled={busy}>{t('fleetHostAdd')}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// Roll the fleet onto a new worker image. One idle worker at a time per host;
// the Roll column follows the progress.
export function ReleaseDialog({ current, onClose, onDone }: { current: string | null; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const [image, setImage] = useState(current ?? 'ghcr.io/jinhuw/aimm-recycle:');
  const [version, setVersion] = useState(current?.split(':').pop() ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const img = image.trim();
    const ver = version.trim();
    if (!/^[a-z0-9.\-/_]+:[A-Za-z0-9._-]+$/.test(img)) { setProblem(t('fleetReleaseBadImage')); return; }
    if (!ver) { setProblem(t('fleetReleaseNeedVersion')); return; }
    setBusy(true);
    setProblem(null);
    try {
      await fleetApi.release({ image: img, version: ver });
      showSuccessToast(t('fleetReleaseStarted', { version: ver }));
      onDone();
    } catch (err) {
      handleFetchError(err);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 520 }}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{t('fleetReleaseTitle')}</div>
            <div className="modal-sub">{t('fleetReleaseSub')}</div>
          </div>
        </div>
        <div className="modal-body fleet-form">
          <label className="fleet-field">
            <span>{t('fleetReleaseImage')}</span>
            <input className="input mono" value={image} onChange={e => { setImage(e.target.value); setVersion(e.target.value.split(':').pop() ?? ''); }}
              autoComplete="off" spellCheck={false} autoFocus />
          </label>
          <label className="fleet-field">
            <span>{t('fleetReleaseVersion')}</span>
            <input className="input mono" value={version} onChange={e => setVersion(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <p className="fp-muted">{t('fleetReleaseNote')}</p>
          {problem && <p role="alert" className="fp-warn">{problem}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{t('cancel')}</button>
          <button type="submit" className="btn primary" disabled={busy}>{t('fleetReleaseConfirm')}</button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Browser engine ───────────────────────────────────────────────────────────
// One row under the hosts: whether accounts may move to CloakBrowser, how
// many may run it at once (the license's session limit), and the loss rate
// each engine has had, against the stint ledger's baseline from before the
// state history. The switch itself is per account, on the table's rows.

export function EngineCard({ settings, used, onChanged }: { settings: FleetSettings; used: number; onChanged: () => void }) {
  const { t } = useT();
  const mirror = useFleetMirror();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [loss, setLoss] = useState<FleetEngineLoss | null>(null);
  useEffect(() => {
    let live = true;
    fleetApi.engineLoss(LOSS_DAYS).then(l => { if (live) setLoss(l); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const save = async (patch: Partial<FleetSettings>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fleetApi.saveSettings(patch);
      showSuccessToast(t('fleetEngineSaved'));
      onChanged();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(false);
    }
  };
  const on = settings.cloak_enabled;
  const max = settings.cloak_max_slots;
  return (
    <section className="fleet-rack-engine" aria-label={t('fleetEngineCard')}>
      <div className="fleet-rack-quiet">
        <FoldButton open={open} onToggle={() => setOpen(o => !o)} label={t('fleetFoldEngine')} />
        <span className="fleet-rack-quiet-name">{t('fleetEngineCard')}</span>
        <span className="fleet-rack-quiet-body">{t('fleetEngineSeatsUsed', { used, max })} · <EngineLossLine loss={loss} /></span>
      </div>
      <div className="fleet-chassis-fold" hidden={!open}>
        <span className="fleet-chassis-controls">
          <button type="button" role="switch" aria-checked={on} className={`fleet-switch${on ? ' on' : ''}`}
            onClick={() => save({ cloak_enabled: !on })} disabled={busy || mirror} title={t(on ? 'fleetEngineCloakOnHint' : 'fleetEngineCloakOffHint')}>
            <i /><span>{t(on ? 'fleetEngineCloakOn' : 'fleetEngineCloakOff')}</span>
          </button>
          <span className="fleet-stepper" title={t('fleetEngineSeatsHint')}>
            {!mirror && <button type="button" className="btn ghost icon sm" onClick={() => save({ cloak_max_slots: max - 1 })} disabled={busy || max <= 0}
              aria-label={t('fleetEngineSeatsLess')}><Icon name="minus" size={12} /></button>}
            <b className="mono">{max}</b>
            {!mirror && <button type="button" className="btn ghost icon sm" onClick={() => save({ cloak_max_slots: max + 1 })} disabled={busy || max >= CLOAK_SEATS_MAX}
              aria-label={t('fleetEngineSeatsMore')}><Icon name="plus" size={12} /></button>}
            <small>{t('fleetEngineSeats')}</small>
          </span>
        </span>
      </div>
    </section>
  );
}

export function EngineLossLine({ loss }: { loss: FleetEngineLoss | null }) {
  const { t } = useT();
  if (!loss) return <span>{t('fleetEngineLossHead', { days: LOSS_DAYS })} …</span>;
  const rate = (r: FleetEngineLossRow, name: string) => (
    <span key={name} title={t('fleetEngineLossDetail', { losses: r.total_losses, days: r.account_days.toFixed(1) })}>
      {name}{' '}
      {r.losses_per_100_account_days === null ? <em>{t('fleetEngineLossNone')}</em> : <b className="mono">{r.losses_per_100_account_days.toFixed(2)}</b>}
    </span>
  );
  const parts = [
    ...loss.engines.map(r => rate(r, t(r.engine === 'cloak' ? 'fleetEngine_cloak' : 'fleetEngine_stock'))),
    rate(loss.retro, t('fleetEngineRetro')),
  ];
  return (
    <span>
      {t('fleetEngineLossHead', { days: loss.days })}{' '}
      {parts.flatMap((p, i) => (i ? [<span key={`s${i}`}> · </span>, p] : [p]))}
    </span>
  );
}
