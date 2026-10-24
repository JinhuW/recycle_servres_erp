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
  for (const item of distinct) await sql.notify(NOTIFY_CHANNEL, item);
  return distinct;
}

export async function reconcile(sql: Sql, now: Date = new Date()): Promise<ReconcileReport> {
  const settings = await loadSettings(sql);
  const woke = new Set<string>();

  // A task waiting on a city or item nobody wants searched any more. A city
  // that is merely unverified keeps its verify-slug task: that task is how it
  // gets verified.
  const cancelled = await sql`
    UPDATE fleet_tasks t SET state = 'cancelled', done_at = ${now}
    FROM fleet_cities c, fleet_items i
    WHERE t.city = c.slug AND t.item = i.name AND t.state = 'ready'
      AND (NOT i.enabled OR c.disabled_at IS NOT NULL OR (NOT c.enabled AND t.kind <> 'verify-slug'))`;

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
  return { inserted: inserted.length, cancelled: cancelled.count, expired: expired.length, probes, notified };
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

/**
 * The 30 s tick. Every role that serves workers runs it: two instances
 * reconciling at once is the designed case, not a race to avoid.
 */
export function startFleetSchedulerLoop(sql: Sql, env: Env): { stop(): void } {
  if (env.FLEET_ROLE === 'manager-only') return { stop() {} };
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const r = await reconcile(sql);
      if (r.inserted || r.cancelled || r.expired || r.probes) log.info('fleet tasks reconciled', r);
    } catch (e) {
      log.error('fleet reconcile failed', e);
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
