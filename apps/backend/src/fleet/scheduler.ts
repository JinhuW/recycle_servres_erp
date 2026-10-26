import type { Sql } from 'postgres';
import type { SqlLike } from '../db';
import { log } from '../lib/log';
import type { Env } from '../types';
import { loadSettings } from './cities';

// ─── The scheduler ────────────────────────────────────────────────────────────
// Keeps fleet_tasks true to the catalog: one open search task per enabled city
// and item, due when the cadence says, nothing waiting on a city or item that
// was switched off, no lease held past its time, and a probe now and then for
// a quarantined account so it can prove it searches again. Every step is a
// set-based statement that changes nothing when nothing is off, so it runs on
// a timer from every backend instance at once and after every manager write:
// the partial unique index on open tasks is what makes two instances inserting
// the same pair harmless (ON CONFLICT DO NOTHING is the 23505 catch).
//
// NOTIFY fleet_tasks follows anything that became ready, so a worker holding a
// next-task poll wakes within the second instead of at its next retry.

export const NOTIFY_CHANNEL = 'fleet_tasks';
const TICK_MS = 30_000;
const FIRST_RUN_MS = 5_000;
export const PROBE_PRIORITY = 10;
const VERIFY_BACKOFF_BASE = '15 minutes';
const VERIFY_BACKOFF_MAX = '6 hours';
export const PURGE_BATCH = 5000;
const PURGE_EVERY_MS = 3_600_000;
const PURGE_LOCK = 'fleet:purge';

export type ReconcileReport = {
  inserted: number;
  cancelled: number;
  expired: number;
  probes: number;
  /** The items a NOTIFY went out for. */
  notified: string[];
};

export async function notifyReady(sql: SqlLike, items: Iterable<string>): Promise<string[]> {
  const distinct = [...new Set(items)];
  // pg_notify through the caller's handle, not sql.notify: postgres.js binds
  // notify to the pool, so inside a transaction it would fire on another
  // connection before the task commits and wake a poll that then finds nothing.
  for (const item of distinct) await sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${item})`;
  return distinct;
}

export async function reconcile(sql: Sql, now: Date = new Date()): Promise<ReconcileReport> {
  const settings = await loadSettings(sql);
  const woke = new Set<string>();

  // A task waiting on a city or item nobody wants searched any more. A city
  // that is merely unverified keeps its verify-slug task: that task is how it
  // gets verified. A manager's "search now" is exactly how a switched-off
  // city gets searched, so only a disabled item takes it away (removing the
  // city cancels it there and then, in removeCity).
  const cancelled = await sql`
    UPDATE fleet_tasks t SET state = 'cancelled', done_at = ${now}
    FROM fleet_cities c, fleet_items i
    WHERE t.city = c.slug AND t.item = i.name AND t.state = 'ready'
      AND (NOT i.enabled OR (t.reason IS DISTINCT FROM 'manual'
        AND (c.disabled_at IS NOT NULL OR (NOT c.enabled AND t.kind <> 'verify-slug'))))`;

  // A lease past its time, or a task that has run longer than any search
  // should however faithfully its worker heartbeats: the old queue renewed
  // leases for ever, and a stuck browser held its city for the day.
  const expired = await sql<{ id: string; worker_id: string | null; leased_at: Date; lease_expires_at: Date | null }[]>`
    UPDATE fleet_tasks SET state = 'expired', done_at = ${now}
    WHERE state = 'leased'
      AND (lease_expires_at < ${now} OR leased_at + make_interval(mins => ${settings.task_max_minutes}) < ${now})
    RETURNING id, worker_id, leased_at, lease_expires_at`;
  for (const t of expired) {
    await sql`
      INSERT INTO fleet_task_events (task_id, worker_id, kind, detail, at)
      VALUES (${t.id}, ${t.worker_id}, 'expired',
              ${sql.json({ leased_at: t.leased_at.toISOString(), lease_expires_at: t.lease_expires_at?.toISOString() ?? null, task_max_minutes: settings.task_max_minutes })},
              ${now})`;
  }

  // A city still unverified after a check ended means that check gave no
  // verdict (stopped, an error, a wall, its lease ran out). The next one
  // waits 15 min, doubling per such check in the last day, up to 6 h: a slug
  // whose check fails every time would otherwise take a worker every tick.
  const checks = await sql<{ item: string; due_at: Date }[]>`
    INSERT INTO fleet_tasks (city, item, kind, due_at, priority, state, reason)
    SELECT c.slug, i.name, 'verify-slug',
           CASE WHEN f.n = 0 THEN ${now}::timestamptz
                ELSE GREATEST(${now}::timestamptz, f.last + LEAST(${VERIFY_BACKOFF_MAX}::interval, ${VERIFY_BACKOFF_BASE}::interval * power(2, f.n - 1))) END,
           50, 'ready', 'verify'
    FROM fleet_cities c
    CROSS JOIN LATERAL (SELECT name FROM fleet_items WHERE enabled ORDER BY name LIMIT 1) i
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::int AS n, MAX(t.done_at) AS last FROM fleet_tasks t
      WHERE t.city = c.slug AND t.kind = 'verify-slug' AND t.state IN ('done', 'expired')
        AND t.done_at > ${now}::timestamptz - interval '1 day'
        -- A check that gave a verdict is not a failure (reverify forgets it).
        AND NOT EXISTS (
          SELECT 1 FROM fleet_task_events e
          WHERE e.task_id = t.id AND e.kind = 'finished' AND jsonb_typeof(e.detail->'matches') = 'boolean'
            AND COALESCE(e.detail->'error', 'null'::jsonb) = 'null'::jsonb
            AND COALESCE(e.detail->'wall', 'null'::jsonb) = 'null'::jsonb)
    ) f
    WHERE c.verified_at IS NULL AND c.disabled_at IS NULL AND NOT c.enabled
      AND NOT EXISTS (SELECT 1 FROM fleet_tasks t WHERE t.city = c.slug AND t.kind = 'verify-slug' AND t.state IN ('ready','leased'))
    ON CONFLICT DO NOTHING RETURNING item, due_at`;
  for (const t of checks) if (t.due_at.getTime() <= now.getTime()) woke.add(t.item);

  // One open search per enabled pair. Due when the last finished search plus
  // the cadence says, or now: a pair never searched (or whose task just
  // expired) is due at once.
  const inserted = await sql<{ item: string; due_at: Date }[]>`
    INSERT INTO fleet_tasks (city, item, kind, due_at, priority, state, reason)
    SELECT c.slug, i.name, 'search',
           GREATEST(${now}::timestamptz, ld.last_done + (interval '1 day' / COALESCE(c.per_day, ${settings.per_day_default}))),
           0, 'ready',
           CASE WHEN ld.last_done IS NULL THEN 'added' ELSE 'cadence' END
    FROM fleet_cities c
    CROSS JOIN fleet_items i
    LEFT JOIN LATERAL (
      SELECT MAX(d.done_at) AS last_done FROM fleet_tasks d
      WHERE d.city = c.slug AND d.item = i.name AND d.kind = 'search' AND d.state = 'done'
    ) ld ON TRUE
    WHERE c.enabled AND c.disabled_at IS NULL AND i.enabled
      AND NOT EXISTS (
        SELECT 1 FROM fleet_tasks o
        WHERE o.city = c.slug AND o.item = i.name AND o.kind = 'search' AND o.state IN ('ready', 'leased'))
    ON CONFLICT DO NOTHING
    RETURNING item, due_at`;
  for (const t of inserted) if (t.due_at.getTime() <= now.getTime()) woke.add(t.item);

  // A cadence change reaches the search already waiting: raising a city from
  // one search a day to six should not wait out the day-long gap it was
  // written with. Only a task still waiting is moved (one already due keeps
  // its place in line), and only by more than a minute, so a steady catalog
  // writes nothing here.
  const retimed = await sql<{ item: string; due_at: Date }[]>`
    UPDATE fleet_tasks t SET due_at = n.due
    FROM (
      SELECT w.id, GREATEST(${now}::timestamptz, ld.last_done + (interval '1 day' / COALESCE(c.per_day, ${settings.per_day_default}))) AS due
      FROM fleet_tasks w
      JOIN fleet_cities c ON c.slug = w.city
      CROSS JOIN LATERAL (
        SELECT MAX(d.done_at) AS last_done FROM fleet_tasks d
        WHERE d.city = w.city AND d.item = w.item AND d.kind = 'search' AND d.state = 'done'
      ) ld
      WHERE w.state = 'ready' AND w.kind = 'search' AND w.reason = 'cadence' AND w.due_at > ${now}
        AND ld.last_done IS NOT NULL
    ) n
    WHERE t.id = n.id AND t.state = 'ready'
      AND abs(EXTRACT(EPOCH FROM (t.due_at - n.due))) > 60
    RETURNING t.item, t.due_at`;
  for (const t of retimed) if (t.due_at.getTime() <= now.getTime()) woke.add(t.item);

  // Compare completed results by account, as the coordinator did by worker.
  // Stopped searches are not evidence that the account cannot see cards.
  // `stopped` counts as the probe's `!result.stopped` does: absent, false,
  // null, 0 or "" is a search that ran to the end. An account in `blind` saw
  // nothing anywhere, so any account with cards in one of its cities is a
  // peer: the positive cities are one set, not a lookup per evidence row.
  if (settings.quarantine_hours > 0) {
    await sql`
      WITH evidence AS (
        SELECT t.account_no, t.city, t.done_at, (t.result->>'cards')::numeric AS cards
        FROM fleet_tasks t
        WHERE t.kind = 'search' AND t.state = 'done' AND jsonb_typeof(t.result->'cards') = 'number'
          AND COALESCE(t.result->'stopped', 'false'::jsonb) IN ('false'::jsonb, 'null'::jsonb, '0'::jsonb, '""'::jsonb)
          AND t.done_at > ${now}::timestamptz - make_interval(hours => ${settings.quarantine_hours})
      ), seen AS (
        SELECT DISTINCT city FROM evidence WHERE cards > 0
      ), blind AS (
        SELECT e.account_no, MAX(e.done_at) AS latest, COUNT(*) AS searches, jsonb_agg(DISTINCT e.city) AS cities
        FROM evidence e JOIN fleet_slots own ON own.account_no = e.account_no
        LEFT JOIN seen ON seen.city = e.city
        WHERE own.quarantine_reset_at IS NULL OR e.done_at > own.quarantine_reset_at
        GROUP BY e.account_no HAVING COUNT(*) >= 2 AND bool_and(e.cards = 0) AND bool_or(seen.city IS NOT NULL)
      )
      UPDATE fleet_slots s SET quarantined_until = b.latest + make_interval(hours => ${settings.quarantine_hours}),
        quarantine_evidence = jsonb_build_object('searches', b.searches, 'cities', b.cities, 'latest', b.latest, 'rule', 'all_zero_with_positive_peer')
      FROM blind b WHERE s.account_no = b.account_no
        AND (s.quarantine_reset_at IS NULL OR b.latest > s.quarantine_reset_at)
        AND (s.quarantined_until IS NULL OR s.quarantined_until < b.latest + make_interval(hours => ${settings.quarantine_hours}))`;
  }

  // A quarantined account gets one probe per interval so a quarantine can
  // end: its first home city that is still enabled, else whatever is most
  // overdue, on the first item. The probe carries its account from the start
  // (account_no is otherwise set at lease), which is how the pick keeps it for
  // that slot and how this step knows the slot had one recently.
  let probes = 0;
  const [item] = await sql<{ name: string }[]>`SELECT name FROM fleet_items WHERE enabled ORDER BY name LIMIT 1`;
  if (item) {
    const slots = await sql<{ account_no: number; home_cities: string[] }[]>`
      SELECT s.account_no, s.home_cities FROM fleet_slots s
      WHERE s.quarantined_until > ${now}
        AND NOT EXISTS (
          SELECT 1 FROM fleet_tasks t
          WHERE t.kind = 'probe' AND t.account_no = s.account_no
            AND (t.state IN ('ready', 'leased')
                 OR COALESCE(t.done_at, t.due_at) > ${now}::timestamptz - make_interval(hours => ${settings.quarantine_probe_hours})))
      ORDER BY s.account_no`;
    for (const s of slots) {
      const city = await probeCity(sql, s.home_cities);
      if (!city) continue;
      const rows = await sql`
        INSERT INTO fleet_tasks (city, item, kind, due_at, priority, state, reason, account_no)
        VALUES (${city}, ${item.name}, 'probe', ${now}, ${PROBE_PRIORITY}, 'ready', 'probe', ${s.account_no})
        ON CONFLICT DO NOTHING
        RETURNING id`;
      if (rows.length) { probes += 1; woke.add(item.name); }
    }
  }

  const notified = await notifyReady(sql, woke);
  return { inserted: inserted.length + checks.length, cancelled: cancelled.count, expired: expired.length, probes, notified };
}

async function probeCity(sql: Sql, home: string[]): Promise<string | null> {
  const homes = Array.isArray(home) ? home.filter((h) => typeof h === 'string') : [];
  if (homes.length) {
    const [h] = await sql<{ slug: string }[]>`
      SELECT slug FROM fleet_cities WHERE enabled AND slug = ANY(${homes}::text[])
      ORDER BY array_position(${homes}::text[], slug) LIMIT 1`;
    if (h) return h.slug;
  }
  const [overdue] = await sql<{ city: string }[]>`
    SELECT t.city FROM fleet_tasks t JOIN fleet_cities c ON c.slug = t.city
    WHERE t.state = 'ready' AND t.kind = 'search' AND c.enabled ORDER BY t.due_at LIMIT 1`;
  if (overdue) return overdue.city;
  const [any] = await sql<{ slug: string }[]>`SELECT slug FROM fleet_cities WHERE enabled ORDER BY slug LIMIT 1`;
  return any?.slug ?? null;
}

export type PurgeReport = { tasks: number; events: number; attempts: number; days: number };

/**
 * Deletes finished history older than `retention_days`: terminal tasks with
 * their events and archived attempts, oldest first, at most `batch` tasks.
 * Ready and leased tasks are never candidates. Two rules read further back
 * than any window, so their rows stay whatever their age: the newest finished
 * search per city and item (the cadence's last-done and the Cities tab's last
 * search) and the task holding each city's latest slug verdict (slugConfirmed,
 * which decides whether a city may be enabled again). The windowed rules all
 * fit inside the setting's lower bound except the familiar test, so the
 * window never drops below familiar_days.
 *
 * One instance purges at a time (a transaction-scoped advisory lock); the
 * other gets null and tries again later. Rows a pick or a heartbeat holds are
 * skipped, not waited for.
 */
export async function purgeHistory(sql: Sql, now: Date = new Date(), batch: number = PURGE_BATCH): Promise<PurgeReport | null> {
  return sql.begin(async (tx) => {
    const [{ locked }] = await tx<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${PURGE_LOCK}, 0)) AS locked`;
    if (!locked) return null;
    const settings = await loadSettings(tx);
    const days = Math.max(settings.retention_days, settings.familiar_days);
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const victims = await tx<{ id: string }[]>`
      WITH verdicts AS (
        SELECT DISTINCT ON (t.city) t.id
        FROM fleet_task_events e JOIN fleet_tasks t ON t.id = e.task_id
        WHERE t.kind = 'verify-slug' AND e.kind = 'finished'
          AND jsonb_typeof(e.detail->'matches') = 'boolean'
          AND COALESCE(e.detail->'error', 'null'::jsonb) = 'null'::jsonb
          AND COALESCE(e.detail->'wall', 'null'::jsonb) = 'null'::jsonb
        ORDER BY t.city, e.at DESC, e.id DESC
      )
      SELECT t.id FROM fleet_tasks t
      WHERE t.state IN ('done', 'cancelled', 'expired')
        AND COALESCE(t.done_at, t.leased_at, t.due_at) < ${cutoff}
        AND t.id NOT IN (SELECT id FROM verdicts)
        AND NOT (t.kind = 'search' AND t.state = 'done' AND t.id = (
          SELECT d.id FROM fleet_tasks d
          WHERE d.city = t.city AND d.item = t.item AND d.kind = 'search' AND d.state = 'done'
          ORDER BY d.done_at DESC, d.id DESC LIMIT 1))
      ORDER BY COALESCE(t.done_at, t.leased_at, t.due_at), t.id
      LIMIT ${batch}
      FOR UPDATE OF t SKIP LOCKED`;
    if (victims.length === 0) return { tasks: 0, events: 0, attempts: 0, days };
    const ids = victims.map((v) => v.id);
    // Attempts go with their task rather than through ON DELETE SET NULL:
    // a nulled task_id could collide on the attempts' unique key, and an
    // attempt this old is no longer any day's budget.
    const attempts = await tx`DELETE FROM fleet_task_attempts WHERE task_id = ANY(${ids}::bigint[])`;
    const events = await tx`DELETE FROM fleet_task_events WHERE task_id = ANY(${ids}::bigint[])`;
    const tasks = await tx`DELETE FROM fleet_tasks WHERE id = ANY(${ids}::bigint[])`;
    return { tasks: tasks.count, events: events.count, attempts: attempts.count, days };
  });
}

/**
 * The 30 s tick. Every role that serves workers runs it: two instances
 * reconciling at once is the designed case, not a race to avoid. The purge
 * rides along once an hour, and again on the next tick while a run comes back
 * full, so a backlog drains in short steps.
 */
export function startFleetSchedulerLoop(sql: Sql, env: Env): { stop(): void } {
  if (env.FLEET_ROLE === 'manager-only') return { stop() {} };
  let stopped = false;
  let busy = false;
  let lastPurge = 0;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const r = await reconcile(sql);
      if (r.inserted || r.cancelled || r.expired || r.probes) log.info('fleet tasks reconciled', r);
    } catch (e) {
      log.error('fleet reconcile failed', e);
    }
    try {
      if (!stopped && Date.now() - lastPurge >= PURGE_EVERY_MS) {
        const p = await purgeHistory(sql);
        if (!p || p.tasks < PURGE_BATCH) lastPurge = Date.now();
        if (p?.tasks) log.info('fleet history purged', p);
      }
    } catch (e) {
      lastPurge = Date.now();
      log.error('fleet history purge failed', e);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(() => void tick(), FIRST_RUN_MS);
  const handle = setInterval(() => void tick(), TICK_MS);
  first.unref?.();
  handle.unref?.();
  return { stop() { stopped = true; clearTimeout(first); clearInterval(handle); } };
}
