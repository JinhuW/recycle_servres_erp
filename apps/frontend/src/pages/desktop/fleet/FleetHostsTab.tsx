import { useState, type FormEvent } from 'react';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/Modal';
import { TableSkeleton } from '../../../components/Skeleton';
import { ApiError } from '../../../lib/api';
import { fleetApi, type FleetHost, type FleetHostCreated, type FleetRelease } from '../../../lib/fleet';
import { handleFetchError, showSuccessToast } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import { hostRunning, releaseSummary, rollProgress } from './fleetBoard';
import { Clock, ConfirmDialogBody, EmptyRow, SeenChip, TabCard, UnavailableCard, useFleetPoll } from './shared';

// ─── Hosts ────────────────────────────────────────────────────────────────────
// The machines that run worker containers. Each runs one agent that asks the
// ERP what it should run (count, image) and reports what it does run. A host
// is observe-only until a manager makes it authoritative, so a freshly
// registered agent starts nothing by accident. A release names an image and a
// version; the ERP then replaces one idle worker at a time across the fleet,
// and the roll's state (the latest release only) shows above the table.

const CAPACITY_MAX = 64;

export function FleetHostsTab() {
  const { t } = useT();
  const { data, reload } = useFleetPoll(() => fleetApi.hosts());
  const [adding, setAdding] = useState(false);
  const [releasing, setReleasing] = useState(false);

  if (data === 'unavailable') return <UnavailableCard text={t('fleetNotServed')} />;
  const hosts = data?.hosts ?? [];
  const release = data?.release ?? null;
  const running = hosts.reduce((n, h) => n + hostRunning(h).running, 0);
  const desired = hosts.reduce((n, h) => n + hostRunning(h).desired, 0);
  const image = hosts.find(h => h.desired.image)?.desired.image || null;

  return (
    <div className="fp-pool">
      <TabCard title={t('fleetHostsTitle')} className="fleet-hosts"
        sub={data ? t('fleetHostsSub', { hosts: hosts.length, running, desired }) : ''}
        actions={<>
          <button type="button" className="btn sm" onClick={() => setReleasing(true)} disabled={!data || hosts.length === 0}>
            <Icon name="upload" size={13} />{t('fleetRelease')}
          </button>
          <button type="button" className="btn sm primary" onClick={() => setAdding(true)} disabled={!data}>
            <Icon name="plus" size={13} />{t('fleetHostAdd')}
          </button>
        </>}>
        {release && <ReleaseBanner release={release} />}
        {data === null ? <TableSkeleton rows={3} cols={7} /> : <HostsTable hosts={hosts} onChanged={reload} />}
      </TabCard>
      {image && (
        <p className="fp-muted fleet-note">{t('fleetHostsImage', { image })}</p>
      )}
      {adding && <AddHostDialog onClose={() => setAdding(false)} onChanged={reload} />}
      {releasing && <ReleaseDialog current={release?.image ?? image} onClose={() => setReleasing(false)} onDone={() => { setReleasing(false); reload(); }} />}
    </div>
  );
}

const RELEASE_CHIP: Record<FleetRelease['state'], string> = {
  rolling: 'chip info', done: 'chip pos', failed: 'chip neg', superseded: 'chip muted',
};

/** The latest roll: its state, how far it got, the worker being replaced now and why it stopped if it did. */
export function ReleaseBanner({ release, now }: { release: FleetRelease; now?: number }) {
  const { t } = useT();
  const sum = releaseSummary(release)!;
  return (
    <div className="card-body fleet-release">
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

export function HostsTable({ hosts, onChanged, now = Date.now() }: { hosts: readonly FleetHost[]; onChanged: () => void; now?: number }) {
  const { t } = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<FleetHost | null>(null);

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
    if (next !== h.capacity) void act(h.host_id, () => fleetApi.updateHost(h.host_id, { capacity: next }));
  };
  const authoritative = (h: FleetHost) => act(h.host_id, () => fleetApi.updateHost(h.host_id, { authoritative: !h.authoritative }));

  return (
    <div className="fp-table-wrap">
      <table className="fp-table fleet-table">
        <thead>
          <tr>
            <th>{t('fleetColHost')}</th>
            <th>{t('fleetColAuthoritative')}</th>
            <th className="num">{t('fleetColCapacity')}</th>
            <th>{t('fleetColAgentVersion')}</th>
            <th>{t('fleetColLastSeen')}</th>
            <th className="num">{t('fleetColRunning')}</th>
            <th>{t('fleetColRoll')}</th>
            <th aria-label={t('fleetColActions')} />
          </tr>
        </thead>
        <tbody>
          {hosts.length === 0 && <EmptyRow cols={8}>{t('fleetHostsNone')}</EmptyRow>}
          {hosts.map(h => {
            const run = hostRunning(h);
            const roll = rollProgress(h);
            const rowBusy = busy === h.host_id;
            return (
              <tr key={h.host_id}>
                <td>
                  <span className="fp-holder">
                    <span className="mono">{h.host_id}</span>
                    {h.desired.version && <small>{t('fleetHostWorkerVersion', { version: h.desired.version })}</small>}
                  </span>
                </td>
                <td>
                  <button type="button" role="switch" aria-checked={h.authoritative} className={`fleet-switch${h.authoritative ? ' on' : ''}`}
                    onClick={() => authoritative(h)} disabled={rowBusy} title={t(h.authoritative ? 'fleetAuthoritativeOnHint' : 'fleetAuthoritativeOffHint')}>
                    <i /><span>{t(h.authoritative ? 'fleetAuthoritativeOn' : 'fleetAuthoritativeOff')}</span>
                  </button>
                </td>
                <td className="num">
                  <span className="fleet-stepper">
                    <button type="button" className="btn ghost icon sm" onClick={() => capacity(h, -1)} disabled={rowBusy || h.capacity <= 0}
                      aria-label={t('fleetCapacityLess')}><Icon name="minus" size={12} /></button>
                    <b className="mono">{h.capacity}</b>
                    <button type="button" className="btn ghost icon sm" onClick={() => capacity(h, 1)} disabled={rowBusy || h.capacity >= CAPACITY_MAX}
                      aria-label={t('fleetCapacityMore')}><Icon name="plus" size={12} /></button>
                  </span>
                </td>
                <td className="mono">{h.version ?? <span className="fp-muted">—</span>}</td>
                <td><SeenChip at={h.last_seen_at} now={now} /></td>
                <td className="num mono">{run.running}<span className="ff-ring-of">/{run.desired}</span></td>
                <td>
                  {roll ? (
                    <span className="fp-holder">
                      <span className="chip info">{t('fleetRollProgress', { done: roll.onTarget, total: roll.total })}</span>
                      {roll.replacing && <small>{t('fleetRollReplacing', { worker: roll.replacing })}</small>}
                    </span>
                  ) : <span className="fp-muted">—</span>}
                </td>
                <td className="fleet-row-actions">
                  <button type="button" className="btn ghost icon sm" onClick={() => setRemoving(h)} disabled={rowBusy} title={t('fleetHostRemove')}>
                    <Icon name="trash" size={13} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {removing && (
        <RemoveHostDialog host={removing} onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); onChanged(); }} />
      )}
    </div>
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
function AddHostDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
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
function ReleaseDialog({ current, onClose, onDone }: { current: string | null; onClose: () => void; onDone: () => void }) {
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
