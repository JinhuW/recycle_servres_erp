// What an ERP-fleet worker's page reads off GET /api/fleet/workers/:id, in
// the homelab page's terms: its status bucket, its open checkpoint, its cities
// as chips, its 24-hour city log as the coordinator's city visits, and its
// history. Pure, so it can be unit-tested without React.

import type { FbWorkerStint } from '@recycle-erp/shared';
import type { CityStep, CityStepKind, CityVisit, CityVisitOutcome, FleetCity as ChipCity } from '../../../lib/coordinator';
import { fleetStateParked, type FleetCityLogTask as FleetTaskLog, type FleetWorkerDetail, type FleetWorkerEvent } from '../../../lib/fleet';
import type { CityHits, FleetStatus } from '../../../lib/fleetView';
import { liveness } from './fleetBoard';

/** Live, Stale, Needs attention or Offline, as the homelab page buckets a worker. */
export function erpWorkerStatus(w: FleetWorkerDetail['worker'], now: number = Date.now()): FleetStatus {
  const beat = liveness(w.last_heartbeat_at, now);
  if (beat === 'never' || beat === 'dead') return 'offline';
  if (fleetStateParked(w.state)) return 'attention';
  return beat === 'stale' ? 'stale' : 'live';
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** A worker parked on a wall or a lost session: the fleet's open checkpoint.
 *  The worker reports it on every heartbeat until the page is clear again. */
export type ErpCheckpoint = { kind: string; state: string; reason: string | null; url: string | null; seenAt: string | null };

export function erpCheckpoint(w: FleetWorkerDetail['worker'], now: number = Date.now()): ErpCheckpoint | null {
  if (!fleetStateParked(w.state) || erpWorkerStatus(w, now) === 'offline') return null;
  const d = w.detail ?? {};
  return {
    kind: str(d.wall) ?? w.state!,
    state: w.state!,
    reason: str(d.reason),
    url: str(d.url),
    seenAt: w.last_heartbeat_at,
  };
}

/** Days until the stored session's expiry, as the monitor last reported it. */
export function sessionDaysLeft(w: FleetWorkerDetail['worker'], now: number = Date.now()): number | null {
  const at = str(w.detail?.session_expiry);
  const ms = at ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? (ms - now) / 86_400_000 : null;
}

/** The cities as the homelab chips take them, home first, and the alerts each
 *  sent in the window. */
export function erpCityChips(d: FleetWorkerDetail, now: number = Date.now()): { home: ChipCity[]; other: ChipCity[]; hits: Map<string, CityHits>; searched: Set<string> } {
  const chip = (c: FleetWorkerDetail['cities'][number]): ChipCity => ({ slug: c.slug, name: c.name ?? c.slug, radius_km: c.radius_km });
  const hits = new Map<string, CityHits>();
  for (const c of d.cities) if (c.alerts > 0) hits.set(c.slug, { sent: c.alerts, hit: 0 });
  const today = new Date(now).toISOString().slice(0, 10);
  return {
    home: d.cities.filter(c => c.home).map(chip),
    other: d.cities.filter(c => !c.home).map(chip),
    hits,
    searched: new Set(d.cities.filter(c => c.last_done_at?.slice(0, 10) === today).map(c => c.slug)),
  };
}

/** The proxy as the page names it: its label, then host:port and its clock. */
export function erpProxyText(d: FleetWorkerDetail): { label: string; where: string } | 'unlisted' | null {
  if (d.proxy) return { label: d.proxy.label, where: `${d.proxy.host}:${d.proxy.port} · ${d.proxy.timezone}` };
  return d.slot?.has_proxy ? 'unlisted' : null;
}

/** The slot's device as a short line: screen, scale and the browser's clock. */
export function deviceText(device: NonNullable<FleetWorkerDetail['slot']>['device']): string | null {
  if (!device) return null;
  const screen = device.screen ?? device.viewport;
  const parts = [
    screen ? `${screen[0]}×${screen[1]}${device.device_scale_factor && device.device_scale_factor !== 1 ? ` @${device.device_scale_factor}` : ''}` : null,
    device.timezone ?? null,
    device.locale ?? null,
  ];
  return parts.filter(Boolean).join(' · ') || null;
}

// ─── The city log, as the coordinator's visits ──────────────────────────────

const STEP_KINDS: ReadonlySet<string> = new Set<CityStepKind>(['handed', 'started', 'searched', 'finished', 'stopped', 'released', 'expired']);
const COUNT_KEYS = ['cards', 'title_pass', 'opened', 'keyword_pass', 'fresh', 'reviewed', 'alerted'] as const;

const flat = (detail: Record<string, unknown> | null): CityStep['detail'] => {
  const out: CityStep['detail'] = {};
  for (const [k, v] of Object.entries(detail ?? {})) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
    else if (typeof v === 'boolean') out[k] = String(v);
  }
  return out;
};

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** One task of the worker's log as a coordinator city visit, so the same
 *  city-log table shows it. The counts are the worker's done report when it
 *  sent one, else summed from its searched events. */
export function taskVisit(task: FleetTaskLog, names: ReadonlyMap<string, string>): CityVisit {
  const stopped = [...task.events].reverse().find(e => e.kind === 'stopped');
  const released = task.events.some(e => e.kind === 'released');
  const handed = task.events.find(e => e.kind === 'handed');
  const outcome: CityVisitOutcome = task.state === 'leased' ? 'searching'
    : stopped || task.result?.stopped ? 'stopped'
    : task.state === 'done' ? 'finished'
    : task.state === 'expired' || task.state === 'cancelled' ? 'expired'
    : released ? 'released' : 'expired';
  const searched = task.events.filter(e => e.kind === 'searched');
  const sum = (k: string) => searched.reduce((n, e) => n + num(e.detail?.[k]), 0);
  const r = task.result;
  const totals = {
    searches: searched.length,
    ...Object.fromEntries(COUNT_KEYS.map(k => [k, r && typeof r[k] === 'number' ? (r[k] as number) : sum(k)])),
  } as CityVisit['totals'];
  const releasedEvent = task.events.find(e => e.kind === 'released');
  return {
    worker_id: task.worker_id ?? handed?.worker_id ?? '',
    item: task.item,
    city: task.city,
    name: names.get(task.city) ?? null,
    via: 'queue',
    why: str(handed?.detail?.why),
    outcome,
    reason: outcome === 'stopped' ? str(stopped?.detail?.reason) : outcome === 'released' ? str(releasedEvent?.detail?.reason) : null,
    wall: str(stopped?.detail?.wall),
    error: str(stopped?.detail?.error),
    reported: !!r,
    started_at: task.started_at ?? task.leased_at ?? task.due_at,
    ended_at: task.done_at,
    seconds: r && typeof r.seconds === 'number' ? r.seconds : null,
    totals,
    alerts: [],
    events: task.events.filter(e => STEP_KINDS.has(e.kind)).map(e => ({ at: e.at, event: e.kind as CityStepKind, detail: flat(e.detail) })),
  };
}

export function erpCityLog(d: FleetWorkerDetail): CityVisit[] {
  const names = new Map(d.cities.filter(c => c.name).map(c => [c.slug, c.name!]));
  for (const e of d.events) if (e.city_name) names.set(e.city, e.city_name);
  if (d.worker.task?.city_name) names.set(d.worker.task.city, d.worker.task.city_name);
  return d.log.map(t => taskVisit(t, names));
}

// ─── History ─────────────────────────────────────────────────────────────────

/** One line of the fleet worker's history, before it is put into words. */
export type ErpHistoryLine =
  | { kind: 'task'; at: number; event: FleetWorkerEvent }
  | { kind: 'signon'; at: number; stint: FbWorkerStint }
  | { kind: 'left'; at: number; stint: FbWorkerStint };

/** Its task events and its pool stints, newest first. */
export function erpHistory(events: readonly FleetWorkerEvent[], stints: readonly FbWorkerStint[]): ErpHistoryLine[] {
  const lines: ErpHistoryLine[] = events.map(e => ({ kind: 'task', at: Date.parse(e.at), event: e }));
  for (const s of stints) {
    lines.push({ kind: 'signon', at: s.startedAt, stint: s });
    if (s.endedAt !== null && s.outcome) lines.push({ kind: 'left', at: s.endedAt, stint: s });
  }
  return lines.sort((a, b) => b.at - a.at);
}

const LEFT_DOT: Record<string, string> = { problem: 'ff-attention', retired: 'ff-offline', removed: 'ff-offline' };

export function erpHistoryDot(line: ErpHistoryLine): string {
  if (line.kind === 'signon') return 'ff-tl-muted';
  if (line.kind === 'left') return LEFT_DOT[line.stint.outcome ?? ''] ?? 'ff-tl-muted';
  const e = line.event;
  if (e.kind === 'stopped' || (e.kind === 'done' && e.detail?.stopped === true)) return 'ff-attention';
  if (e.kind === 'expired') return 'ff-offline';
  if (e.kind === 'released') return fleetStateParked(str(e.detail?.reason)) ? 'ff-attention' : 'ff-tl-muted';
  return 'ff-live';
}
