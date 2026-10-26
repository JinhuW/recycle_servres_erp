import type { Sql } from 'postgres';
import {
  FLEET_TASK_STATES,
  type FleetTask,
  type FleetTaskLog,
  type FleetTaskState,
  type RoundStartAnswer,
} from '@recycle-erp/shared';
import type { SqlLike } from '../db';
import { loadSettings } from './cities';
import { notifyReady } from './scheduler';
import {
  bad, eventToWire, exists, notFound, taskToWire,
  type Refusal, type TaskEventRow, type TaskRow,
} from './sql';

// ─── Tasks as managers see and drive them ─────────────────────────────────────
// The list, the city log, a manual "search now" and the round start. The
// worker's side of a task (lease, done, events) belongs to the claim protocol.

export const MANUAL_PRIORITY = 100;
const LIST_LIMIT = 1000;
// A history read (Analysis: two weeks of done searches) is several thousand
// rows at the imported catalog's size; the queue itself stays at LIST_LIMIT.
export const HISTORY_LIMIT = 5000;
const DEFAULT_LOG_HOURS = 24;
const MAX_LOG_HOURS = 720;

export type TaskFilter = {
  state?: FleetTaskState;
  city?: string;
  item?: string;
  worker?: string;
  since?: Date;
};

export function readTaskFilter(q: Record<string, string | undefined>): TaskFilter | Refusal {
  const f: TaskFilter = {};
  if (q.state) {
    if (!(FLEET_TASK_STATES as readonly string[]).includes(q.state)) return bad(`state must be one of: ${FLEET_TASK_STATES.join(', ')}`);
    f.state = q.state as FleetTaskState;
  }
  if (q.city) f.city = q.city;
  if (q.item) f.item = q.item;
  if (q.worker) f.worker = q.worker;
  if (q.since) {
    const d = new Date(q.since);
    if (Number.isNaN(d.getTime())) return bad('since must be an ISO-8601 instant');
    f.since = d;
  }
  return f;
}

export const isQueueRead = (f: TaskFilter): boolean => f.state === 'ready' || f.state === 'leased';

/**
 * The queue (ready or leased) in the order workers take it: a manager's task
 * first, then due first. Anything else is history, newest first, so a cap
 * cuts the oldest rows rather than the latest ones. `truncated` says the cap
 * was hit.
 */
export async function listTasks(sql: SqlLike, f: TaskFilter): Promise<{ tasks: FleetTask[]; truncated: boolean }> {
  const queue = isQueueRead(f);
  const limit = queue ? LIST_LIMIT : HISTORY_LIMIT;
  const rows = await sql<TaskRow[]>`
    SELECT * FROM fleet_tasks
    WHERE TRUE
      ${f.state ? sql`AND state = ${f.state}` : sql``}
      ${f.city ? sql`AND city = ${f.city}` : sql``}
      ${f.item ? sql`AND item = ${f.item}` : sql``}
      ${f.worker ? sql`AND worker_id = ${f.worker}` : sql``}
      ${f.since ? sql`AND GREATEST(due_at, leased_at, done_at) >= ${f.since}` : sql``}
    ${queue ? sql`ORDER BY priority DESC, due_at, id` : sql`ORDER BY GREATEST(due_at, leased_at, done_at) DESC, id DESC`}
    LIMIT ${limit + 1}`;
  return { tasks: rows.slice(0, limit).map(taskToWire), truncated: rows.length > limit };
}

export type LogQuery = { city?: string; worker?: string; hours: number };

export function readLogQuery(q: Record<string, string | undefined>): LogQuery | Refusal {
  if (!q.city && !q.worker) return bad('city or worker is required');
  let hours = DEFAULT_LOG_HOURS;
  if (q.hours !== undefined) {
    hours = Number(q.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_LOG_HOURS) return bad(`hours must be a whole number from 1 to ${MAX_LOG_HOURS}`);
  }
  return { city: q.city || undefined, worker: q.worker || undefined, hours };
}

/** A city's (or a worker's) recent tasks, each with its events, newest task first. */
export async function cityLog(sql: SqlLike, q: LogQuery, now: Date = new Date()): Promise<FleetTaskLog[]> {
  const since = new Date(now.getTime() - q.hours * 3_600_000);
  const tasks = await sql<TaskRow[]>`
    SELECT * FROM fleet_tasks
    WHERE GREATEST(due_at, leased_at, done_at) >= ${since}
      ${q.city ? sql`AND city = ${q.city}` : sql``}
      ${q.worker ? sql`AND worker_id = ${q.worker}` : sql``}
    ORDER BY COALESCE(leased_at, due_at) DESC, id DESC
    LIMIT ${LIST_LIMIT}`;
  if (tasks.length === 0) return [];
  const events = await sql<TaskEventRow[]>`
    SELECT * FROM fleet_task_events
    WHERE task_id = ANY(${tasks.map((t) => t.id)}::bigint[])
    ORDER BY at, id`;
  return tasks.map((t) => ({
    ...taskToWire(t),
    events: events.filter((e) => e.task_id === t.id).map(eventToWire),
  }));
}

/**
 * "Search this city now." The pair's waiting task is pulled to the front
 * rather than a second one written, because only one open search per pair
 * exists; a pair with no task (a city switched off) gets one of its own.
 */
export async function manualTask(sql: Sql, city: string, item: string, now: Date = new Date()): Promise<FleetTask | Refusal> {
  const out = await sql.begin(async (tx) => {
    const [open] = await tx<TaskRow[]>`
      SELECT * FROM fleet_tasks
      WHERE city = ${city} AND item = ${item} AND kind = 'search' AND state IN ('ready', 'leased')
      FOR UPDATE`;
    if (open?.state === 'leased') return exists(`${city} / ${item} is being searched by ${open.worker_id} right now`);
    if (open) {
      const [row] = await tx<TaskRow[]>`
        UPDATE fleet_tasks SET priority = ${MANUAL_PRIORITY}, due_at = ${now}, reason = 'manual'
        WHERE id = ${open.id} RETURNING *`;
      return row;
    }
    const [c] = await tx<{ slug: string }[]>`SELECT slug FROM fleet_cities WHERE slug = ${city}`;
    if (!c) return notFound(`no city ${city}`);
    const [i] = await tx<{ name: string }[]>`SELECT name FROM fleet_items WHERE name = ${item}`;
    if (!i) return notFound(`no item ${item}`);
    // A second click, or the scheduler writing the pair's task, can land
    // between the look above and this insert; the open-task index then
    // refuses it, and the task that won is the one to pull forward.
    const [row] = await tx<TaskRow[]>`
      INSERT INTO fleet_tasks (city, item, kind, due_at, priority, state, reason)
      VALUES (${city}, ${item}, 'search', ${now}, ${MANUAL_PRIORITY}, 'ready', 'manual')
      ON CONFLICT DO NOTHING
      RETURNING *`;
    if (row) return row;
    const [won] = await tx<TaskRow[]>`
      UPDATE fleet_tasks SET priority = ${MANUAL_PRIORITY}, due_at = ${now}, reason = 'manual'
      WHERE city = ${city} AND item = ${item} AND kind = 'search' AND state = 'ready'
      RETURNING *`;
    return won ?? exists(`${city} / ${item} is being searched right now`);
  });
  if ('status' in out) return out;
  await notifyReady(sql, [item]);
  return taskToWire(out);
}

/**
 * Every search waiting for later becomes due now, except the pairs that
 * finished within `start_fresh_hours`: a round started twice in an afternoon
 * should not visit the same cities twice. A task already due is left as it
 * is, reason included.
 */
export async function startRound(sql: Sql, now: Date = new Date()): Promise<RoundStartAnswer> {
  const { start_fresh_hours } = await loadSettings(sql);
  const started = await sql<{ item: string }[]>`
    UPDATE fleet_tasks t SET due_at = ${now}, reason = 'start'
    WHERE t.state = 'ready' AND t.kind = 'search' AND t.due_at > ${now}
      AND NOT EXISTS (
        SELECT 1 FROM fleet_tasks d
        WHERE d.city = t.city AND d.item = t.item AND d.kind = 'search' AND d.state = 'done'
          AND d.done_at > ${now}::timestamptz - make_interval(hours => ${start_fresh_hours}))
    RETURNING t.item`;
  const [{ skipped }] = await sql<{ skipped: number }[]>`
    SELECT COUNT(*)::int AS skipped FROM fleet_tasks t
    WHERE t.state = 'ready' AND t.kind = 'search' AND t.due_at > ${now}`;
  await notifyReady(sql, started.map((t) => t.item));
  return { started: started.length, skipped };
}
