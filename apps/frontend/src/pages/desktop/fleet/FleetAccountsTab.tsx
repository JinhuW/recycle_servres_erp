import { useCallback, useMemo, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/Modal';
import { TableSkeleton } from '../../../components/Skeleton';
import { coordinatorApi, type Challenge, type FleetDoc } from '../../../lib/coordinator';
import { handleFetchError, showSuccessToast } from '../../../lib/errorToast';
import { poolApi } from '../../../lib/facebookPool';
import { fleetApi, type FleetHost, type FleetRelease, type FleetSlot, type FleetWorker } from '../../../lib/fleet';
import { queueCityName } from '../../../lib/fleetView';
import { useT } from '../../../lib/i18n';
import { fleetWorkerPath, hrefFor, onLinkClick } from '../../../lib/route';
import { ActivityAside } from '../FleetWorkers';
import { dueLabel, easternClock, maskUid } from './fleetBoard';
import {
  EMPTY_FLEET_ROW_FILTER, FLEET_ROW_KINDS, filterFleetRows, fleetRowCounts, fleetRowHosts, fleetRows, fleetRunning, NOT_RUNNING,
  type FleetPoolAccount, type FleetRow, type FleetRowFilter, type FleetRowKind,
} from './fleetRows';
import { AddHostDialog, HostStrip, ReleaseBanner, ReleaseDialog } from './FleetHosts';
import {
  agoLabel, BudgetRing, ConfirmDialogBody, COORDINATOR_POLL_MS, EmptyRow, Legend, UnavailableCard, useFleetPoll, WorkerStateChip,
} from './shared';

// ─── Fleet ────────────────────────────────────────────────────────────────────
// The hosts as a strip of cards, then one table of every account: the ones
// the ERP's fleet runs (slots and workers, merged by account number), the
// coordinator's workers until cutover (host "homelab"), and the accounts
// nothing runs, each with the reason and the action that changes it. The
// legend, the host select and the search box narrow the table. The activity
// aside stays under the table while the coordinator's rows exist. The ERP's
// own data and the coordinator's are read apart: the table shows the ERP's
// rows at once and the coordinator's join them when its slower answer lands.

type ErpData = {
  slots: FleetSlot[]; workers: FleetWorker[]; hosts: FleetHost[]; release: FleetRelease | null; pool: FleetPoolAccount[] | null;
};
type CoordinatorData = { coordinator: FleetDoc | null; challenges: Challenge[] | null };
type Data = ErpData & CoordinatorData & { coordinatorPending?: boolean };

const KIND_DOT: Record<FleetRowKind | 'all', string> = {
  all: 'fleet-dot-all', healthy: 'fleet-dot-pos', degraded: 'fleet-dot-warn', replacing: 'fleet-dot-info',
  quarantined: 'fleet-dot-cool', parked: 'fleet-dot-neg', taken: 'fleet-dot-warn-strong',
};
const POOL_KEY: Record<string, string> = {
  available: 'fpAvailable', taken: 'fpTaken', fleet: 'fpInFleet', problem: 'fpProblem', retired: 'fpRetired',
};
const KIND_KEY: Record<FleetRowKind | 'all', string> = {
  all: 'fleetKindAll', healthy: 'fleetKindHealthy', degraded: 'fleetKindDegraded', replacing: 'fleetKindReplacing',
  quarantined: 'fleetKindQuarantined', parked: 'fleetKindParked', taken: 'fleetKindTaken',
};

export function FleetAccountsTab() {
  const { t, locale } = useT();
  const erp = useFleetPoll<ErpData>(() => Promise.all([
    fleetApi.slots(), fleetApi.workers(), fleetApi.hosts(),
    // The pool names the accounts nothing runs.
    poolApi.summary().then(s => s.accounts).catch(() => null),
  ]).then(([slots, workers, hosts, pool]) => ({ slots, workers, hosts: hosts.hosts, release: hosts.release, pool })));
  // The coordinator's rows go away at cutover; without the proxy the table
  // is the ERP's fleet alone.
  const coord = useFleetPoll<CoordinatorData>(() => Promise.all([
    coordinatorApi.fleet().catch(() => null),
    coordinatorApi.listOpenChallenges().catch(() => null),
  ]).then(([coordinator, challenges]) => ({ coordinator, challenges })), COORDINATOR_POLL_MS);
  const data = useMemo<Data | 'unavailable' | null>(() => {
    if (erp.data === null || erp.data === 'unavailable') return erp.data;
    const c = coord.data === null || coord.data === 'unavailable' ? null : coord.data;
    return { ...erp.data, coordinator: c?.coordinator ?? null, challenges: c?.challenges ?? null, coordinatorPending: coord.data === null };
  }, [erp.data, coord.data]);
  const { reload: reloadErp } = erp;
  const { reload: reloadCoordinator } = coord;
  const reload = useCallback(() => { reloadErp(); reloadCoordinator(); }, [reloadErp, reloadCoordinator]);
  const [adding, setAdding] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [filter, setFilter] = useState<FleetRowFilter>(EMPTY_FLEET_ROW_FILTER);

  if (data === 'unavailable') return <UnavailableCard text={t('fleetNotServed')} />;
  const hosts = data?.hosts ?? [];
  const release = data?.release ?? null;
  const image = hosts.find(h => h.desired.image)?.desired.image || null;
  const coordinatorRows = (data?.coordinator?.workers.length ?? 0) > 0;

  return (
    <div className="fp-pool">
      <div className="fleet-tab-head">
        <p className="fleet-lede">{t('fleetLede')}</p>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => setReleasing(true)} disabled={!data || hosts.length === 0}>{t('fleetReleaseAction')}</button>
          <button type="button" className="btn primary" onClick={() => setAdding(true)} disabled={!data}>{t('fleetHostAdd')}</button>
        </div>
      </div>
      {data === null ? <div className="card fleet-host"><TableSkeleton rows={1} cols={4} /></div>
        : <HostStrip hosts={hosts} release={release} onChanged={reload} />}
      {release && (release.state === 'rolling' || release.state === 'failed') && <ReleaseBanner release={release} />}
      <section className="card fleet-card" aria-label={t('fleetColAccount')}>
        {data === null ? <TableSkeleton rows={6} cols={9} />
          : <AccountsTable data={data} filter={filter} onFilter={setFilter} onChanged={reload} />}
      </section>
      {coordinatorRows && data && (
        <ActivityAside fleet={data.coordinator} unavailable={false} challenges={data.challenges} locale={locale} />
      )}
      {adding && <AddHostDialog onClose={() => setAdding(false)} onChanged={reload} />}
      {releasing && <ReleaseDialog current={release?.image ?? image} onClose={() => setReleasing(false)} onDone={() => { setReleasing(false); reload(); }} />}
    </div>
  );
}

export function AccountsTable({ data, filter, onFilter, onChanged, now = Date.now() }: {
  data: Data; filter: FleetRowFilter; onFilter: (f: FleetRowFilter) => void; onChanged: () => void; now?: number;
}) {
  const { t } = useT();
  const rows = useMemo(() => fleetRows(data, now), [data, now]);
  const shown = useMemo(() => filterFleetRows(rows, filter), [rows, filter]);
  const counts = useMemo(() => fleetRowCounts(rows), [rows]);
  const hostIds = useMemo(() => fleetRowHosts(rows, data.hosts.map(h => h.host_id)), [rows, data.hosts]);
  const running = fleetRunning(rows);
  const versions = new Map(data.hosts.map(h => [h.host_id, h.desired.version]));
  const budget = data.slots[0]?.budget_minutes ?? 360;
  const set = (patch: Partial<FleetRowFilter>) => onFilter({ ...filter, ...patch });
  return (
    <>
      <div className="fp-toolbar fleet-toolbar">
        <Legend buckets={FLEET_ROW_KINDS} counts={counts} value={filter.kind} onChange={kind => set({ kind })}
          label={k => t(KIND_KEY[k])} dotClass={k => KIND_DOT[k]} />
        <select className="input fleet-select" value={filter.host} aria-label={t('fleetColHost')} onChange={e => set({ host: e.target.value })}>
          <option value="">{t('fleetEveryHost')}</option>
          {hostIds.map(h => <option key={h} value={h}>{h}</option>)}
          <option value={NOT_RUNNING}>{t('fleetNotRunning')}</option>
        </select>
        <label className="toolbar-search">
          <Icon name="search" size={14} />
          <input className="input" type="search" value={filter.q} autoComplete="off" placeholder={t('fleetSearchAccounts')}
            aria-label={t('fleetSearchAccounts')} onChange={e => set({ q: e.target.value })} />
        </label>
      </div>
      <div className="fp-table-wrap fleet-table-cap">
        <table className="fp-table fleet-table fleet-accounts">
          <thead>
            <tr>
              <th>{t('fleetColAccount')}</th>
              <th>{t('fleetColHost')}</th>
              <th>{t('fleetColWorker')}</th>
              <th>{t('fleetColState')}</th>
              <th>{t('fleetColNow')}</th>
              <th>{t('fleetColToday')}</th>
              <th>{t('fleetColLease')}</th>
              <th>{t('fleetColVersion')}</th>
              <th aria-label={t('fbcOpenWorker')} />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <EmptyRow cols={9}>{rows.length === 0 ? t('fleetAccountsNone') : t('fleetAccountsNoMatch')}</EmptyRow>}
            {shown.map(r => <AccountRow key={r.key} row={r} hostVersion={r.host ? versions.get(r.host) ?? null : null}
              cityName={slug => queueCityName(data.coordinator, slug)} onChanged={onChanged} now={now} />)}
          </tbody>
        </table>
      </div>
      <div className="fp-table-foot fleet-foot">
        <span>{t('fleetAccountsFoot', { shown: shown.length, n: rows.length, running: running.running, hosts: running.hosts })}</span>
        <span>{t('fleetMinutesNote', { budget })}</span>
      </div>
    </>
  );
}

function AccountRow({ row: r, hostVersion, cityName, onChanged, now }: {
  row: FleetRow; hostVersion: string | null; cityName: (slug: string) => string; onChanged: () => void; now: number;
}) {
  const { t, locale } = useT();
  const [busy, setBusy] = useState(false);
  const [parking, setParking] = useState(false);
  const [unparking, setUnparking] = useState(false);
  const slot = r.slot;
  const quarantined = r.kind === 'quarantined';

  const releaseQuarantine = async () => {
    if (!slot || busy) return;
    setBusy(true);
    try {
      await fleetApi.releaseQuarantine(slot.account_no);
      showSuccessToast(t('fleetQuarantineReleased', { no: slot.account_no }));
      onChanged();
    } catch (e) {
      handleFetchError(e);
    } finally {
      setBusy(false);
    }
  };

  const since = r.now?.since ? Math.max(0, Math.round((now - Date.parse(r.now.since)) / 1000)) : null;
  const elapsed = since === null ? '' : `${Math.floor(since / 60)}m ${String(since % 60).padStart(2, '0')}s`;
  const nowCell = r.replacingTo
    ? <em className="fleet-hold">{t('fleetNowReplacing', { version: r.replacingTo })}</em>
    : r.now
      ? <span className="fleet-task-now">
          <span className="fleet-task-city">{r.now.cityName ?? cityName(r.now.city)} <span className="mono fp-muted">{r.now.item}</span></span>
          <small><span className="mono">{elapsed}</span>{r.now.home && <> · {t('fleetNowHome')}</>}</small>
        </span>
      : r.running ? <em className="fleet-hold">{t('fleetNowWaiting')}</em> : null;

  const actions = slot && (
    <span className="fleet-now-actions">
      {quarantined && <button type="button" className="btn sm" onClick={releaseQuarantine} disabled={busy} title={t('fleetQuarantineReleaseHint')}>{t('fleetQuarantineRelease')}</button>}
      {slot.parked
        ? <button type="button" className="btn sm" onClick={() => setUnparking(true)} disabled={busy}>{t('fleetUnpark')}</button>
        : <button type="button" className={`btn sm${r.running ? ' ghost' : ''}`} onClick={() => setParking(true)} disabled={busy}>{t('fleetPark')}</button>}
    </span>
  );

  const stateChip = r.running && r.kind === 'healthy' ? <span className="chip pos">{t('fleetKindHealthy')}</span>
    : r.running && r.kind === 'degraded' ? <span className="chip warn">{t('fleetKindDegraded')}</span>
    : r.kind === 'replacing' ? <span className="chip info">{t('fleetKindReplacing')}</span>
    : quarantined ? <span className="chip cool">{t('fleetKindQuarantined')}</span>
    : r.kind === 'taken' ? <span className="chip">{t('fleetKindTaken')}</span>
    : slot?.parked ? <span className="chip neg">{t('fleetLeaseParked')}</span>
    : r.state ? <WorkerStateChip state={r.state} />
    : r.source === 'coordinator' ? <span className="chip neg">{t(r.heartbeat ? 'fbcStatusOffline' : 'fbcNeverReported')}</span>
    : r.pool ? <span className="chip muted">{t(POOL_KEY[r.pool.status] ?? r.pool.status)}</span>
    : <span className="chip muted">{t('fleetNotRunning')}</span>;

  const note = quarantined && slot
    ? t('fleetQuarantineUntilAt', { time: easternClock(slot.quarantined_until, locale, now), span: dueLabel(t, slot.quarantined_until, now) })
    : r.kind === 'taken' ? t('fleetTakenNote', { who: r.pool?.holder ?? slot?.pool_status ?? '—' })
    : r.running && r.kind === 'degraded' ? t('fleetNoteDegraded')
    : r.heartbeat ? t('fleetBeat', { ago: agoLabel(t, r.heartbeat, now) })
    : r.pool?.note || null;

  return (
    <tr className={r.running ? undefined : 'fleet-row-idle'}>
      <td>
        <span className="fp-holder">
          <span>{r.no === null ? <span className="fp-muted">—</span> : t('fleetAccountNo', { no: r.no })}</span>
          <small className="mono" title={t('fleetUidMasked')}>{maskUid(r.uid)}</small>
        </span>
      </td>
      <td>
        {r.host
          ? <span className="mono fleet-hostcell">{r.host}</span>
          : <span className="fp-muted" title={r.lastHost ? t('fleetLastHost', { host: r.lastHost }) : undefined}>—</span>}
      </td>
      <td>
        <span className="fp-holder">
          {r.running && r.workerId
            ? <span className="mono">{r.workerId}</span>
            : <span className="fp-muted">{t('fleetNotRunning')}</span>}
          {r.running
            ? <small>{r.vncPort ? `vnc :${r.vncPort}` : '—'}</small>
            : r.lastHost && <small>{t('fleetLastHost', { host: r.lastHost })}</small>}
        </span>
      </td>
      <td>
        <span className="fp-holder">
          <span>{stateChip}</span>
          {note && <small className={r.kind === 'parked' && !r.running ? 'fp-warn' : undefined}>{note}</small>}
        </span>
      </td>
      <td>
        <span className="fp-holder">
          {nowCell}
          {actions}
        </span>
      </td>
      <td>
        {r.minutes !== null && r.budget !== null && r.budget > 0
          ? <BudgetRing minutes={r.minutes} budget={r.budget} unit={r.source === 'coordinator' && !r.account?.queue?.enrolled ? 'searches' : 'min'} />
          : <span className="fp-muted">—</span>}
      </td>
      <td>
        {r.epoch !== null ? (
          <span className="fp-holder">
            <span className="mono fp-muted">{t('fleetEpochN', { n: r.epoch })}</span>
            {r.leaseExpires && <small>{t('fleetRenews', { when: dueLabel(t, r.leaseExpires, now) })}</small>}
          </span>
        ) : <span className="fp-muted">—</span>}
      </td>
      <td className={`mono${hostVersion && r.version && r.version !== hostVersion && !r.version.startsWith(`${hostVersion} `) ? ' fp-muted' : ''}`}>
        {r.version ?? <span className="fp-muted">—</span>}
      </td>
      <td className="fleet-row-actions">
        {r.workerId && (
          <a className="btn ghost icon sm" href={hrefFor(fleetWorkerPath(r.workerId))} onClick={onLinkClick(fleetWorkerPath(r.workerId))}
            aria-label={t('fbcOpenWorkerOf', { id: r.workerId })} title={t('fbcOpenWorkerOf', { id: r.workerId })}>
            <Icon name="eye" size={14} />
          </a>
        )}
        {parking && slot && <ParkDialog slot={slot} onClose={() => setParking(false)} onDone={() => { setParking(false); onChanged(); }} />}
        {unparking && slot && <UnparkDialog slot={slot} onClose={() => setUnparking(false)} onDone={() => { setUnparking(false); onChanged(); }} />}
      </td>
    </tr>
  );
}

// Parking frees the account: its worker's next call is refused and the
// container exits, so a manager must mean it.
function ParkDialog({ slot, onClose, onDone }: { slot: FleetSlot; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fleetApi.parkSlot(slot.account_no);
      showSuccessToast(t('fleetParked', { no: slot.account_no }));
      onDone();
    } catch (e) {
      handleFetchError(e);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 460 }}>
      <ConfirmDialogBody title={t('fleetParkTitle', { no: slot.account_no })} confirm={t('fleetPark')} busy={busy} danger
        onClose={onClose} onConfirm={confirm}
        body={<>
          <p>{t('fleetParkBody', { worker: slot.worker_id ?? '—' })}</p>
          <p className="fp-warn">{t('fleetParkWarn')}</p>
        </>} />
    </Modal>
  );
}

// Unparking makes the account claimable again: the next worker that asks for
// a slot may take it, and that worker's start is a Facebook login.
function UnparkDialog({ slot, onClose, onDone }: { slot: FleetSlot; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fleetApi.unparkSlot(slot.account_no);
      showSuccessToast(t('fleetUnparked', { no: slot.account_no }));
      onDone();
    } catch (e) {
      handleFetchError(e);
      setBusy(false);
    }
  };
  return (
    <Modal onClose={() => { if (!busy) onClose(); }} shellStyle={{ maxWidth: 460 }}>
      <ConfirmDialogBody title={t('fleetUnparkTitle', { no: slot.account_no })} confirm={t('fleetUnpark')} busy={busy}
        onClose={onClose} onConfirm={confirm}
        body={<>
          <p>{t('fleetUnparkBody')}</p>
          <p className="fp-warn">{t('fleetUnparkWarn')}</p>
        </>} />
    </Modal>
  );
}
