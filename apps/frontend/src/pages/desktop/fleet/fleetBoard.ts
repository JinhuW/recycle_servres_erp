// Pure helpers behind the fleet tabs: the task belt's buckets and sentence,
// due times, the round-start preview, the analysis tab's sums and series, the
// budget ring's tone and the masks the tables show. Kept out of the
// components so they can be unit-tested without React.

import type { AlertHitRow } from '../../../lib/coordinator';
import {
  fleetStateParked, type FleetCity, type FleetCityLogTask as FleetTaskLog, type FleetFunnelDay, type FleetHost, type FleetRelease, type FleetSlot, type FleetTask,
  type FleetWorker,
} from '../../../lib/fleet';
import { FLOW_STAGES, type FlowStage } from '../../../lib/fleetView';

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

// The clocks the fleet pages show: the office's. Workers keep UTC, and a time
// in the browser's own zone would read differently on every manager's laptop.
export const FLEET_TZ = 'America/New_York';

export function easternClock(at: string | null | undefined, locale: string, now: number = Date.now()): string {
  if (!at) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => x.toLocaleDateString(locale, { timeZone: FLEET_TZ });
  const sameDay = day(d) === day(new Date(now));
  return d.toLocaleString(locale, sameDay
    ? { timeZone: FLEET_TZ, hour: '2-digit', minute: '2-digit' }
    : { timeZone: FLEET_TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function easternDateTime(at: string | null | undefined, locale: string): string {
  if (!at) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(locale, { timeZone: FLEET_TZ, dateStyle: 'medium', timeStyle: 'short' });
}

/** Midnight in UTC on the day `now` falls in: the fleet's "today", which is
 *  how the budget view and the scheduler count it. */
export function utcDayStart(now: number = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

// ── Due times ────────────────────────────────────────────────────────────────

export type Due =
  | { kind: 'now' }
  | { kind: 'overdue'; minutes: number }
  | { kind: 'in'; minutes: number };

export function dueIn(dueAt: string, now: number = Date.now()): Due {
  const diff = Math.round((Date.parse(dueAt) - now) / 60_000);
  if (Math.abs(diff) < 1) return { kind: 'now' };
  return diff < 0 ? { kind: 'overdue', minutes: -diff } : { kind: 'in', minutes: diff };
}

/** "2 h 05 min" style spans for the tables: minutes under an hour, else hours
 *  and minutes, else days and hours. */
export function spanLabel(t: Translate, minutes: number): string {
  if (minutes < 60) return t('fleetSpanMin', { n: minutes });
  if (minutes < 24 * 60) return t('fleetSpanHours', { h: Math.floor(minutes / 60), m: minutes % 60 });
  return t('fleetSpanDays', { d: Math.floor(minutes / 1440), h: Math.floor((minutes % 1440) / 60) });
}

export function dueLabel(t: Translate, dueAt: string | null | undefined, now: number = Date.now()): string {
  if (!dueAt) return '—';
  const d = dueIn(dueAt, now);
  if (d.kind === 'now') return t('fleetDueNow');
  if (d.kind === 'overdue') return t('fleetDueOverdue', { span: spanLabel(t, d.minutes) });
  return t('fleetDueIn', { span: spanLabel(t, d.minutes) });
}

// ── The belt ─────────────────────────────────────────────────────────────────
// Every open task on a 24-hour window centred on now, in quarter-hour
// buckets: finished searches to the left, the overdue stack at now, leased
// tasks just right of it, waiting ones at their due time. Searches only: a
// slug check or a quarantine probe is not a city-item.

export const BELT_WINDOW_H = 12;
export const BELT_BUCKET_MIN = 15;
// A city-item takes four to seven browser minutes; what the sentence assumes
// until today's finished tasks say otherwise.
export const DEFAULT_TASK_SECONDS = 360;

const HOUR = 3_600_000;
const BUCKET_MS = BELT_BUCKET_MIN * 60_000;

export type BeltMarkKind = 'done' | 'leased' | 'later' | 'soon';
export type BeltMark = { key: string; kind: BeltMarkKind; left: number; tasks: FleetTask[] };
export type BeltCounts = { done: number; leased: number; due: number; later: number };
export type BeltRow = { item: string; marks: BeltMark[]; due: FleetTask[]; counts: BeltCounts };

/** Where an instant sits on the belt, as a percentage of its width. */
export const beltLeft = (at: string | number, now: number): number =>
  (((typeof at === 'string' ? Date.parse(at) : at) - now) / HOUR + BELT_WINDOW_H) / (2 * BELT_WINDOW_H) * 100;

/** The city's open search for one item, if any, as the city list carries it. */
export function openSearch(city: FleetCity, item: string): FleetTask | null {
  return city.open_tasks.find(t => t.item === item && t.kind === 'search') ?? null;
}

export function beltRow(tasks: readonly FleetTask[], item: string, now: number = Date.now()): BeltRow {
  const buckets = new Map<string, BeltMark>();
  const add = (key: string, kind: BeltMarkKind, left: number, task: FleetTask) => {
    const b = buckets.get(key);
    if (b) b.tasks.push(task);
    else buckets.set(key, { key, kind, left, tasks: [task] });
  };
  const counts: BeltCounts = { done: 0, leased: 0, due: 0, later: 0 };
  const due: FleetTask[] = [];
  const window = BELT_WINDOW_H * HOUR;
  for (const t of tasks) {
    if (t.item !== item || t.kind !== 'search') continue;
    if (t.state === 'done') {
      if (!t.done_at) continue;
      const offset = Date.parse(t.done_at) - now;
      if (offset < -window || offset > 0) continue;
      counts.done += 1;
      const n = Math.floor(offset / BUCKET_MS);
      add(`d${n}`, 'done', 50 + (n * BELT_BUCKET_MIN / 60) / (2 * BELT_WINDOW_H) * 100 - 0.4, t);
    } else if (t.state === 'leased') {
      counts.leased += 1;
      add('L', 'leased', 50.5, t);
    } else if (t.state === 'ready') {
      const offset = Date.parse(t.due_at) - now;
      if (offset <= 0) { counts.due += 1; due.push(t); continue; }
      if (offset > window) continue;
      counts.later += 1;
      const n = Math.floor(offset / BUCKET_MS);
      add(`f${n}`, offset < HOUR ? 'soon' : 'later', 50 + (n * BELT_BUCKET_MIN / 60) / (2 * BELT_WINDOW_H) * 100 + 0.6, t);
    }
  }
  due.sort((a, b) => b.priority - a.priority || a.due_at.localeCompare(b.due_at));
  const marks = [...buckets.values()].sort((a, b) => a.left - b.left);
  return { item, marks, due, counts };
}

/** The hour ticks under the belt: every third Eastern hour, clear of the
 *  edges and of the now label. */
export function beltAxis(now: number, locale: string): { left: number; label: string }[] {
  const first = new Date(now);
  first.setUTCMinutes(0, 0, 0);
  const out: { left: number; label: string }[] = [];
  for (let h = -BELT_WINDOW_H; h <= BELT_WINDOW_H; h += 1) {
    const d = new Date(first.getTime() + h * HOUR);
    const left = beltLeft(d.getTime(), now);
    if (left < 1 || left > 99 || Math.abs(left - 50) < 5) continue;
    const hour = Number(d.toLocaleTimeString('en-US', { timeZone: FLEET_TZ, hour: 'numeric', hour12: false }));
    if (hour % 3 !== 0) continue;
    out.push({ left, label: d.toLocaleTimeString(locale, { timeZone: FLEET_TZ, hour: 'numeric' }) });
  }
  return out;
}

/** How long a city-item takes: the mean of today's finished searches, or the
 *  default when none has finished yet. */
export function averageTaskSeconds(tasks: readonly FleetTask[], now: number = Date.now()): number {
  const today = utcDayStart(now);
  const seconds: number[] = [];
  for (const t of tasks) {
    const s = t.result?.seconds;
    if (t.kind === 'search' && t.state === 'done' && (t.done_at ?? '') >= today && typeof s === 'number' && s > 0) seconds.push(s);
  }
  if (seconds.length === 0) return DEFAULT_TASK_SECONDS;
  return Math.round(seconds.reduce((a, b) => a + b, 0) / seconds.length);
}

/** Workers that can take a task now (a live heartbeat, not parked), split by
 *  whether they hold one. */
export function workersBusy(workers: readonly FleetWorker[], now: number = Date.now()): { busy: number; idle: number } {
  let busy = 0;
  let idle = 0;
  for (const w of workers) {
    const lv = liveness(w.last_heartbeat_at, now);
    if (lv === 'dead' || lv === 'never' || fleetStateParked(w.state)) continue;
    if (w.task) busy += 1; else idle += 1;
  }
  return { busy, idle };
}

export type BeltSummary = BeltCounts & { busy: number; idle: number; clearMinutes: number; avgSeconds: number };

/** The numbers the sentence above the belt reads out: workers busy and idle,
 *  city-items due and how long the backlog takes at the measured pace, done
 *  in the last window and due in the next. */
export function beltSummary(rows: readonly BeltRow[], workers: { busy: number; idle: number }, avgSeconds: number): BeltSummary {
  const counts: BeltCounts = { done: 0, leased: 0, due: 0, later: 0 };
  for (const r of rows) for (const k of Object.keys(counts) as (keyof BeltCounts)[]) counts[k] += r.counts[k];
  const hands = Math.max(1, workers.busy + workers.idle);
  return { ...counts, ...workers, avgSeconds, clearMinutes: Math.round(counts.due * avgSeconds / 60 / hands) };
}

// ── The city log aside ───────────────────────────────────────────────────────

/** Per item: the open task first, then the last two finished ones. */
export function logByItem(tasks: readonly FleetTaskLog[], items: readonly string[]): { item: string; tasks: FleetTaskLog[] }[] {
  return items.map(item => {
    const of = tasks.filter(t => t.item === item);
    const open = of.filter(t => t.state === 'ready' || t.state === 'leased').sort((a, b) => a.due_at.localeCompare(b.due_at));
    const past = of.filter(t => t.state !== 'ready' && t.state !== 'leased')
      .sort((a, b) => (b.done_at ?? b.due_at).localeCompare(a.done_at ?? a.due_at)).slice(0, 2);
    return { item, tasks: [...open, ...past] };
  });
}


// ── Starting the round ───────────────────────────────────────────────────────

export type RoundPreviewItem = { due: number; skipped: number; ready: number };

/** What `round/start` would do, worked out from the cities by the backend's
 *  rule: every search waiting for later falls due now unless its city-item
 *  finished within `freshHours`. One already due is left as it is. */
export function roundStartPreview(
  cities: readonly FleetCity[], items: readonly string[], freshHours: number, now: number = Date.now(),
): Record<string, RoundPreviewItem> {
  const fresh = now - freshHours * 3_600_000;
  const out: Record<string, RoundPreviewItem> = {};
  for (const item of items) {
    const row: RoundPreviewItem = { due: 0, skipped: 0, ready: 0 };
    for (const city of cities) {
      const open = openSearch(city, item);
      if (!open || open.state !== 'ready' || Date.parse(open.due_at) <= now) continue;
      row.ready += 1;
      const last = city.last_done_at[item];
      if (last && Date.parse(last) >= fresh) row.skipped += 1;
      else row.due += 1;
    }
    out[item] = row;
  }
  return out;
}

// ── Cities ───────────────────────────────────────────────────────────────────

export type CityStanding = 'verifying' | 'enabled' | 'disabled' | 'removed';

export function cityStanding(c: FleetCity): CityStanding {
  if (c.disabled_at && !c.enabled) return 'removed';
  if (c.enabled) return 'enabled';
  return c.verified_at ? 'disabled' : 'verifying';
}

// The Cities tab's legend: a removed city sits with the disabled.
export type CityBucket = 'verifying' | 'enabled' | 'disabled';
export const CITY_BUCKETS: readonly CityBucket[] = ['enabled', 'verifying', 'disabled'];
const CITY_RANK: Record<CityBucket, number> = { verifying: 0, enabled: 1, disabled: 2 };

export function cityBucket(c: FleetCity): CityBucket {
  const standing = cityStanding(c);
  return standing === 'removed' ? 'disabled' : standing;
}

export type CityFilter = { bucket: CityBucket | 'all'; region: string; q: string };
export const EMPTY_CITY_FILTER: CityFilter = { bucket: 'all', region: '', q: '' };

/** Verifying cities first, then enabled and disabled, each by name;
 *  narrowed by the legend, the region and the search box. */
export function filterCities(cities: readonly FleetCity[], f: CityFilter): FleetCity[] {
  const q = f.q.trim().toLowerCase();
  return cities
    .filter(c => (f.bucket === 'all' || cityBucket(c) === f.bucket)
      && (!f.region || (c.region ?? '') === f.region)
      && (!q || `${c.name} ${c.slug}`.toLowerCase().includes(q)))
    .sort((a, b) => CITY_RANK[cityBucket(a)] - CITY_RANK[cityBucket(b)] || a.name.localeCompare(b.name));
}

/** The regions the catalog uses, for the select. */
export function cityRegions(cities: readonly FleetCity[]): string[] {
  return [...new Set(cities.map(c => c.region).filter((r): r is string => !!r))].sort();
}

/** The newest finished search of one city-item among the tasks given. */
export function lastDoneSearch(tasks: readonly FleetTask[], slug: string, item: string): FleetTask | null {
  let best: FleetTask | null = null;
  for (const t of tasks) {
    if (t.city !== slug || t.item !== item || t.kind !== 'search' || t.state !== 'done' || !t.done_at) continue;
    if (!best || (best.done_at ?? '') < t.done_at) best = t;
  }
  return best;
}

/** The soonest open task's due time across items, and its holder if leased. */
export function nextDue(c: FleetCity): { at: string | null; holder: string | null } {
  let at: string | null = null;
  let holder: string | null = null;
  for (const open of c.open_tasks) {
    if (open.state === 'leased' && open.worker_id) holder = open.worker_id;
    if (at === null || open.due_at < at) at = open.due_at;
  }
  return { at, holder };
}

export const normalizeSlug = (raw: string): string => raw.trim().toLowerCase();
export const isSlug = (slug: string): boolean => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug);
export const marketplaceUrl = (slug: string): string => `https://www.facebook.com/marketplace/${encodeURIComponent(slug)}/`;

// ── Hosts ────────────────────────────────────────────────────────────────────

/** Containers the agent reported running, against the count the ERP wants. */
export function hostRunning(h: FleetHost): { running: number; desired: number } {
  const running = (h.report?.containers ?? []).filter(c => c.state === 'running').length;
  return { running, desired: h.desired.count };
}

/** A roll's progress on one host: workers already on the target image, of
 *  the containers it runs; null unless the hosts answer carries a rolling
 *  release. A worker left on an older image without one is hostLag's. */
export function rollProgress(h: FleetHost, release: FleetRelease | null): { onTarget: number; total: number; replacing: string | null } | null {
  if (release?.state !== 'rolling') return null;
  const target = h.desired.image;
  const containers = h.report?.containers ?? [];
  if (!target || containers.length === 0) return null;
  const onTarget = containers.filter(c => c.image === target).length;
  if (onTarget === containers.length && !h.desired.roll) return null;
  return { onTarget, total: containers.length, replacing: h.desired.roll?.replace ?? null };
}

/** An image's tag, its version: "…/aimm-recycle:0.14.6" → "0.14.6". A
 *  digest-pinned or untagged image has none and reads as the image itself. */
export function imageVersion(image: string): string {
  if (image.includes('@')) return image;
  return /:([^:/]+)$/.exec(image)?.[1] ?? image;
}

/** Workers on a host still running an older image than the one new workers
 *  start on, outside any roll; null when every container is on it. */
export function hostLag(h: FleetHost): { behind: number; versions: string[]; target: string } | null {
  const target = h.desired.image;
  if (!target) return null;
  const old = (h.report?.containers ?? []).filter(c => c.image !== target);
  if (old.length === 0) return null;
  const versions = [...new Set(old.map(c => imageVersion(c.image)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { behind: old.length, versions, target: h.desired.version || imageVersion(target) };
}

/** The latest release's progress, for the Hosts tab's banner; null when none was ever started. */
export function releaseSummary(r: FleetRelease | null): { upgraded: number; skipped: number; replacing: string | null } | null {
  if (!r) return null;
  return { upgraded: r.upgraded.length, skipped: r.skipped.length, replacing: r.current?.worker_id ?? null };
}

export type Liveness = 'live' | 'stale' | 'dead' | 'never';

// Agents report once a minute and workers heartbeat every few minutes, so a
// few minutes is one missed turn and a quarter hour means gone.
export function liveness(lastSeen: string | null | undefined, now: number = Date.now()): Liveness {
  if (!lastSeen) return 'never';
  const age = now - Date.parse(lastSeen);
  if (age < 5 * 60_000) return 'live';
  if (age < 15 * 60_000) return 'stale';
  return 'dead';
}

// ── Slots ────────────────────────────────────────────────────────────────────

/** A Facebook uid with its middle hidden: enough to tell accounts apart in
 *  the table without printing the id. */
export function maskUid(uid: string | null | undefined): string {
  if (!uid) return '—';
  if (uid.length <= 6) return uid[0] + '…' + uid[uid.length - 1];
  return `${uid.slice(0, 3)}…${uid.slice(-3)}`;
}

export type BudgetTone = 'idle' | 'part' | 'full';

export function budgetTone(minutes: number, budget: number): BudgetTone {
  if (minutes <= 0) return 'idle';
  return budget > 0 && minutes >= budget ? 'full' : 'part';
}

export function isQuarantined(s: Pick<FleetSlot, 'quarantined_until'>, now: number = Date.now()): boolean {
  return Boolean(s.quarantined_until && Date.parse(s.quarantined_until) > now);
}

export function leaseLive(s: Pick<FleetSlot, 'lease_expires_at'>, now: number = Date.now()): boolean {
  return Boolean(s.lease_expires_at && Date.parse(s.lease_expires_at) > now);
}

/** Where a slot's lease stands. A parked slot answers no lease at all, so it
 *  is told apart by its flag rather than read as free. */
export type SlotLease = 'parked' | 'held' | 'lapsed' | 'free';

export function slotLease(s: Pick<FleetSlot, 'lease_expires_at' | 'parked'>, now: number = Date.now()): SlotLease {
  if (s.parked) return 'parked';
  if (!s.lease_expires_at) return 'free';
  return leaseLive(s, now) ? 'held' : 'lapsed';
}

// ── Task table filters ───────────────────────────────────────────────────────

/** The task list answers city slugs only; the table shows the city's name. */
export function withCityNames(tasks: readonly FleetTask[], cities: readonly FleetCity[]): FleetTask[] {
  const names = new Map(cities.map(c => [c.slug, c.name]));
  return tasks.map(t => ({ ...t, city_name: t.city_name ?? names.get(t.city) ?? null }));
}

// `q` matches the city (slug or name), the worker and the account number.
export type TaskFilter = { state: string; item: string; q: string };
export const EMPTY_TASK_FILTER: TaskFilter = { state: '', item: '', q: '' };

export function filterTasks(tasks: readonly FleetTask[], f: TaskFilter, now: number = Date.now()): FleetTask[] {
  const q = f.q.trim().toLowerCase();
  return tasks.filter(task =>
    (!f.state || (task.state === f.state && (f.state !== 'ready' || Date.parse(task.due_at) <= now)))
    && (!f.item || task.item === f.item)
    && (!q || [task.city, task.city_name ?? '', task.worker_id ?? '', task.account_no === null ? '' : `account ${task.account_no}`]
      .join(' ').toLowerCase().includes(q)));
}

/** What is happening first: running tasks, then the ones due now, then
 *  finished ones, then the ones waiting for later; newest within each. */
export function sortTasks(tasks: readonly FleetTask[], now: number = Date.now()): FleetTask[] {
  const rank = (t: FleetTask) =>
    t.state === 'leased' ? 3 : t.state === 'ready' ? (Date.parse(t.due_at) <= now ? 2 : 0) : 1;
  const stamp = (t: FleetTask) => t.done_at ?? t.leased_at ?? t.due_at;
  return [...tasks].sort((a, b) => rank(b) - rank(a) || (stamp(b) < stamp(a) ? -1 : stamp(b) > stamp(a) ? 1 : b.id - a.id));
}

// ── Analysis ─────────────────────────────────────────────────────────────────

export type FunnelRange = 1 | 7 | 14;
export const FUNNEL_RANGES: readonly FunnelRange[] = [1, 7, 14];

const DAY_MS = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type FunnelKey = keyof Omit<FleetFunnelDay, 'day'>;

// The task-result sum behind each stage.
const ERP_COUNTER: Record<FlowStage, FunnelKey> = {
  search: 'searches', cards: 'cards', title: 'title_pass', open: 'opened', keywords: 'keyword_pass',
  fresh: 'fresh', ai: 'reviewed', passed: 'passed', alert: 'alerted',
};

const LATE_KEYS: ReadonlySet<FunnelKey> = new Set(['title_pass', 'keyword_pass', 'fresh', 'passed', 'withheld']);

export type FunnelCounts = Partial<Record<FlowStage, number>> & {
  withheld?: number; partial?: readonly FlowStage[];
  /** With `partial`: how many of the range's searches with cards reported the later stages. */
  coverage?: { counted: number; carded: number };
};

/** The stage counts summed over the last `range` UTC days, today included.
 *  Workers began reporting the gates, what passed the model and what they
 *  withheld later than the rest: a stage no search in the range reported
 *  stays undefined, so it reads as not counted rather than as 0, and one only
 *  some searches reported is `partial`, summed over fewer searches than the
 *  stages around it. `withheld` is the part of `passed` that workers with
 *  fleet alerts off held back. */
export function funnelCounts(days: readonly FleetFunnelDay[] | null, range: FunnelRange, now: number = Date.now()): FunnelCounts {
  if (!days) return {};
  const from = utcDay(now - (range - 1) * DAY_MS);
  const rows = days.filter(d => d.day >= from && d.day <= utcDay(now));
  const sum = (key: FunnelKey): number | undefined => {
    if (LATE_KEYS.has(key) && !rows.some(d => d[key] != null)) return undefined;
    return rows.reduce((n, d) => n + (d[key] ?? 0), 0);
  };
  const out: FunnelCounts = {};
  const partial: FlowStage[] = [];
  for (const [stage, key] of Object.entries(ERP_COUNTER) as [FlowStage, FunnelKey][]) {
    const n = sum(key);
    if (n === undefined) continue;
    out[stage] = n;
    if (LATE_KEYS.has(key) && rows.some(d => d.counted < d.carded)) partial.push(stage);
  }
  const withheld = sum('withheld');
  if (withheld !== undefined) out.withheld = withheld;
  if (partial.length) {
    out.partial = partial;
    out.coverage = { counted: rows.reduce((n, d) => n + d.counted, 0), carded: rows.reduce((n, d) => n + d.carded, 0) };
  }
  return out;
}

export type FunnelGap = { kind: 'ratio' | 'pct'; value: number | null; drop: boolean; mixed?: boolean; over?: boolean };

/** What survives into each stage from the last counted one before it: cards
 *  per search as a ratio, every other step as a percentage; `drop` marks a
 *  step under half. An uncounted stage gets no gap of its own, and neither
 *  does a step between a partial stage and a whole one: they were summed over
 *  different days. The alert is read against what passed the model less what
 *  was withheld, which could never be sent. A step over 100% is `over`, not a
 *  rate: a worker counts an alert sent on a cached verdict but not the pass,
 *  so the two stages did not count the same listings. */
export function funnelGaps(counts: FunnelCounts): FunnelGap[] {
  const out: FunnelGap[] = [];
  const partial = (k: FlowStage) => !!counts.partial?.includes(k);
  let last = counts[FLOW_STAGES[0]];
  let lastStage = FLOW_STAGES[0];
  for (let i = 1; i < FLOW_STAGES.length; i += 1) {
    const stage = FLOW_STAGES[i];
    const prev = stage === 'alert' && lastStage === 'passed' && last !== undefined && counts.withheld !== undefined
      ? last - counts.withheld : last;
    const cur = counts[stage];
    const mixed = cur !== undefined && partial(lastStage) !== partial(stage);
    const known = prev !== undefined && cur !== undefined && prev > 0 && !mixed;
    if (stage === 'cards') out.push({ kind: 'ratio', value: known ? Math.round(cur / prev) : null, drop: false });
    else {
      const over = known && cur > prev;
      const pct = known && !over ? Math.round(cur / prev * 1000) / 10 : null;
      out.push({ kind: 'pct', value: pct, drop: pct !== null && pct < 50, ...(mixed ? { mixed } : {}), ...(over ? { over } : {}) });
    }
    if (cur !== undefined) { last = cur; lastStage = stage; }
  }
  return out;
}

export type FunnelHeadline = {
  cards: number; searches: number; reviews: number; alerts: number;
  passed: number | null; withheld: number;
  cardsPerAlert: number | null; reviewsPerAlert: number | null; titleDrop: number | null; modelDrop: number | null;
};

/** The ratios the sentence under the pipeline names; null when a stage is
 *  not counted or nothing was alerted. The model's drop is read only against
 *  what passed it, never against the alerts: a listing a worker withheld with
 *  fleet alerts off passed the model, it just was not sent. */
export function funnelHeadline(counts: FunnelCounts): FunnelHeadline | null {
  const reviews = counts.ai;
  const alerts = counts.alert;
  if (reviews === undefined || alerts === undefined) return null;
  const cards = counts.cards ?? 0;
  const searches = counts.search ?? 0;
  const partial = counts.partial ?? [];
  // A partial count read against a whole one would understate what passed.
  const title = partial.includes('title') ? undefined : counts.title;
  // What passed and what was withheld only stand beside the range's other
  // totals when every day in it counted them.
  const passed = partial.includes('passed') ? null : counts.passed ?? null;
  return {
    cards, searches, reviews, alerts, passed, withheld: passed === null ? 0 : counts.withheld ?? 0,
    cardsPerAlert: alerts > 0 && cards > 0 ? Math.round(cards / alerts) : null,
    reviewsPerAlert: alerts > 0 && reviews > 0 ? Math.round(reviews / alerts) : null,
    titleDrop: title !== undefined && cards > 0 ? Math.round((1 - title / cards) * 100) : null,
    modelDrop: reviews > 0 && passed !== null ? Math.round((1 - passed / reviews) * 100) : null,
  };
}

export type DayPoint = { day: string; value: number; today: boolean };
export type DaySeries = { points: DayPoint[]; total: number; fullDayAverage: number; max: number };

/** One value per UTC day for the last `n` days ending today, gaps as zero. */
export function daySeries(days: readonly FleetFunnelDay[], key: 'reviewed' | 'alerted', n: number = 14, now: number = Date.now()): DaySeries {
  const byDay = new Map(days.map(d => [d.day, d[key]]));
  const points: DayPoint[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const day = utcDay(now - i * DAY_MS);
    points.push({ day, value: byDay.get(day) ?? 0, today: i === 0 });
  }
  const total = points.reduce((s, p) => s + p.value, 0);
  const full = points.slice(0, -1);
  const fullDayAverage = full.length ? Math.round(full.reduce((s, p) => s + p.value, 0) / full.length) : 0;
  return { points, total, fullDayAverage, max: Math.max(0, ...points.map(p => p.value)) };
}

/** A chart's top gridline: the smallest round number above the highest bar. */
export function niceTop(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= max) return m * pow;
  return 10 * pow;
}

export type CityAlerts = {
  slug: string; name: string; region: string | null; alerts: number; reviewed: number | null; rate: number | null;
  lastDay: string | null;
};

/** Alerts per city over the window: the coordinator's sent counts by city,
 *  and the model reviews from the fleet's finished tasks on the same cities
 *  (null where none finished in the window). */
export function alertsByCity(
  hits: readonly AlertHitRow[], tasks: readonly FleetTask[], cities: readonly FleetCity[],
): CityAlerts[] {
  const byCity = new Map<string, { alerts: number; lastDay: string | null }>();
  for (const h of hits) {
    if (!h.search_city || h.sent <= 0) continue;
    const c = byCity.get(h.search_city) ?? { alerts: 0, lastDay: null };
    c.alerts += h.sent;
    if (!c.lastDay || h.day > c.lastDay) c.lastDay = h.day;
    byCity.set(h.search_city, c);
  }
  const reviewed = new Map<string, number>();
  const alerted = new Map<string, number>();
  const incomplete = new Set<string>();
  for (const t of tasks) {
    if (t.state !== 'done' || t.kind !== 'search') continue;
    if (typeof t.result?.reviewed !== 'number' || typeof t.result?.alerted !== 'number') { incomplete.add(t.city); continue; }
    alerted.set(t.city, (alerted.get(t.city) ?? 0) + t.result.alerted);
    reviewed.set(t.city, (reviewed.get(t.city) ?? 0) + t.result.reviewed);
  }
  const names = new Map(cities.map(c => [c.slug, c]));
  return [...byCity].map(([slug, c]) => {
    const city = names.get(slug);
    const r = reviewed.get(slug) ?? null;
    return {
      slug, name: city?.name ?? slug, region: city?.region ?? null, alerts: c.alerts, reviewed: r,
      rate: r && tasks.length < 1000 && !incomplete.has(slug) && alerted.get(slug) === c.alerts ? c.alerts / r : null, lastDay: c.lastDay,
    };
  }).sort((a, b) => b.alerts - a.alerts || a.name.localeCompare(b.name));
}
