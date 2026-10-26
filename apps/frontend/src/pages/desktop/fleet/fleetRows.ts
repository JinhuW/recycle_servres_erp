// The Fleet tab's one table of every account, built from three sources that
// know different accounts: the ERP's slots and workers (the fleet the ERP
// runs), the coordinator's workers (the homelab fleet, until cutover) and
// the pool itself (accounts nothing runs). An account the ERP runs is an ERP
// row even when the coordinator still lists its worker. Pure, so it can be
// unit-tested without React.

import type { Challenge, FleetAccount, FleetDoc } from '../../../lib/coordinator';
import type { PoolAccountSummary } from '../../../lib/facebookPool';

/** What a row reads of its pool account: a snapshot row or a summary row. */
export type FleetPoolAccount = Pick<PoolAccountSummary, 'no' | 'uid' | 'status' | 'holder' | 'note'>;
import { fleetStateParked, type FleetRelease, type FleetSlot, type FleetTask, type FleetWorker } from '../../../lib/fleet';
import { parkedWorkers } from '../../../lib/fleetView';
import { isQuarantined, leaseLive, liveness } from './fleetBoard';

export type FleetRowKind = 'healthy' | 'degraded' | 'replacing' | 'quarantined' | 'parked' | 'taken';
export const FLEET_ROW_KINDS: readonly FleetRowKind[] = ['healthy', 'degraded', 'replacing', 'quarantined', 'parked', 'taken'];

// The host every coordinator worker runs on; its fleet has one machine.
export const COORDINATOR_HOST = 'homelab';

/** What the worker is doing now, as far as its source says. */
export type FleetRowNow = { city: string; cityName: string | null; item: string; since: string | null; home: boolean };

export type FleetRow = {
  key: string;
  no: number | null;
  uid: string | null;
  kind: FleetRowKind;
  /** A container holds the account right now: it has a host and a worker. */
  running: boolean;
  source: 'erp' | 'coordinator' | 'pool';
  host: string | null;
  lastHost: string | null;
  workerId: string | null;
  vncPort: number | null;
  /** The worker's reported state (HEALTHY, DEGRADED, SESSION_EXPIRED, …), or null without one. */
  state: string | null;
  heartbeat: string | null;
  now: FleetRowNow | null;
  minutes: number | null;
  budget: number | null;
  epoch: number | null;
  leaseExpires: string | null;
  version: string | null;
  /** The release version a replaced worker comes back on. */
  replacingTo: string | null;
  slot: FleetSlot | null;
  task: FleetTask | null;
  pool: FleetPoolAccount | null;
  /** The coordinator's row, for the rows it alone knows. */
  account: FleetAccount | null;
};

export type FleetRowsInput = {
  slots: readonly FleetSlot[];
  workers: readonly FleetWorker[];
  release: FleetRelease | null;
  coordinator: FleetDoc | null;
  challenges: readonly Challenge[] | null;
  pool: readonly FleetPoolAccount[] | null;
  /** The coordinator has not answered yet (as opposed to answered nothing). */
  coordinatorPending?: boolean;
};

const vncPortOf = (url: string | null | undefined): number | null => {
  const m = url?.match(/:(\d{2,5})(?:\/|$)/);
  return m ? Number(m[1]) : null;
};

function erpRow(slot: FleetSlot, worker: FleetWorker | null, release: FleetRelease | null, pool: FleetPoolAccount | null, now: number): FleetRow {
  const beat = worker ? liveness(worker.last_heartbeat_at, now) : 'never';
  const running = !!worker && leaseLive(slot, now) && beat !== 'dead' && beat !== 'never';
  const replacing = running && release?.state === 'rolling' && release.current?.worker_id === worker?.worker_id;
  const quarantined = isQuarantined(slot, now);
  const kind: FleetRowKind = replacing ? 'replacing'
    : running && fleetStateParked(worker?.state) ? 'parked'
    : quarantined ? 'quarantined'
    : running ? (worker?.state === 'DEGRADED' ? 'degraded' : 'healthy')
    : slot.pool_status === 'taken' ? 'taken'
    : 'parked';
  const task = running ? worker?.task ?? null : null;
  return {
    key: `erp:${slot.account_no}`,
    no: slot.account_no,
    uid: slot.uid ?? pool?.uid ?? null,
    kind,
    running,
    source: 'erp',
    host: running ? slot.host_id ?? worker?.host_id ?? null : null,
    lastHost: slot.last_host_id ?? slot.host_id,
    workerId: running ? worker?.worker_id ?? slot.worker_id : null,
    vncPort: running ? worker?.vnc_port ?? null : null,
    state: running || fleetStateParked(worker?.state) ? worker?.state ?? null : null,
    heartbeat: worker?.last_heartbeat_at ?? null,
    now: task ? { city: task.city, cityName: task.city_name ?? null, item: task.item, since: task.leased_at, home: slot.home_cities.includes(task.city) } : null,
    minutes: slot.minutes_today,
    budget: slot.budget_minutes,
    epoch: slot.epoch,
    leaseExpires: running ? slot.lease_expires_at : null,
    version: running ? worker?.version ?? null : null,
    replacingTo: replacing ? release?.version ?? null : null,
    slot,
    task,
    pool,
    account: null,
  };
}

function coordinatorRow(w: FleetAccount, parked: ReadonlySet<string>, pool: FleetPoolAccount | null): FleetRow {
  const h = w.health;
  const live = !!h && (h.liveness === 'live' || h.liveness === 'stale');
  const state = h?.state ?? null;
  const kind: FleetRowKind = !live || parked.has(w.worker_id) || fleetStateParked(state) ? 'parked'
    : state === 'DEGRADED' ? 'degraded' : 'healthy';
  const open = w.queue?.open?.[0] ?? null;
  const minutes = w.queue?.enrolled ? w.queue.minutes_today : w.today?.searches ?? null;
  const budget = w.queue?.enrolled ? w.queue.budget_minutes : w.plan?.per_day ?? null;
  return {
    key: `coord:${w.worker_id}`,
    no: pool?.no ?? null,
    uid: pool?.uid ?? w.session?.fb_user_id ?? null,
    kind,
    running: live,
    source: 'coordinator',
    host: live ? COORDINATOR_HOST : null,
    lastHost: COORDINATOR_HOST,
    workerId: w.worker_id,
    vncPort: vncPortOf(w.vnc_url),
    state,
    heartbeat: h?.last_heartbeat_at ?? null,
    now: open ? { city: open.city, cityName: null, item: open.item, since: open.leased_at, home: w.cities.some(c => c.slug === open.city) } : null,
    minutes,
    budget,
    epoch: null,
    leaseExpires: null,
    version: h?.version ?? null,
    replacingTo: null,
    slot: null,
    task: null,
    pool,
    account: w,
  };
}

function poolRow(a: FleetPoolAccount): FleetRow {
  return {
    key: `pool:${a.no}`, no: a.no, uid: a.uid, kind: a.status === 'taken' ? 'taken' : 'parked', running: false, source: 'pool',
    host: null, lastHost: null, workerId: null, vncPort: null, state: null, heartbeat: null, now: null, minutes: null, budget: null,
    epoch: null, leaseExpires: null, version: null, replacingTo: null, slot: null, task: null, pool: a, account: null,
  };
}

const naturally = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Every account as one row: running ones first by worker id, then the idle
 *  ones by account number. */
export function fleetRows(input: FleetRowsInput, now: number = Date.now()): FleetRow[] {
  const pool = input.pool ?? [];
  const poolByNo = new Map(pool.map(a => [a.no, a]));
  const workersById = new Map(input.workers.map(w => [w.worker_id, w]));
  const rows: FleetRow[] = [];
  const seenNo = new Set<number>();
  const seenWorker = new Set<string>();
  for (const slot of input.slots) {
    const worker = slot.worker ?? (slot.worker_id ? workersById.get(slot.worker_id) ?? null : null);
    rows.push(erpRow(slot, worker, input.release, poolByNo.get(slot.account_no) ?? null, now));
    seenNo.add(slot.account_no);
    if (worker) seenWorker.add(worker.worker_id);
  }
  const parked = parkedWorkers(input.challenges ?? null);
  for (const w of input.coordinator?.workers ?? []) {
    if (seenWorker.has(w.worker_id)) continue;
    const held = pool.find(a => a.status === 'fleet' && a.holder?.toLowerCase() === w.worker_id.toLowerCase())
      ?? pool.find(a => !!w.session?.fb_user_id && a.uid === w.session.fb_user_id) ?? null;
    if (held && (seenNo.has(held.no) || held.status !== 'fleet')) continue;
    rows.push(coordinatorRow(w, parked, held));
    if (held) seenNo.add(held.no);
  }
  // A fleet account no ERP slot holds is most likely a coordinator worker's:
  // shown as an idle pool row now, it would jump to the running rows when the
  // coordinator answers. It waits for that answer instead.
  for (const a of pool) {
    if (seenNo.has(a.no) || (input.coordinatorPending && a.status === 'fleet')) continue;
    rows.push(poolRow(a));
  }
  return rows.sort((x, y) => Number(y.running) - Number(x.running)
    || (x.running && y.running ? naturally(x.workerId ?? '', y.workerId ?? '') : (x.no ?? Infinity) - (y.no ?? Infinity))
    || naturally(x.key, y.key));
}

export type FleetRowFilter = { kind: FleetRowKind | 'all'; host: string; q: string };
export const EMPTY_FLEET_ROW_FILTER: FleetRowFilter = { kind: 'all', host: '', q: '' };
/** The host select's value for the rows nothing runs. */
export const NOT_RUNNING = '-';

export function filterFleetRows(rows: readonly FleetRow[], f: FleetRowFilter): FleetRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter(r => (f.kind === 'all' || r.kind === f.kind)
    && (!f.host || (f.host === NOT_RUNNING ? !r.running : r.host === f.host))
    && (!q || [r.workerId, r.host, r.no === null ? '' : `account ${r.no}`, r.no === null ? '' : `no. ${r.no}`, r.uid, r.now?.cityName, r.now?.city]
      .filter(Boolean).join(' ').toLowerCase().includes(q)));
}

export function fleetRowCounts(rows: readonly FleetRow[]): Record<FleetRowKind | 'all', number> {
  const out = { all: rows.length, healthy: 0, degraded: 0, replacing: 0, quarantined: 0, parked: 0, taken: 0 };
  for (const r of rows) out[r.kind] += 1;
  return out;
}

/** The hosts the select offers: the registered ones, plus the coordinator's
 *  machine while its workers are rows. */
export function fleetRowHosts(rows: readonly FleetRow[], registered: readonly string[]): string[] {
  const hosts = new Set(registered);
  for (const r of rows) if (r.host) hosts.add(r.host);
  return [...hosts].sort(naturally);
}

/** "M running on K hosts" for the card's foot. */
export function fleetRunning(rows: readonly FleetRow[]): { running: number; hosts: number } {
  const hosts = new Set<string>();
  let running = 0;
  for (const r of rows) {
    if (r.kind !== 'healthy' && r.kind !== 'degraded' && r.kind !== 'replacing') continue;
    running += 1;
    if (r.host) hosts.add(r.host);
  }
  return { running, hosts: hosts.size };
}
