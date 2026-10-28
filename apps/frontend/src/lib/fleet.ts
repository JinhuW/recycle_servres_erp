// Typed client for the ERP's own Facebook fleet (/api/fleet/*, manager-only):
// the city catalog, the task queue, the hosts that run worker containers and
// the account slots they claim. Unlike lib/coordinator.ts nothing here is
// proxied; the backend owns these tables.
//
// The row types are the shared fleet types; where a manager route folds in
// more than the row (a slot's worker and pool status, a host's desired
// state), the page-side type extends the shared one here.

import type {
  FleetWorkerRelogin,
  FleetCityListed, FleetHost as FleetHostRow, FleetItem, FleetProxy, FleetProxyHealthAnswer, FleetProxyPatch, FleetProxyWrite, FleetRelease,
  FleetSettings, FleetSlot as FleetSlotRow, FleetSlotWrite,
  FleetFunnelDay, FleetTask as FleetTaskRow, FleetTaskLog, FleetTaskState, FleetWorker as FleetWorkerRow, FleetWorkerDetail, RoundStartAnswer,
} from '@recycle-erp/shared';
import { ApiError } from './api';
import { sharedApi as api } from './sharedGet';

export type {
  FleetFunnelDay, FleetItem, FleetRelease, FleetSettings, FleetTaskEvent, FleetTaskEventKind, FleetTaskKind, FleetTaskReason,
  FleetTaskResult, FleetTaskState, FleetHostContainer, FleetHostReport, DesiredAnswer, RoundStartAnswer,
  FleetProxy, FleetProxyCheck, FleetProxyHealth, FleetProxyHealthAnswer, FleetProxyHealthState, FleetProxySource,
  FleetProxyPatch, FleetProxyUse, FleetProxyWrite, FleetSlotWrite, FleetDeviceProfile,
  FleetSecretKind, FleetWorkerDetail, FleetWorkerEvent, FleetWorkerRelogin,
} from '@recycle-erp/shared';
export {
  FLEET_TASK_STATES, FLEET_PARKED_STATES, fleetStateParked, fleetDeviceFor, isFleetTimezone, parseProxyUrl, proxyLoad,
  FLEET_PROXY_BUCKET_MS, FLEET_PROXY_BUCKETS, FLEET_PROXY_SLOW_MS,
} from '@recycle-erp/shared';

// snake_case on purpose: rows come straight from the backend's SQL.

export type FleetTask = FleetTaskRow & {
  // The city's display name, joined in where a worker's task is shown; the
  // task list leaves it out.
  city_name?: string | null;
};

// A city with its open (ready or leased) tasks and the last finished search
// per item, as GET /cities lists it and every city write answers it.
export type FleetCity = FleetCityListed;

export type FleetCityWrite = { slug: string; name: string; radius_km?: number; region?: string | null };
export type FleetCityPatch = {
  enabled?: boolean;
  per_day?: number | null;
  name?: string;
  override_verify?: true;
};

export type FleetRoll = { replace: string } | null;

export type FleetHost = FleetHostRow & {
  // What the ERP tells the agent to run, folded in by the hosts route.
  desired: { count: number; image: string; version: string; roll: FleetRoll };
};

// The token is in the answer to POST /api/fleet/hosts only, once.
export type FleetHostCreated = FleetHost & { token: string };

// The hosts and the one roll the ERP keeps (the latest release, any state).
export type FleetHosts = { hosts: FleetHost[]; release: FleetRelease | null };

export type FleetReleaseWrite = { image: string; version: string };

export type FleetWorker = FleetWorkerRow & {
  // The task it holds now, if any.
  task: FleetTask | null;
};

// One account's slot, joined with its worker and its pool row. `uid` is the
// pool account's Facebook id; the table masks it.
export type FleetSlot = FleetSlotRow & {
  uid: string | null;
  pool_status: string;
  minutes_today: number;
  budget_minutes: number;
  worker: FleetWorker | null;
};

export type FleetTaskQuery = {
  state?: FleetTaskState;
  city?: string;
  item?: string;
  worker?: string;
  since?: string;
};

export type FleetCityLogTask = FleetTaskLog;

/** The fleet's error code on a refused call (`unverified`, `exists`, ...), if it carried one. */
export function fleetErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.body as { error?: unknown } | undefined;
  return typeof body?.error === 'string' ? body.error : null;
}

const BASE = '/api/fleet';
const slug = (s: string) => encodeURIComponent(s);

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const fleetApi = {
  // `mirror`: this ERP holds a read-only copy of prod's fleet and answers
  // every write with 409 read_only. `mirror_live`: its reads come from prod.
  health: () => api.get<{ ok: boolean; tables: unknown; mirror?: boolean; mirror_live?: boolean }>(`${BASE}/health`),

  // ── Cities ──
  cities: () => api.get<{ cities: FleetCity[] }>(`${BASE}/cities`).then(r => r.cities),
  // The city starts disabled with a verify-slug task; 409 exists when the slug is taken.
  addCity: (body: FleetCityWrite) => api.post<FleetCity>(`${BASE}/cities`, body),
  // 409 unverified for `enabled: true` on a slug no worker has checked;
  // `override_verify: true` is the manager's way past it.
  updateCity: (slugId: string, patch: FleetCityPatch) => api.put<FleetCity>(`${BASE}/cities/${slug(slugId)}`, patch),
  // Disables the city and cancels its waiting tasks; a search under way finishes.
  removeCity: (slugId: string) => api.delete<FleetCity>(`${BASE}/cities/${slug(slugId)}`),

  // ── Items and settings ──
  items: () => api.get<FleetItem[]>(`${BASE}/items`),
  // Upserts the items given; one leaves by `enabled: false`, never by omission.
  saveItems: (items: FleetItem[]) => api.put<FleetItem[]>(`${BASE}/items`, items),
  settings: () => api.get<FleetSettings>(`${BASE}/settings`),
  saveSettings: (patch: Partial<FleetSettings>) =>
    api.put<FleetSettings>(`${BASE}/settings`, patch),

  // ── Tasks ──
  // A manual task: priority 100, so the next free worker takes it. 409 exists
  // while a worker is already searching the pair.
  searchNow: (city: string, item: string) => api.post<FleetTask>(`${BASE}/tasks`, { city, item }),
  // Every waiting search falls due now unless its city-item finished lately.
  startRound: () => api.post<RoundStartAnswer>(`${BASE}/round/start`, {}),
  tasks: (q: FleetTaskQuery = {}) => api.get<FleetTask[]>(`${BASE}/tasks${query(q)}`),
  // Finished searches per UTC day over the last `days`, summed from their results.
  funnel: (days: number) => api.get<{ days: FleetFunnelDay[] }>(`${BASE}/stats/funnel${query({ days })}`).then(r => r.days),
  // One city's, or one worker's, tasks with their events over the last `hours`.
  cityLog: (q: { city?: string; worker?: string; hours?: number }) =>
    api.get<FleetCityLogTask[]>(`${BASE}/city-log${query({ city: q.city, worker: q.worker, hours: q.hours ?? 24 })}`),

  // ── Hosts ──
  hosts: () => api.get<FleetHosts>(`${BASE}/hosts`),
  // The answer carries the host's bearer token; it is never shown again.
  addHost: (host_id: string) => api.post<{ host: FleetHostCreated }>(`${BASE}/hosts`, { host_id }).then(r => r.host),
  updateHost: (hostId: string, patch: { capacity?: number; authoritative?: boolean }) =>
    api.put<{ host: FleetHost }>(`${BASE}/hosts/${slug(hostId)}`, patch).then(r => r.host),
  removeHost: (hostId: string) => api.delete<{ ok: true }>(`${BASE}/hosts/${slug(hostId)}`),
  // Starts a roll: one idle worker at a time, fleet-wide, onto `image`.
  release: (body: FleetReleaseWrite) =>
    api.post<{ ok: true; release: FleetRelease }>(`${BASE}/releases`, body).then(r => r.release),

  // ── Slots and workers ──
  slots: () => api.get<{ slots: FleetSlot[] }>(`${BASE}/slots`).then(r => r.slots),
  releaseQuarantine: (no: number) => api.post<{ slot: FleetSlot }>(`${BASE}/slots/${no}/release-quarantine`, {}).then(r => r.slot),
  // Parks the account: its worker exits on its next call and nothing claims it.
  parkSlot: (no: number) => api.post<{ slot: FleetSlot }>(`${BASE}/slots/${no}/park`, {}).then(r => r.slot),
  // Lets a parked account be claimed again.
  unparkSlot: (no: number) => api.post<{ slot: FleetSlot }>(`${BASE}/slots/${no}/unpark`, {}).then(r => r.slot),
  workers: () => api.get<{ workers: FleetWorker[] }>(`${BASE}/workers`).then(r => r.workers),
  // One worker with its slot, account, proxy, cities, stats, log and history; 404 for an id the fleet never saw.
  worker: (id: string) => api.get<FleetWorkerDetail>(`${BASE}/workers/${slug(id)}`),
  // Queues a forced Facebook login that the worker's next heartbeat hands it
  // once; 409 not_running for a worker holding no slot. A queued one that has
  // not gone out yet is answered again, not doubled.
  relogin: (id: string) => api.post<{ ok: true; relogin: FleetWorkerRelogin }>(`${BASE}/workers/${slug(id)}/relogin`, {}),
  // Puts a pool account into the fleet on a listed proxy. 409 account_busy,
  // no_login, proxy_full or exists; the body's `detail` says which account.
  addSlot: (body: FleetSlotWrite) => api.post<{ slot: FleetSlot }>(`${BASE}/slots`, body).then(r => r.slot),
  // Only a slot no worker holds (409 leased otherwise); the account goes back to Available.
  removeSlot: (no: number) => api.post<{ ok: true; pool_status: string }>(`${BASE}/slots/${no}/remove`, {}),

  // ── Proxies ── never the URL back, only host:port.
  proxies: () => api.get<FleetProxy[]>(`${BASE}/proxies`),
  addProxy: (body: FleetProxyWrite) => api.post<FleetProxy>(`${BASE}/proxies`, body),
  updateProxy: (id: number, patch: FleetProxyPatch) => api.put<FleetProxy>(`${BASE}/proxies/${id}`, patch),
  // 409 in_use while an account that is not parked uses it.
  removeProxy: (id: number) => api.delete<{ ok: true }>(`${BASE}/proxies/${id}`),
  // Each proxy's last check and its day. A check probes through the proxy, so it takes seconds.
  proxyHealth: () => api.get<FleetProxyHealthAnswer>(`${BASE}/proxies/health`),
  // One ERP proxy, or every proxy (homelab ports included) without one.
  checkProxies: (proxyId?: number) =>
    api.post<FleetProxyHealthAnswer>(`${BASE}/proxies/health/check`, proxyId === undefined ? {} : { proxy_id: proxyId }),
};

/**
 * The same-origin socket the backend relays to a fleet worker's VNC session,
 * which the worker dialled in to the ERP (no inbound port on its host). The
 * session cookie rides on the handshake; no token appears in the URL.
 */
export function fleetVncSocketUrl(workerId: string, loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${loc.host}/api/fleet/vnc/${encodeURIComponent(workerId)}/ws`;
}
