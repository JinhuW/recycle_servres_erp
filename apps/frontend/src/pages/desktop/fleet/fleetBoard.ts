// Pure helpers behind the fleet tabs: the queue board's cells and counts, due
// times, the round-start preview, the budget ring's tone and the masks the
// tables show. Kept out of the components so they can be unit-tested without
// React.

import type { FleetCity, FleetHost, FleetSlot, FleetTask } from '../../../lib/fleet';

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

// ── The board ────────────────────────────────────────────────────────────────

// Where a city stands for one item: its open task is due (or overdue), waits
// for its time, or a worker holds it; or nothing is open because the city was
// searched today, or because its tasks were cancelled (the city was removed).
export type BoardState = 'leased' | 'due' | 'done' | 'later' | 'cancelled';
export const BOARD_ORDER: readonly BoardState[] = ['done', 'leased', 'due', 'later', 'cancelled'];

export type BoardCell = {
  slug: string;
  name: string;
  state: BoardState;
  // The time the state turns on: the search's end, the lease's start, the
  // due time, or the cancellation.
  at: string | null;
  by: string | null;
};

export type BoardCounts = Record<BoardState, number> & { cities: number };

const ORDER_RANK = Object.fromEntries(BOARD_ORDER.map((s, i) => [s, i])) as Record<BoardState, number>;

/** One item's board: a cell per city the queue works (enabled, or disabled
 *  with a cancelled task today), in board order, and the counts. */
export function boardCells(
  cities: readonly FleetCity[], tasks: readonly FleetTask[], item: string, now: number = Date.now(),
): { cells: BoardCell[]; counts: BoardCounts } {
  const today = utcDayStart(now);
  const doneToday = new Map<string, FleetTask>();
  const cancelledToday = new Map<string, FleetTask>();
  for (const task of tasks) {
    if (task.item !== item) continue;
    if (task.state === 'done' && task.done_at && task.done_at >= today) {
      const prev = doneToday.get(task.city);
      if (!prev || (prev.done_at ?? '') < task.done_at) doneToday.set(task.city, task);
    } else if (task.state === 'cancelled' && (task.done_at ?? '') >= today) {
      cancelledToday.set(task.city, task);
    }
  }
  const cells: BoardCell[] = [];
  for (const city of cities) {
    const open = city.open[item] ?? null;
    const done = doneToday.get(city.slug);
    const cancelled = cancelledToday.get(city.slug);
    if (open?.state === 'leased') {
      cells.push({ slug: city.slug, name: city.name, state: 'leased', at: open.lease_expires_at, by: open.worker_id });
    } else if (done) {
      cells.push({ slug: city.slug, name: city.name, state: 'done', at: done.done_at, by: done.worker_id });
    } else if (open) {
      const due = Date.parse(open.due_at) <= now;
      cells.push({ slug: city.slug, name: city.name, state: due ? 'due' : 'later', at: open.due_at, by: null });
    } else if (cancelled) {
      cells.push({ slug: city.slug, name: city.name, state: 'cancelled', at: cancelled.done_at, by: null });
    } else if (city.enabled) {
      // Enabled, nothing open and nothing done: the scheduler has not written
      // its task yet (a city verified seconds ago). It reads as waiting.
      cells.push({ slug: city.slug, name: city.name, state: 'later', at: null, by: null });
    }
  }
  cells.sort((a, b) => ORDER_RANK[a.state] - ORDER_RANK[b.state] || a.name.localeCompare(b.name));
  const counts = { cities: cells.length, done: 0, leased: 0, due: 0, later: 0, cancelled: 0 };
  for (const c of cells) counts[c.state] += 1;
  return { cells, counts };
}

/** "12 of 127 searched, 3 being searched, 40 to go, 72 not due yet." */
export function countsSentence(t: Translate, counts: BoardCounts): string {
  const working = counts.cities - counts.cancelled;
  if (working === 0) return t('fleetBoardEmpty');
  if (counts.done === working) return t('fleetBoardDone', { n: working }) + '.';
  const parts = [t('fleetBoardSearched', { done: counts.done, n: working })];
  if (counts.leased) parts.push(t('fleetBoardLeased', { n: counts.leased }));
  if (counts.due) parts.push(t('fleetBoardDue', { n: counts.due }));
  if (counts.later) parts.push(t('fleetBoardLater', { n: counts.later }));
  const sentence = parts.join(', ') + '.';
  return counts.cancelled ? `${sentence} ${t('fleetBoardCancelled', { n: counts.cancelled })}` : sentence;
}

// ── Starting the round ───────────────────────────────────────────────────────

export type RoundPreviewItem = { due: number; skipped: number; ready: number };

/** What `round/start` would do, worked out from the cities: every ready task
 *  falls due unless its city-item was searched within `freshHours`. */
export function roundStartPreview(
  cities: readonly FleetCity[], items: readonly string[], freshHours: number, now: number = Date.now(),
): Record<string, RoundPreviewItem> {
  const fresh = now - freshHours * 3_600_000;
  const out: Record<string, RoundPreviewItem> = {};
  for (const item of items) {
    const row: RoundPreviewItem = { due: 0, skipped: 0, ready: 0 };
    for (const city of cities) {
      const open = city.open[item];
      if (!open || open.state !== 'ready') continue;
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

/** The soonest open task's due time across items, and its holder if leased. */
export function nextDue(c: FleetCity): { at: string | null; holder: string | null } {
  let at: string | null = null;
  let holder: string | null = null;
  for (const open of Object.values(c.open)) {
    if (!open) continue;
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
  return { running, desired: h.desired?.count ?? (h.authoritative ? h.capacity : 0) };
}

/** A roll's progress on one host: workers already on the target image, of
 *  the containers it runs; null when no release is rolling. */
export function rollProgress(h: FleetHost): { onTarget: number; total: number; replacing: string | null } | null {
  const target = h.desired?.image;
  const containers = h.report?.containers ?? [];
  if (!target || containers.length === 0) return null;
  const onTarget = containers.filter(c => c.image === target).length;
  if (onTarget === containers.length && !h.desired?.roll) return null;
  return { onTarget, total: containers.length, replacing: h.desired?.roll?.replace ?? null };
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

// ── Task table filters ───────────────────────────────────────────────────────

export type TaskFilter = { state: string; item: string; city: string; worker: string };
export const EMPTY_TASK_FILTER: TaskFilter = { state: '', item: '', city: '', worker: '' };

export function filterTasks(tasks: readonly FleetTask[], f: TaskFilter): FleetTask[] {
  const city = f.city.trim().toLowerCase();
  const worker = f.worker.trim().toLowerCase();
  return tasks.filter(task =>
    (!f.state || task.state === f.state)
    && (!f.item || task.item === f.item)
    && (!city || task.city.toLowerCase().includes(city) || (task.city_name ?? '').toLowerCase().includes(city))
    && (!worker || (task.worker_id ?? '').toLowerCase().includes(worker)));
}

/** Newest activity first: a leased task by its lease, a finished one by its
 *  end, a waiting one by its due time. */
export function sortTasks(tasks: readonly FleetTask[]): FleetTask[] {
  const stamp = (t: FleetTask) => t.done_at ?? t.leased_at ?? t.due_at;
  return [...tasks].sort((a, b) => (stamp(b) < stamp(a) ? -1 : stamp(b) > stamp(a) ? 1 : b.id - a.id));
}
