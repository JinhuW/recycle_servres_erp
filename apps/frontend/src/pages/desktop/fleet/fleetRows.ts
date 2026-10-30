// The Fleet tab's table: one row per worker, from two sources that know
// different workers: the ERP's (with the slot, the account and the lease each
// holds) and the coordinator's (the homelab fleet, until cutover). A worker
// the ERP knows is an ERP row even when the coordinator still lists it. The
// accounts nothing runs are the Account pool's, not rows here. Pure, so it
// can be unit-tested without React.

import type { Challenge, FleetAccount, FleetDoc } from '../../../lib/coordinator';
import type { PoolAccountSummary } from '../../../lib/facebookPool';

/** What a row reads of its pool account: a snapshot row or a summary row. */
export type FleetPoolAccount = Pick<PoolAccountSummary, 'no' | 'uid' | 'status' | 'holder' | 'note'>;
import { fleetResumable, fleetSlotRetirable, fleetStateParked, type FleetRelease, type FleetSlot, type FleetTask, type FleetWorker, type FleetWorkerResume } from '../../../lib/fleet';
import { parkedWorkers, retiredAt } from '../../../lib/fleetView';
import { leaseLive, liveness } from './fleetBoard';

// A worker doing the work (degraded or mid-replacement included), one that
// stopped once its account left the fleet (retired or removed) and waits for
// another, or one that is not working because its account needs a hand or it
// went silent. Hosts never remove a worker, so there is no fourth. The State
// column keeps the detail.
export type FleetRowKind = 'healthy' | 'free' | 'parked';
export const FLEET_ROW_KINDS: readonly FleetRowKind[] = ['healthy', 'free', 'parked'];

// Worker rows are never deleted, so one silent this long has been retired,
// not lost.
const OFFLINE_KEPT_MS = 7 * 24 * 60 * 60_000;

// The host every coordinator worker runs on; its fleet has one machine.
export const COORDINATOR_HOST = 'homelab';

/** What the worker is doing now, as far as its source says. */
export type FleetRowNow = { city: string; cityName: string | null; item: string; since: string | null; home: boolean };

export type FleetRow = {
  key: string;
  no: number | null;
  uid: string | null;
  kind: FleetRowKind;
  /** The worker is reporting and, for an ERP worker, holds its lease. */
  running: boolean;
  source: 'erp' | 'coordinator';
  /** Where it runs, or ran last. */
  host: string | null;
  workerId: string;
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
  /** Parked until a person acts (DEAD connect_failed): a fenced one is left stopped, not replaced. */
  operator: boolean;
  /** Parked DEAD on a page that would not load: a manager may mark it healthy. */
  resumable: boolean;
  /** The worker's own words for why it parked, when it says. */
  parkError: string | null;
  /** The latest Mark healthy queued for it. */
  resume: FleetWorkerResume | null;
  slot: FleetSlot | null;
  task: FleetTask | null;
  pool: FleetPoolAccount | null;
  /** The coordinator's row, for the workers it alone knows. */
  account: FleetAccount | null;
};

export type FleetRowsInput = {
  slots: readonly FleetSlot[];
  workers: readonly FleetWorker[];
  release: FleetRelease | null;
  coordinator: FleetDoc | null;
  challenges: readonly Challenge[] | null;
  pool: readonly FleetPoolAccount[] | null;
};

const vncPortOf = (url: string | null | undefined): number | null => {
  const m = url?.match(/:(\d{2,5})(?:\/|$)/);
  return m ? Number(m[1]) : null;
};

function erpRow(worker: FleetWorker, slot: FleetSlot | null, release: FleetRelease | null, pool: FleetPoolAccount | null, now: number): FleetRow {
  const beat = liveness(worker.last_heartbeat_at, now);
  // A worker between leases still reports; only its silence takes it offline.
  const running = beat === 'live' || beat === 'stale';
  // The account's slot may since be another worker's.
  const holds = !!slot && slot.worker_id === worker.worker_id;
  const replacing = running && release?.state === 'rolling' && release.current?.worker_id === worker.worker_id;
  // A manager's park holds the slot whatever state the worker still reports.
  // Without a slot the account is out of the fleet: the host starts the
  // worker again only for an account added since, whatever it did with it.
  const kind: FleetRowKind = running && !fleetStateParked(worker.state) && !(holds && slot.parked) ? 'healthy'
    : !running && !slot ? 'free' : 'parked';
  const task = running ? worker.task ?? null : null;
  const no = slot?.account_no ?? worker.account_no ?? null;
  return {
    key: `erp:${worker.worker_id}`,
    no,
    uid: slot?.uid ?? pool?.uid ?? null,
    kind,
    running,
    source: 'erp',
    host: worker.host_id ?? slot?.host_id ?? slot?.last_host_id ?? null,
    workerId: worker.worker_id,
    vncPort: running ? worker.vnc_port ?? null : null,
    state: worker.state ?? null,
    heartbeat: worker.last_heartbeat_at ?? null,
    now: task ? { city: task.city, cityName: task.city_name ?? null, item: task.item, since: task.leased_at, home: false } : null,
    // A slot another worker holds now counts that worker's minutes, not these.
    minutes: slot && (holds || !slot.worker_id) ? slot.minutes_today : null,
    budget: slot && (holds || !slot.worker_id) ? slot.budget_minutes : null,
    epoch: holds ? slot.epoch : null,
    leaseExpires: running && holds && leaseLive(slot, now) ? slot.lease_expires_at : null,
    version: worker.version ?? null,
    replacingTo: replacing ? release?.version ?? null : null,
    operator: worker.detail?.operator === true,
    resumable: fleetResumable(worker.state, worker.detail),
    parkError: typeof worker.detail?.error === 'string' ? worker.detail.error : null,
    resume: worker.resume ?? null,
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
  const kind: FleetRowKind = live && !parked.has(w.worker_id) && !fleetStateParked(state) ? 'healthy' : 'parked';
  const open = live ? w.queue?.open?.[0] ?? null : null;
  const minutes = w.queue?.enrolled ? w.queue.minutes_today : w.today?.searches ?? null;
  const budget = w.queue?.enrolled ? w.queue.budget_minutes : w.plan?.per_day ?? null;
  return {
    key: `coord:${w.worker_id}`,
    no: pool?.no ?? null,
    uid: pool?.uid ?? w.session?.fb_user_id ?? null,
    kind,
    running: live,
    source: 'coordinator',
    host: COORDINATOR_HOST,
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
    operator: false,
    resumable: false,
    parkError: null,
    resume: null,
    slot: null,
    task: null,
    pool,
    account: w,
  };
}

const naturally = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Every worker as one row: running ones first, then the silent ones, each
 *  by worker id. */
export function fleetRows(input: FleetRowsInput, now: number = Date.now()): FleetRow[] {
  const pool = input.pool ?? [];
  const poolByNo = new Map(pool.map(a => [a.no, a]));
  // A slot carries its worker; the worker list also has the ones no slot
  // holds any more, whose account the worker row still names.
  const workers = new Map(input.workers.map(w => [w.worker_id, w]));
  for (const s of input.slots) if (s.worker) workers.set(s.worker.worker_id, s.worker);
  const slotOf = (w: FleetWorker) => input.slots.find(s => s.worker_id === w.worker_id)
    ?? input.slots.find(s => s.account_no === w.account_no) ?? null;
  const rows: FleetRow[] = [];
  const seenNo = new Set<number>();
  for (const w of workers.values()) {
    const row = erpRow(w, slotOf(w), input.release, null, now);
    if (!row.running && !(row.heartbeat && now - Date.parse(row.heartbeat) < OFFLINE_KEPT_MS)) continue;
    row.pool = row.no === null ? null : poolByNo.get(row.no) ?? null;
    row.uid ??= row.pool?.uid ?? null;
    rows.push(row);
    if (row.running && row.no !== null) seenNo.add(row.no);
  }
  const parked = parkedWorkers(input.challenges ?? null);
  // A worker the coordinator retired was stopped on purpose: not a row.
  for (const w of input.coordinator?.workers ?? []) {
    if (workers.has(w.worker_id) || retiredAt(w)) continue;
    const held = pool.find(a => a.status === 'fleet' && a.holder?.toLowerCase() === w.worker_id.toLowerCase())
      ?? pool.find(a => !!w.session?.fb_user_id && a.uid === w.session.fb_user_id) ?? null;
    if (held && (seenNo.has(held.no) || held.status !== 'fleet')) continue;
    rows.push(coordinatorRow(w, parked, held));
  }
  return rows.sort((x, y) => Number(y.running) - Number(x.running) || naturally(x.workerId, y.workerId));
}

export type FleetRowSortCol = 'worker' | 'host' | 'account' | 'state' | 'now' | 'today' | 'lease' | 'version';
export const FLEET_ROW_SORT_COLS: readonly FleetRowSortCol[] = ['worker', 'host', 'account', 'state', 'now', 'today', 'lease', 'version'];

const KIND_ORDER: Record<FleetRowKind, number> = { healthy: 0, free: 1, parked: 2 };

function sortValue(col: FleetRowSortCol, r: FleetRow): string | number | null {
  switch (col) {
    case 'worker': return r.workerId;
    case 'host': return r.host;
    case 'account': return r.no;
    case 'state': return `${KIND_ORDER[r.kind]} ${r.state ?? ''}`;
    case 'now': return r.now ? r.now.cityName ?? r.now.city : null;
    case 'today': return r.minutes;
    case 'lease': return r.leaseExpires ? Date.parse(r.leaseExpires) : null;
    case 'version': return r.version;
  }
}

/** Rows by one column; a row with nothing in it goes last either way, and
 *  ties keep the table's own order. */
export function sortFleetRows(rows: readonly FleetRow[], col: FleetRowSortCol, dir: 'asc' | 'desc'): FleetRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  return rows.map((r, i) => ({ r, i, v: sortValue(col, r) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1;
      const d = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : naturally(String(a.v), String(b.v));
      return d * sign || a.i - b.i;
    })
    .map(x => x.r);
}

export type FleetRowFilter = { kind: FleetRowKind | 'all'; host: string; q: string };
export const EMPTY_FLEET_ROW_FILTER: FleetRowFilter = { kind: 'all', host: '', q: '' };
// The tab opens on the workers doing the work; All workers is one click away.
export const DEFAULT_FLEET_ROW_FILTER: FleetRowFilter = { ...EMPTY_FLEET_ROW_FILTER, kind: 'healthy' };
export function filterFleetRows(rows: readonly FleetRow[], f: FleetRowFilter): FleetRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter(r => (f.kind === 'all' || r.kind === f.kind)
    && (!f.host || r.host === f.host)
    && (!q || [r.workerId, r.host, r.no === null ? '' : `account ${r.no}`, r.no === null ? '' : `no. ${r.no}`, r.uid, r.now?.cityName, r.now?.city]
      .filter(Boolean).join(' ').toLowerCase().includes(q)));
}

export function fleetRowCounts(rows: readonly FleetRow[]): Record<FleetRowKind | 'all', number> {
  const out = { all: rows.length, healthy: 0, free: 0, parked: 0 };
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
    if (r.kind !== 'healthy') continue;
    running += 1;
    if (r.host) hosts.add(r.host);
  }
  return { running, hosts: hosts.size };
}

/** The slot a row's Retire & free acts on: the account's, held by this worker
 *  or parked with none; one another worker has claimed since is not its. */
export function rowOwnSlot(r: FleetRow): FleetSlot | null {
  return r.slot && (r.slot.worker_id === null || r.slot.worker_id === r.workerId) ? r.slot : null;
}

/** Only an account its worker reports lost, or a manager parked: a worker
 *  that went silent shows as parked too, with a healthy account. */
export function rowRetirable(r: FleetRow): boolean {
  const own = rowOwnSlot(r);
  return r.source === 'erp' && !!own
    && fleetSlotRetirable({ parked: own.parked, poolStatus: own.pool_status, state: r.state, operator: r.operator });
}

/** What Release parked retires, one per account, and how many parked rows it
 *  leaves alone (silent with a good account, the coordinator's, an operator's). */
export function releasableRows(rows: readonly FleetRow[]): { release: FleetRow[]; skipped: number } {
  const release: FleetRow[] = [];
  const accounts = new Set<number>();
  let skipped = 0;
  for (const r of rows) {
    if (r.kind !== 'parked') continue;
    const own = rowOwnSlot(r);
    if (!rowRetirable(r) || !own) { skipped += 1; continue; }
    if (accounts.has(own.account_no)) continue;
    accounts.add(own.account_no);
    release.push(r);
  }
  return { release, skipped };
}
