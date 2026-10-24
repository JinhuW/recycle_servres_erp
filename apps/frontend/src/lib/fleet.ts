// Typed client for the ERP's own Facebook fleet (/api/fleet/*, manager-only):
// the city catalog, the task queue, the hosts that run worker containers and
// the account slots they claim. Unlike lib/coordinator.ts nothing here is
// proxied; the backend owns these tables.
//
// The row types are the shared fleet types; where a manager route folds in
// more than the row (a city's open tasks, a slot's worker and pool status,
// a host's desired state), the page-side type extends the shared one here.

import type {
  FleetCity as FleetCityRow, FleetHost as FleetHostRow, FleetItem, FleetSettings, FleetSlot as FleetSlotRow,
  FleetTask as FleetTaskRow, FleetTaskEvent, FleetTaskState, FleetWorker as FleetWorkerRow,
} from '@recycle-erp/shared';
import { api } from './api';

export type {
  FleetItem, FleetSettings, FleetTaskEvent, FleetTaskEventKind, FleetTaskKind, FleetTaskReason, FleetTaskResult,
  FleetTaskState, FleetHostContainer, FleetHostReport, DesiredAnswer,
} from '@recycle-erp/shared';
export { FLEET_TASK_STATES, FLEET_PARKED_STATES, fleetStateParked } from '@recycle-erp/shared';

// snake_case on purpose: rows come straight from the backend's SQL.

export type FleetTask = FleetTaskRow & {
  // The city's display name, joined in for the tables; null once a city row
  // is gone.
  city_name?: string | null;
};

// The open (ready or leased) task a city has for one item, as the cities
// route folds it in.
export type FleetCityOpenTask = Pick<FleetTask, 'id' | 'kind' | 'state' | 'due_at' | 'priority' | 'worker_id' | 'lease_expires_at'>;

export type FleetCity = FleetCityRow & {
  // Per item name: the one open task, or null when none is waiting.
  open: Record<string, FleetCityOpenTask | null>;
  // Per item name: when the last search finished; null = never.
  last_done_at: Record<string, string | null>;
};

export type FleetCityWrite = { slug: string; name: string; radius_km?: number; region?: string | null };
export type FleetCityPatch = {
  enabled?: boolean;
  per_day?: number | null;
  pinned?: boolean;
  name?: string;
  override_verify?: true;
};

export type FleetRoll = { replace: string } | null;

export type FleetHost = FleetHostRow & {
  // What the ERP tells the agent to run, folded in by the hosts route.
  desired: { count: number; image: string; version: string; roll: FleetRoll } | null;
};

// The token is in the answer to POST /api/fleet/hosts only, once.
export type FleetHostCreated = FleetHost & { token: string };

export type FleetRelease = { image: string; version: string };

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

// What starting the round did: per item, the tasks made due now and the
// city-items skipped because they were searched within `fresh_hours`.
export type FleetRoundStart = {
  fresh_hours: number;
  items: Record<string, { due: number; skipped: number }>;
};

export type FleetTaskQuery = {
  state?: FleetTaskState;
  city?: string;
  item?: string;
  worker?: string;
  since?: string;
};

export type FleetCityLogTask = FleetTask & { events: FleetTaskEvent[] };

const BASE = '/api/fleet';
const slug = (s: string) => encodeURIComponent(s);

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const fleetApi = {
  // ── Cities ──
  cities: () => api.get<{ cities: FleetCity[] }>(`${BASE}/cities`).then(r => r.cities),
  // The city starts disabled with a verify-slug task; 409 when the slug exists.
  addCity: (body: FleetCityWrite) => api.post<{ city: FleetCity }>(`${BASE}/cities`, body).then(r => r.city),
  updateCity: (slugId: string, patch: FleetCityPatch) =>
    api.put<{ city: FleetCity }>(`${BASE}/cities/${slug(slugId)}`, patch).then(r => r.city),
  // Disables the city and cancels its open tasks; the row stays for its history.
  removeCity: (slugId: string) => api.delete<{ ok: true }>(`${BASE}/cities/${slug(slugId)}`),

  // ── Items and settings ──
  items: () => api.get<{ items: FleetItem[] }>(`${BASE}/items`).then(r => r.items),
  saveItems: (items: FleetItem[]) =>
    api.put<{ items: FleetItem[] }>(`${BASE}/items`, { items }).then(r => r.items),
  settings: () => api.get<FleetSettings>(`${BASE}/settings`),
  saveSettings: (patch: Partial<FleetSettings>) =>
    api.put<FleetSettings>(`${BASE}/settings`, patch),

  // ── Tasks ──
  // A manual task: priority 100, so the next free worker takes it.
  searchNow: (city: string, item: string) => api.post<{ task: FleetTask }>(`${BASE}/tasks`, { city, item }).then(r => r.task),
  // Every ready task whose city-item was not done lately falls due now.
  startRound: () => api.post<FleetRoundStart>(`${BASE}/round/start`, {}),
  tasks: (q: FleetTaskQuery = {}) => api.get<{ tasks: FleetTask[] }>(`${BASE}/tasks${query(q)}`).then(r => r.tasks),
  // One city's, or one worker's, tasks with their events over the last `hours`.
  cityLog: (q: { city?: string; worker?: string; hours?: number }) =>
    api.get<{ tasks: FleetCityLogTask[] }>(`${BASE}/city-log${query({ city: q.city, worker: q.worker, hours: q.hours ?? 24 })}`)
      .then(r => r.tasks),

  // ── Hosts ──
  hosts: () => api.get<{ hosts: FleetHost[] }>(`${BASE}/hosts`).then(r => r.hosts),
  // The answer carries the host's bearer token; it is never shown again.
  addHost: (host_id: string) => api.post<{ host: FleetHostCreated }>(`${BASE}/hosts`, { host_id }).then(r => r.host),
  updateHost: (hostId: string, patch: { capacity?: number; authoritative?: boolean }) =>
    api.put<{ host: FleetHost }>(`${BASE}/hosts/${slug(hostId)}`, patch).then(r => r.host),
  removeHost: (hostId: string) => api.delete<{ ok: true }>(`${BASE}/hosts/${slug(hostId)}`),
  // Starts a roll: every host replaces one idle worker at a time onto `image`.
  release: (body: FleetRelease) => api.post<{ ok: true }>(`${BASE}/releases`, body),

  // ── Slots and workers ──
  slots: () => api.get<{ slots: FleetSlot[] }>(`${BASE}/slots`).then(r => r.slots),
  releaseQuarantine: (no: number) => api.post<{ slot: FleetSlot }>(`${BASE}/slots/${no}/release-quarantine`, {}).then(r => r.slot),
  // Parks the account: its worker exits on its next call and nothing claims it.
  parkSlot: (no: number) => api.post<{ slot: FleetSlot }>(`${BASE}/slots/${no}/park`, {}).then(r => r.slot),
  workers: () => api.get<{ workers: FleetWorker[] }>(`${BASE}/workers`).then(r => r.workers),
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
