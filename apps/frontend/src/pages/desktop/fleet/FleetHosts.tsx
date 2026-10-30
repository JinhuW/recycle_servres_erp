import { useState, type FormEvent } from 'react';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/Modal';
import { ApiError } from '../../../lib/api';
import { fleetApi, type FleetHost, type FleetHostCreated, type FleetRelease } from '../../../lib/fleet';
import { handleFetchError, showSuccessToast } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import { capacityCuts, hostLag, hostRunning, releaseSummary, rollProgress } from './fleetBoard';
import { agoLabel, Clock, ConfirmDialogBody, useFleetMirror } from './shared';

// ─── Hosts ────────────────────────────────────────────────────────────────────
// The machines that run worker containers, as the strip of cards at the top
// of the Fleet tab. Each runs one agent that asks the ERP what it should run
// (count, image) and reports what it does run. A host is observe-only until a
// manager makes it authoritative, so a freshly registered agent starts
// nothing by accident. A release names an image and a version; the ERP then
// replaces one idle worker at a time across the fleet, and a host's card
// follows its part of the roll. The dialogs (add a host, roll out an image)
// open from the tab's action row.

const CAPACITY_MAX = 64;

const RELEASE_CHIP: Record<FleetRelease['state'], string> = {
  rolling: 'chip info', done: 'chip pos', failed: 'chip neg', superseded: 'chip muted',
};

/** The latest roll: its state, how far it got, the worker being replaced now and why it stopped if it did. */
export function ReleaseBanner({ release, now }: { release: FleetRelease; now?: number }) {
  const { t } = useT();
  const sum = releaseSummary(release)!;
  return (
    <div className="card fleet-release">
      <span className="fp-holder">
        <span>
          <span className={RELEASE_CHIP[release.state]}>{t(`fleetReleaseState_${release.state}`)}</span>
          {' '}<span className="mono">{release.version}</span>
          <small className="fp-muted mono"> {release.image}</small>
        </span>
        <small>
          {t('fleetReleaseCounts', { n: sum.upgraded, skipped: sum.skipped })}
          {sum.replacing && <> · {t('fleetRollReplacing', { worker: sum.replacing })}</>}
          {' · '}{t('fleetReleaseSince')} <Clock at={release.started_at} now={now} />
        </small>
        {release.failure && <small className="fp-warn">{release.failure}</small>}
      </span>
    </div>
  );
}

/** One compact card per host: id, agent version, last seen, running of
 *  capacity, the authoritative switch, the capacity stepper, and the roll's
 *  progress line while a release rolls. Without one, workers left on an older
 *  image get a quiet note, not a bar: nothing is replacing them. */
export function HostStrip({ hosts, release, onChanged, now = Date.now() }: {
  hosts: readonly FleetHost[]; release: FleetRelease | null; onChanged: () => void; now?: number;
}) {
  const { t } = useT();
  const mirror = useFleetMirror();
  const [busy, setBusy] = useState<string | null>(null);
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

  if (hosts.length === 0) {
    return <div className="card fleet-hosts-empty"><span className="fp-muted">{t('fleetHostsNone')}</span></div>;
  }
  return (
    <div className="fleet-hosts-strip">
      {hosts.map(h => {
        const run = hostRunning(h);
        const roll = rollProgress(h, release);
        const lag = roll ? null : hostLag(h);
        const rowBusy = busy === h.host_id;
        return (
          <section key={h.host_id} className="card fleet-host" aria-label={h.host_id}>
            <div className="fleet-host-line">
              <span className="fleet-host-id mono">{h.host_id}</span>
              <span className="fleet-host-meta">
                {t('fleetHostAgent')} <span className="mono">{h.version ?? '—'}</span>
                {' · '}{t('fleetHostSeen', { ago: agoLabel(t, h.last_seen_at, now) })}
                {' · '}{t('fleetHostRunningOf', { running: run.running, capacity: h.capacity })}
              </span>
              <span className="fleet-host-right">
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
                  <button type="button" className="btn ghost icon sm" onClick={() => setRemoving(h)} disabled={rowBusy} title={t('fleetHostRemove')}
                    aria-label={t('fleetHostRemove')}>
                    <Icon name="trash" size={13} />
                  </button>
                )}
              </span>
            </div>
            {roll ? (
              <div className="fleet-host-roll">
                <span>
                  {t('fleetHostRolling', { version: h.desired.version, done: roll.onTarget, total: roll.total })}
                  {roll.replacing && <> {t('fleetHostRollNext', { worker: roll.replacing })}</>}
                </span>
                <span className="fleet-host-bar"><i style={{ width: `${roll.total ? roll.onTarget / roll.total * 100 : 0}%` }} /></span>
              </div>
            ) : (
              <div className="fleet-host-meta">
                {lag ? t('fleetHostBehind', { n: lag.behind, versions: lag.versions.join(', '), version: lag.target })
                  : h.desired.version ? t('fleetHostWorkerVersion', { version: h.desired.version }) : t('fleetHostNoImage')}
                {!h.authoritative && <> · {t('fleetHostObserveNote')}</>}
                {release?.state === 'failed' && release.failure && <> · <span className="fp-warn">{release.failure}</span></>}
              </div>
            )}
          </section>
        );
      })}
      {removing && (
        <RemoveHostDialog host={removing} onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); onChanged(); }} />
      )}
      {lowering && (
        <LowerCapacityDialog host={lowering.host} next={lowering.next} onClose={() => setLowering(null)}
          onDone={() => { setLowering(null); onChanged(); }} />
      )}
    </div>
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
