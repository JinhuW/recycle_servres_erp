import { useCallback, useMemo, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { TableSkeleton } from '../../../components/Skeleton';
import { coordinatorApi, type Challenge, type FleetDoc } from '../../../lib/coordinator';
import { poolApi } from '../../../lib/facebookPool';
import { fleetApi, fleetSlotRetirable, fleetStateParked, type FleetHost, type FleetRelease, type FleetSlot, type FleetWorker } from '../../../lib/fleet';
import { queueCityName, withoutRetired } from '../../../lib/fleetView';
import { useT } from '../../../lib/i18n';
import { fleetWorkerPath, hrefFor, onLinkClick } from '../../../lib/route';
import { ActivityAside } from '../FleetWorkers';
import { dueLabel, easternClock, isQuarantined, maskUid } from './fleetBoard';
import {
  DEFAULT_FLEET_ROW_FILTER, FLEET_ROW_KINDS, filterFleetRows, fleetRowCounts, fleetRowHosts, fleetRows, fleetRunning,
  type FleetPoolAccount, type FleetRow, type FleetRowFilter, type FleetRowKind,
} from './fleetRows';
import { AddHostDialog, HostStrip, ReleaseBanner, ReleaseDialog } from './FleetHosts';
import {
  agoLabel, BudgetRing, COORDINATOR_POLL_MS, EmptyRow, Legend, MarkHealthyButton, ParkDialog, RetireSlotDialog, resumeWaiting, UnavailableCard, useFleetMirror, useFleetPoll,
  WorkerStateChip,
} from './shared';

// ─── Fleet ────────────────────────────────────────────────────────────────────
// The hosts as a strip of cards, then one table of every worker: the ERP
// fleet's, with the account and lease each holds, and the coordinator's until
// cutover (host "homelab"). The accounts nothing runs, and the actions that
// put them back, are on the Account pool tab. The legend, the host select and
// the search box narrow the table. The activity aside stays under the table
// while the coordinator's rows exist. The ERP's own data and the
// coordinator's are read apart: the table shows the ERP's rows at once and
// the coordinator's join them when its slower answer lands. A coordinator
// worker it retired is not a row.

type ErpData = {
  slots: FleetSlot[]; workers: FleetWorker[]; hosts: FleetHost[]; release: FleetRelease | null; pool: FleetPoolAccount[] | null;
};
type CoordinatorData = { coordinator: FleetDoc | null; challenges: Challenge[] | null };
type Data = ErpData & CoordinatorData;

const KIND_DOT: Record<FleetRowKind | 'all', string> = {
  all: 'fleet-dot-all', healthy: 'fleet-dot-pos', parked: 'fleet-dot-neg', removed: 'fleet-dot-muted',
};
const KIND_KEY: Record<FleetRowKind | 'all', string> = {
  all: 'fleetKindAll', healthy: 'fleetKindHealthy', parked: 'fleetKindParked', removed: 'fleetKindRemoved',
};

export function FleetAccountsTab() {
  const { t, locale } = useT();
  const mirror = useFleetMirror();
  const erp = useFleetPoll<ErpData>(() => Promise.all([
    fleetApi.slots(), fleetApi.workers(), fleetApi.hosts(),
    // The pool names the account a coordinator worker holds.
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
    return { ...erp.data, coordinator: c?.coordinator ?? null, challenges: c?.challenges ?? null };
  }, [erp.data, coord.data]);
  const { reload: reloadErp } = erp;
  const { reload: reloadCoordinator } = coord;
  const reload = useCallback(() => { reloadErp(); reloadCoordinator(); }, [reloadErp, reloadCoordinator]);
  const [adding, setAdding] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [filter, setFilter] = useState<FleetRowFilter>(DEFAULT_FLEET_ROW_FILTER);

  if (data === 'unavailable') return <UnavailableCard text={t('fleetNotServed')} />;
  const hosts = data?.hosts ?? [];
  const release = data?.release ?? null;
  const image = hosts.find(h => h.desired.image)?.desired.image || null;
  const active = withoutRetired(data?.coordinator ?? null);
  const coordinatorRows = (active?.workers.length ?? 0) > 0;

  return (
    <div className="fp-pool">
      <div className="fleet-tab-head">
        <p className="fleet-lede">{t('fleetLede')}</p>
        {!mirror && (
          <div className="page-actions">
            <button type="button" className="btn" onClick={() => setReleasing(true)} disabled={!data || hosts.length === 0}>{t('fleetReleaseAction')}</button>
            <button type="button" className="btn primary" onClick={() => setAdding(true)} disabled={!data}>{t('fleetHostAdd')}</button>
          </div>
        )}
      </div>
      {data === null ? <div className="card fleet-host"><TableSkeleton rows={1} cols={4} /></div>
        : <HostStrip hosts={hosts} release={release} onChanged={reload} />}
      {release && (release.state === 'rolling' || release.state === 'failed') && <ReleaseBanner release={release} />}
      <section className="card fleet-card" aria-label={t('fleetColWorker')}>
        {data === null ? <TableSkeleton rows={6} cols={9} />
          : <WorkersTable data={data} filter={filter} onFilter={setFilter} onChanged={reload} />}
      </section>
      {coordinatorRows && data && (
        <ActivityAside fleet={active} unavailable={false} challenges={data.challenges} locale={locale} />
      )}
      {adding && <AddHostDialog onClose={() => setAdding(false)} onChanged={reload} />}
      {releasing && <ReleaseDialog current={release?.image ?? image} onClose={() => setReleasing(false)} onDone={() => { setReleasing(false); reload(); }} />}
    </div>
  );
}

export function WorkersTable({ data, filter, onFilter, onChanged, now = Date.now() }: {
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
        </select>
        <label className="toolbar-search">
          <Icon name="search" size={14} />
          <input className="input" type="search" value={filter.q} autoComplete="off" placeholder={t('fleetSearchWorkers')}
            aria-label={t('fleetSearchWorkers')} onChange={e => set({ q: e.target.value })} />
        </label>
      </div>
      <div className="fp-table-wrap fleet-table-cap">
        <table className="fp-table fleet-table fleet-accounts">
          <thead>
            <tr>
              <th>{t('fleetColWorker')}</th>
              <th>{t('fleetColHost')}</th>
              <th>{t('fleetColAccount')}</th>
              <th>{t('fleetColState')}</th>
              <th>{t('fleetColNow')}</th>
              <th>{t('fleetColToday')}</th>
              <th>{t('fleetColLease')}</th>
              <th>{t('fleetColVersion')}</th>
              <th aria-label={t('fbcOpenWorker')} />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <EmptyRow cols={9}>{counts.all === 0 ? t('fleetWorkersNone') : t('fleetWorkersNoMatch')}</EmptyRow>}
            {shown.map(r => <WorkerRow key={r.key} row={r} hostVersion={r.host ? versions.get(r.host) ?? null : null}
              cityName={slug => queueCityName(data.coordinator, slug)} onChanged={onChanged} now={now} />)}
          </tbody>
        </table>
      </div>
      <div className="fp-table-foot fleet-foot">
        <span>{t('fleetWorkersFoot', { shown: shown.length, n: counts.all, running: running.running, hosts: running.hosts })}</span>
        <span>{t('fleetMinutesNote', { budget })}</span>
      </div>
    </>
  );
}

function WorkerRow({ row: r, hostVersion, cityName, onChanged, now }: {
  row: FleetRow; hostVersion: string | null; cityName: (slug: string) => string; onChanged: () => void; now: number;
}) {
  const { t, locale } = useT();
  const mirror = useFleetMirror();
  const [parking, setParking] = useState(false);
  const [retiring, setRetiring] = useState(false);
  // Park acts on the account this worker holds now, so it needs the slot to
  // still be this worker's.
  const slot = r.slot && r.slot.worker_id === r.workerId ? r.slot : null;
  const quarantined = !!slot && isQuarantined(slot, now);
  // The account's slot, held by this worker or parked with none; one another
  // worker has claimed since is not this row's to retire.
  const ownSlot = r.slot && (r.slot.worker_id === null || r.slot.worker_id === r.workerId) ? r.slot : null;
  // Only an account its worker reports lost, or a manager parked: a worker
  // that went silent shows as parked too, with a healthy account.
  const retirable = r.source === 'erp' && !!ownSlot && !mirror
    && fleetSlotRetirable({ parked: ownSlot.parked, poolStatus: ownSlot.pool_status, state: r.state, operator: r.operator });

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

  // A parked worker names why when its account is the reason. One that could
  // not load a page is not dead: its browser waits for Mark healthy.
  const stateChip = r.kind === 'healthy' ? <span className="chip pos">{t('fleetKindHealthy')}</span>
    : r.kind === 'removed' ? <span className="chip" title={t('fleetStateRemovedHint')}>{t('fleetStateRemoved')}</span>
    : r.resumable ? <span className="chip warn" title={r.parkError ?? undefined}>{t('fleetStateNoPage')}</span>
    : fleetStateParked(r.state) ? <WorkerStateChip state={r.state!} />
    : <span className="chip neg">{t('fleetKindParked')}</span>;

  const note = quarantined
    ? t('fleetQuarantineUntilAt', { time: easternClock(slot.quarantined_until, locale, now), span: dueLabel(t, slot.quarantined_until, now) })
    : r.running && r.resumable && resumeWaiting(r.resume, r.state) ? t('fleetNoteResumeSent')
    : r.running && r.state === 'DEGRADED' ? t('fleetNoteDegraded')
    : r.heartbeat ? t('fleetBeat', { ago: agoLabel(t, r.heartbeat, now) })
    : r.source === 'coordinator' ? t('fbcNeverReported')
    : null;

  return (
    <tr className={r.running ? undefined : 'fleet-row-idle'}>
      <td>
        <span className="fp-holder">
          <span className="mono">{r.workerId}</span>
          <small>{r.vncPort ? `vnc :${r.vncPort}` : '—'}</small>
        </span>
      </td>
      <td>
        {r.host ? <span className="mono fleet-hostcell">{r.host}</span> : <span className="fp-muted">—</span>}
      </td>
      <td>
        <span className="fp-holder">
          <span>{r.no === null ? <span className="fp-muted">—</span> : t('fleetAccountNo', { no: r.no })}</span>
          <small className="mono" title={t('fleetUidMasked')}>{maskUid(r.uid)}</small>
        </span>
      </td>
      <td>
        <span className="fp-holder">
          <span>{stateChip}</span>
          {note && <small className={quarantined || !r.running ? 'fp-warn' : undefined}>{note}</small>}
        </span>
      </td>
      <td>
        <span className="fp-holder">
          {nowCell}
          {((r.running && slot && !slot.parked && !mirror) || retirable) && (
            <span className="fleet-now-actions">
              {r.resumable && r.running && slot && !slot.parked && !mirror
                && <MarkHealthyButton workerId={r.workerId} version={r.version} resume={r.resume} state={r.state} onQueued={onChanged} />}
              {r.running && slot && !slot.parked && !mirror
                && <button type="button" className="btn sm ghost" onClick={() => setParking(true)}>{t('fleetPark')}</button>}
              {retirable && <button type="button" className="btn sm ghost fleet-danger-text" onClick={() => setRetiring(true)}>{t('fleetRetireFree')}</button>}
            </span>
          )}
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
        <a className="btn ghost icon sm" href={hrefFor(fleetWorkerPath(r.workerId))} onClick={onLinkClick(fleetWorkerPath(r.workerId))}
          aria-label={t('fbcOpenWorkerOf', { id: r.workerId })} title={t('fbcOpenWorkerOf', { id: r.workerId })}>
          <Icon name="eye" size={14} />
        </a>
        {parking && slot && <ParkDialog slot={slot} onClose={() => setParking(false)} onDone={() => { setParking(false); onChanged(); }} />}
        {retiring && ownSlot && <RetireSlotDialog accountNo={ownSlot.account_no} workerId={r.workerId} operator={r.operator}
          onClose={() => setRetiring(false)} onDone={() => { setRetiring(false); onChanged(); }} />}
      </td>
    </tr>
  );
}
