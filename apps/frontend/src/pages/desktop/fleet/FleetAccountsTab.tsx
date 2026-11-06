import { useCallback, useMemo, useRef, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { nextSort, SortTh, type SortState } from '../../../components/SortTh';
import { Modal } from '../../../components/Modal';
import { TableSkeleton } from '../../../components/Skeleton';
import { coordinatorApi, type Challenge, type FleetDoc } from '../../../lib/coordinator';
import { poolApi } from '../../../lib/facebookPool';
import { handleFetchError, showSuccessToast, showWarnToast } from '../../../lib/errorToast';
import {
  fleetApi, fleetCloakFor, fleetEngineOf, fleetErrorCode, fleetStateParked,
  type FleetBrowserEngine, type FleetHost, type FleetRelease, type FleetSettings, type FleetSlot, type FleetWorker,
} from '../../../lib/fleet';
import { queueCityName, withoutRetired } from '../../../lib/fleetView';
import { useT } from '../../../lib/i18n';
import { usePersisted } from '../../../lib/listMemory';
import { fleetWorkerPath, hrefFor, onLinkClick } from '../../../lib/route';
import { ActivityAside } from '../FleetWorkers';
import { dueLabel, easternClock, isQuarantined, maskUid } from './fleetBoard';
import {
  DEFAULT_FLEET_ROW_FILTER, EMPTY_FLEET_ROW_FILTER, FLEET_ROW_SORT_COLS, filterFleetRows, fleetRowCounts, fleetRowHosts, fleetRows, fleetRunning,
  fleetCloakRoom, releasableRows, rowCloakSwitchable, rowOwnSlot, rowStockRevertible, rowRetirable, sortFleetRows,
  type FleetCloakRoom, type FleetPoolAccount, type FleetRow, type FleetRowFilter, type FleetRowSortCol,
} from './fleetRows';
import { AccountBriefCell } from './accountBrief';
import { AddHostDialog, FleetRack, ReleaseDialog } from './FleetHosts';
import {
  agoLabel, BudgetRing, ConfirmDialogBody, COORDINATOR_POLL_MS, EmptyRow, EngineChip, MarkHealthyButton, RestartWorkerButton, ParkDialog, ReleaseParkedDialog, RetireSlotDialog, resumeWaiting, UnavailableCard, useFleetMirror, useFleetPoll,
  WorkerStateChip,
} from './shared';

// ─── Fleet ────────────────────────────────────────────────────────────────────
// The fleet's status as a rack (FleetHosts.tsx), then one table of every worker: the ERP
// fleet's, with the account and lease each holds, and the coordinator's until
// cutover (host "homelab"). The accounts nothing runs, and the actions that
// put them back, are on the Account pool tab. The rack's legend and bays, the
// host select and the search box narrow the table. The activity aside stays under the table
// while the coordinator's rows exist. The ERP's own data and the
// coordinator's are read apart: the table shows the ERP's rows at once and
// the coordinator's join them when its slower answer lands. A coordinator
// worker it retired is not a row.

type ErpData = {
  slots: FleetSlot[]; workers: FleetWorker[]; hosts: FleetHost[]; release: FleetRelease | null; pool: FleetPoolAccount[] | null;
  /** For the engine card and the CloakBrowser guard; without it no row offers the switch. */
  settings?: FleetSettings | null;
};
type CoordinatorData = { coordinator: FleetDoc | null; challenges: Challenge[] | null };
type Data = ErpData & CoordinatorData;

export function FleetAccountsTab() {
  const { t, locale } = useT();
  const mirror = useFleetMirror();
  const erp = useFleetPoll<ErpData>(() => Promise.all([
    fleetApi.slots(), fleetApi.workers(), fleetApi.hosts(),
    // The pool names the account a coordinator worker holds.
    poolApi.summary().then(s => s.accounts).catch(() => null),
    fleetApi.settings().catch(() => null),
  ]).then(([slots, workers, hosts, pool, settings]) => ({ slots, workers, hosts: hosts.hosts, release: hosts.release, pool, settings })));
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
  const table = useRef<HTMLElement>(null);
  const rows = useMemo(() => data && data !== 'unavailable' ? fleetRows(data) : [], [data]);
  const showWorker = useCallback((workerId: string) => {
    setFilter({ ...EMPTY_FLEET_ROW_FILTER, q: workerId });
    table.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  if (data === 'unavailable') return <UnavailableCard text={t('fleetNotServed')} />;
  const hosts = data?.hosts ?? [];
  const release = data?.release ?? null;
  const image = hosts.find(h => h.desired.image)?.desired.image || null;
  const active = withoutRetired(data?.coordinator ?? null);
  const coordinatorRows = (active?.workers.length ?? 0) > 0;

  return (
    <div className="fp-pool">
      {data === null ? <div className="card fleet-rack"><TableSkeleton rows={3} cols={4} /></div> : (
        <FleetRack rows={rows} workers={data.workers} hosts={hosts} release={release} settings={data.settings}
          cloakUsed={data.slots.filter(s => fleetEngineOf(s.device) === 'cloak').length}
          filter={filter.kind} onFilter={kind => setFilter(f => ({ ...f, kind }))} onShowWorker={showWorker} onChanged={reload}
          settled={coord.data !== null}
          actions={!mirror && <>
            <button type="button" className="btn" onClick={() => setReleasing(true)} disabled={hosts.length === 0}>{t('fleetReleaseAction')}</button>
            <button type="button" className="btn primary" onClick={() => setAdding(true)}>{t('fleetHostAdd')}</button>
          </>} />
      )}
      <section ref={table} className="card fleet-card" aria-label={t('fleetColWorker')}>
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
  const mirror = useFleetMirror();
  const [releasing, setReleasing] = useState(false);
  const rows = useMemo(() => fleetRows(data, now), [data, now]);
  const releasable = useMemo(() => releasableRows(rows), [rows]);
  // Click cycles desc → asc → the table's own order (running first, by worker id).
  const [sort, setSort] = usePersisted<SortState>('desktop.fleet.workers.sort', { col: '', dir: null });
  const cycleSort = (col: string) => setSort(s => nextSort(s, col));
  const shown = useMemo(() => {
    const filtered = filterFleetRows(rows, filter);
    return sort.dir && (FLEET_ROW_SORT_COLS as readonly string[]).includes(sort.col)
      ? sortFleetRows(filtered, sort.col as FleetRowSortCol, sort.dir) : filtered;
  }, [rows, filter, sort]);
  const counts = useMemo(() => fleetRowCounts(rows), [rows]);
  const hostIds = useMemo(() => fleetRowHosts(rows, data.hosts.map(h => h.host_id)), [rows, data.hosts]);
  const running = fleetRunning(rows);
  const versions = new Map(data.hosts.map(h => [h.host_id, h.desired.version]));
  const budget = data.slots[0]?.budget_minutes ?? 360;
  const room = useMemo(() => fleetCloakRoom(data.settings, data.slots), [data.settings, data.slots]);
  const set = (patch: Partial<FleetRowFilter>) => onFilter({ ...filter, ...patch });
  return (
    <>
      <div className="fp-toolbar fleet-toolbar">
        <select className="input fleet-select" value={filter.host} aria-label={t('fleetColHost')} onChange={e => set({ host: e.target.value })}>
          <option value="">{t('fleetEveryHost')}</option>
          {hostIds.map(h => <option key={h} value={h}>{h}</option>)}
        </select>
        <label className="toolbar-search">
          <Icon name="search" size={14} />
          <input className="input" type="search" value={filter.q} autoComplete="off" placeholder={t('fleetSearchWorkers')}
            aria-label={t('fleetSearchWorkers')} onChange={e => set({ q: e.target.value })} />
        </label>
        {!mirror && releasable.release.length > 0 && (
          <button type="button" className="btn fleet-danger-text" onClick={() => setReleasing(true)}>
            {t('fleetReleaseParked', { n: releasable.release.length })}
          </button>
        )}
      </div>
      {releasing && <ReleaseParkedDialog rows={releasable.release} skipped={releasable.skipped}
        onClose={() => setReleasing(false)} onDone={() => { setReleasing(false); onChanged(); }} />}
      <div className="fp-table-wrap fleet-table-cap">
        <table className="fp-table fleet-table fleet-accounts">
          <thead>
            <tr>
              <SortTh col="worker" sort={sort} onSort={cycleSort}>{t('fleetColWorker')}</SortTh>
              <SortTh col="host" sort={sort} onSort={cycleSort}>{t('fleetColHost')}</SortTh>
              <SortTh col="account" sort={sort} onSort={cycleSort}>{t('fleetColAccount')}</SortTh>
              <SortTh col="state" sort={sort} onSort={cycleSort}>{t('fleetColState')}</SortTh>
              <th>{t('fleetColEngine')}</th>
              <SortTh col="now" sort={sort} onSort={cycleSort}>{t('fleetColNow')}</SortTh>
              <SortTh col="today" sort={sort} onSort={cycleSort}>{t('fleetColToday')}</SortTh>
              <SortTh col="lease" sort={sort} onSort={cycleSort}>{t('fleetColLease')}</SortTh>
              <SortTh col="version" sort={sort} onSort={cycleSort}>{t('fleetColVersion')}</SortTh>
              <th aria-label={t('fbcOpenWorker')} />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && <EmptyRow cols={10}>{counts.all === 0 ? t('fleetWorkersNone') : t('fleetWorkersNoMatch')}</EmptyRow>}
            {shown.map(r => <WorkerRow key={r.key} row={r} hostVersion={r.host ? versions.get(r.host) ?? null : null}
              cityName={slug => queueCityName(data.coordinator, slug)} room={room} onChanged={onChanged} now={now} />)}
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

function WorkerRow({ row: r, hostVersion, cityName, room, onChanged, now }: {
  row: FleetRow; hostVersion: string | null; cityName: (slug: string) => string; room: FleetCloakRoom; onChanged: () => void; now: number;
}) {
  const { t, locale } = useT();
  const mirror = useFleetMirror();
  const [parking, setParking] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [cloaking, setCloaking] = useState<FleetBrowserEngine | null>(null);
  // Park acts on the account this worker holds now, so it needs the slot to
  // still be this worker's.
  const slot = r.slot && r.slot.worker_id === r.workerId ? r.slot : null;
  const quarantined = !!slot && isQuarantined(slot, now);
  const ownSlot = rowOwnSlot(r);
  const retirable = !mirror && rowRetirable(r);
  const cloakable = !mirror && rowCloakSwitchable(r, room);
  const engineSlot = r.source === 'erp' ? ownSlot ?? slot : null;
  const stockable = !mirror && rowStockRevertible(r);

  const since = r.now?.since ? Math.max(0, Math.round((now - Date.parse(r.now.since)) / 1000)) : null;
  const elapsed = since === null ? '' : `${Math.floor(since / 60)}m ${String(since % 60).padStart(2, '0')}s`;
  const nowCell = r.kind === 'free'
    ? <em className="fleet-hold">{t(r.running ? 'fleetNowStopping' : 'fleetNowNoAccount')}</em>
    : r.replacingTo
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
    : r.kind === 'free' ? <span className="chip" title={t('fleetStateFreeHint')}>{t('fleetStateFree')}</span>
    : r.resumable ? <span className="chip warn" title={r.parkError ?? undefined}>{t('fleetStateNoPage')}</span>
    : r.infraPark ? <span className="chip warn" title={t(`fleetParkHint_${r.infraPark}`)}>{t(`fleetPark_${r.infraPark}`)}</span>
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
        {r.kind === 'free'
          ? <span className="fp-holder"><span className="fp-muted">—</span>{r.no !== null && <small>{t('fleetAccountWas', { no: r.no })}</small>}</span>
          : r.no === null
          ? <span className="fp-holder"><span className="fp-muted">—</span><small className="mono">{maskUid(r.uid)}</small></span>
          : (
            <AccountBriefCell no={r.no} uid={r.uid} pool={r.pool}>
              <span className="fp-holder">
                <span>{t('fleetAccountNo', { no: r.no })}</span>
                <small className="mono">{maskUid(r.uid)}</small>
              </span>
            </AccountBriefCell>
          )}
      </td>
      <td>
        <span className="fp-holder">
          <span>{stateChip}</span>
          {note && <small className={quarantined || !r.running ? 'fp-warn' : undefined}>{note}</small>}
        </span>
      </td>
      <td>
        {engineSlot ? (
          <span className="fp-holder">
            <EngineChip slot={engineSlot} />
            {cloakable && (
              <button type="button" className="btn sm ghost" onClick={() => setCloaking('cloak')}>{t('fleetCloakSwitch')}</button>
            )}
            {stockable && (
              <button type="button" className="btn sm ghost" onClick={() => setCloaking('stock')}>{t('fleetStockSwitch')}</button>
            )}
          </span>
        ) : <span className="fp-muted">—</span>}
      </td>
      <td>
        <span className="fp-holder">
          {nowCell}
          {((r.running && slot && !slot.parked && !mirror) || retirable) && (
            <span className="fleet-now-actions">
              {r.resumable && r.running && slot && !slot.parked && !mirror
                && <MarkHealthyButton workerId={r.workerId} version={r.version} resume={r.resume} state={r.state} onQueued={onChanged} />}
              {r.restartable && r.running && slot && !slot.parked && !mirror
                && <RestartWorkerButton workerId={r.workerId} resume={r.resume} state={r.state} onQueued={onChanged} />}
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
        {cloaking && ownSlot && <EngineSwitchDialog accountNo={ownSlot.account_no} engine={cloaking}
          onClose={() => setCloaking(null)} onDone={() => { setCloaking(null); onChanged(); }} />}
        {retiring && ownSlot && <RetireSlotDialog accountNo={ownSlot.account_no} workerId={r.workerId} operator={r.operator}
          onClose={() => setRetiring(false)} onDone={() => { setRetiring(false); onChanged(); }} />}
      </td>
    </tr>
  );
}

const CLOAK_REFUSALS: Record<string, string> = {
  engine_live_session: 'fleetCloakRefused_engine_live_session',
  cloak_disabled: 'fleetCloakRefused_cloak_disabled',
  cloak_slots_full: 'fleetCloakRefused_cloak_slots_full',
  cloak_seeded: 'fleetCloakRefused_cloak_seeded',
  cloak_proven: 'fleetCloakRefused_cloak_proven',
  pilot_arm: 'fleetCloakRefused_pilot_arm',
  cloak_seed_taken: 'fleetCloakRefused_cloak_seed_taken',
};

// One way: the fingerprint becomes the account's machine, which Facebook
// first sees at the worker's next ordinary start, never through a restart
// made for it. Back to stock is one more new machine, so only for an account
// its cloak session never got healthy on.
export function EngineSwitchDialog({ accountNo: no, engine, onClose, onDone }: {
  accountNo: number; engine: FleetBrowserEngine; onClose: () => void; onDone: () => void;
}) {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const cloak = fleetCloakFor(no);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fleetApi.setSlotEngine(no, engine);
      showSuccessToast(t(engine === 'cloak' ? 'fleetCloakDone' : 'fleetStockDone', { no }));
      onDone();
    } catch (e) {
      const why = CLOAK_REFUSALS[fleetErrorCode(e) ?? ''];
      if (why) showWarnToast(t(why, { no }));
      else handleFetchError(e);
      setBusy(false);
    }
  };
  const close = () => { if (!busy) onClose(); };
  return (
    <Modal onClose={close} shellStyle={{ maxWidth: 460 }}>
      {engine === 'cloak' ? (
        <ConfirmDialogBody title={t('fleetCloakTitle', { no })} confirm={t('fleetCloakSwitch')} busy={busy} onClose={close} onConfirm={confirm}
          body={<>
            <p>{t('fleetCloakBody', { seed: cloak.cloak_seed, gpu: cloak.cloak_gpu })}</p>
            <p className="fp-warn">{t('fleetCloakWarn')}</p>
            <p className="fp-warn">{t('fleetEngineNoRelogin')}</p>
          </>} />
      ) : (
        <ConfirmDialogBody title={t('fleetStockTitle', { no })} confirm={t('fleetStockSwitch')} busy={busy} danger onClose={close} onConfirm={confirm}
          body={<>
            <p>{t('fleetStockBody')}</p>
            <p className="fp-warn">{t('fleetStockWarn')}</p>
            <p className="fp-warn">{t('fleetEngineNoRelogin')}</p>
          </>} />
      )}
    </Modal>
  );
}
