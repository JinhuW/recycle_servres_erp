// The ops watch: the api's view of the whole fleet, sent to the ops Telegram
// group through the alert relay (deploy/railway-alerts, POST /alert). The relay
// owns the group and its topic ids; this side names a topic key.
//
// Every worker reports through its heartbeat (heartbeat.ts), so one reader here
// covers the Railway worker and the OCI fleet alike. Raised alerts are kept in
// `watch_alerts`, and nothing is recorded as sent until the relay has taken it,
// so a relay or Telegram outage delays alerts rather than losing them.

import type {Sql} from '../db.ts';
import {DEAD_AFTER_S, problemText, type LoopFailures, type LoopName} from '../heartbeat.ts';
import type {Logger} from '../logger.ts';

/** A loop is failing after this many bad iterations in a row. */
export const FAILING_AFTER = 3;
const DIGEST_BATCH = 200;
const RETENTION_DAYS = 7;
const RELAY_TIMEOUT_MS = 15_000;
const WORKERS_LISTED = 5;

export interface WatchDeps {
  sql: Sql;
  logger: Logger;
  /** The api's own row: if the api is down, this loop is too, and Railway's webhook reports it. */
  selfId: string;
  relayUrl: string;
  relayToken: string;
}

export interface RelayAlert {
  topic: 'reddit_workers' | 'reddit_errors';
  status: 'firing' | 'resolved' | 'info';
  title: string;
  lines: string[];
}

interface WorkerRow {
  worker_id: string;
  role: string;
  silent_s: number;
  loop_failures: Partial<Record<LoopName, LoopFailures>>;
}

interface ErrorRow {
  id: string;
  worker_id: string;
  scope: string;
  message: string;
  fields: Record<string, unknown>;
}

/** One pass. True when error lines are still queued, so the loop comes straight back. */
export async function watchOnce(deps: WatchDeps): Promise<boolean> {
  await checkFleet(deps);
  const more = await sendErrorDigest(deps);
  await deps.sql`
    DELETE FROM worker_errors WHERE at < NOW() - make_interval(days => ${RETENTION_DAYS})`;
  return more;
}

async function checkFleet(deps: WatchDeps): Promise<void> {
  const {sql} = deps;
  const workers = await sql<WorkerRow[]>`
    SELECT worker_id, role, loop_failures,
           EXTRACT(EPOCH FROM NOW() - last_heartbeat_at)::float8 AS silent_s
      FROM workers
     WHERE worker_id <> ${deps.selfId}`;
  const raised = await sql<Array<{key: string; worker_id: string}>>`
    SELECT key, worker_id FROM watch_alerts`;

  const byId = new Map(workers.map((w) => [w.worker_id, w]));
  const down = new Set(workers.filter((w) => w.silent_s >= DEAD_AFTER_S).map((w) => w.worker_id));

  const wanted = new Map<string, {workerId: string; title: string; lines: string[]}>();
  for (const w of workers) {
    if (down.has(w.worker_id)) {
      wanted.set(`down:${w.worker_id}`, {
        workerId: w.worker_id,
        title: `Reddit ${w.role} down: ${w.worker_id}`,
        lines: [`No heartbeat for ${minutes(w.silent_s)}.`],
      });
      continue;
    }
    for (const [loop, f] of Object.entries(w.loop_failures)) {
      if (!f || f.consecutiveFailures < FAILING_AFTER) continue;
      wanted.set(`failing:${w.worker_id}:${loop}`, {
        workerId: w.worker_id,
        title: `Reddit ${loop} failing on ${w.worker_id}`,
        lines: [
          `${f.consecutiveFailures} iterations in a row.`,
          `Last error: ${f.lastError ?? 'none recorded'}`,
          ...(f.lastErrorAt ? [`At ${f.lastErrorAt}`] : []),
        ],
      });
    }
  }

  const raisedKeys = new Set(raised.map((r) => r.key));
  for (const [key, alert] of wanted) {
    if (raisedKeys.has(key)) continue;
    if (await post(deps, {topic: 'reddit_workers', status: 'firing', title: alert.title, lines: alert.lines})) {
      await sql`
        INSERT INTO watch_alerts (key, worker_id) VALUES (${key}, ${alert.workerId})
        ON CONFLICT (key) DO NOTHING`;
    }
  }

  for (const r of raised) {
    if (wanted.has(r.key)) continue;
    const kind = r.key.slice(0, r.key.indexOf(':'));
    // A failing loop on a worker that has since died is not a recovery; the
    // down alert speaks for it until the worker is back or gone.
    if (kind === 'failing' && down.has(r.worker_id)) continue;
    const worker = byId.get(r.worker_id);
    const loop = r.key.slice(r.key.lastIndexOf(':') + 1);
    const resolution: Pick<RelayAlert, 'title' | 'lines'> = kind === 'down'
      ? worker
        ? {title: `Reddit ${worker.role} back: ${r.worker_id}`, lines: ['Heartbeat resumed.']}
        : {title: `Reddit worker gone: ${r.worker_id}`, lines: ['Its row was removed: a clean shutdown, or deleted from the fleet view.']}
      : worker
        ? {title: `Reddit ${loop} recovered on ${r.worker_id}`, lines: ['Its last iteration ran clean.']}
        : {title: `Reddit ${loop} on ${r.worker_id}: worker gone`, lines: ['Its row was removed: a clean shutdown, or deleted from the fleet view.']};
    if (await post(deps, {topic: 'reddit_workers', status: 'resolved', ...resolution})) {
      await sql`DELETE FROM watch_alerts WHERE key = ${r.key}`;
    }
  }
}

/** Every warn/error line since the last digest, grouped by what it says. */
async function sendErrorDigest(deps: WatchDeps): Promise<boolean> {
  const {sql} = deps;
  const rows = await sql<ErrorRow[]>`
    SELECT id::text, worker_id, scope, message, fields
      FROM worker_errors
     WHERE sent_at IS NULL
     ORDER BY id
     LIMIT ${DIGEST_BATCH}`;
  if (rows.length === 0) return false;

  const groups = new Map<string, {scope: string; text: string; count: number; workers: Set<string>}>();
  for (const row of rows) {
    const text = problemText(row.message, row.fields);
    const key = `${row.scope}\u0000${text}`;
    const group = groups.get(key) ?? {scope: row.scope, text, count: 0, workers: new Set<string>()};
    group.count++;
    group.workers.add(row.worker_id);
    groups.set(key, group);
  }
  const lines = [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .map((g) => `${g.count}× ${g.scope || 'main'} · ${g.text} — ${listWorkers(g.workers)}`);

  const delivered = await post(deps, {
    topic: 'reddit_errors',
    status: 'info',
    title: `Reddit: ${rows.length} warn/error line${rows.length === 1 ? '' : 's'}`,
    lines,
  });
  if (!delivered) return false;
  await sql`
    UPDATE worker_errors SET sent_at = NOW()
     WHERE id = ANY(${rows.map((r) => r.id)}::bigint[])`;
  return rows.length === DIGEST_BATCH;
}

async function post(deps: WatchDeps, alert: RelayAlert): Promise<boolean> {
  try {
    const res = await fetch(deps.relayUrl, {
      method: 'POST',
      headers: {Authorization: `Bearer ${deps.relayToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    if (res.ok) return true;
    deps.logger.warn('alert relay refused the alert', {status: res.status, title: alert.title});
  } catch (e) {
    deps.logger.warn('alert relay unreachable', {error: e instanceof Error ? e.message : String(e)});
  }
  return false;
}

function minutes(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
}

function listWorkers(workers: Set<string>): string {
  const ids = [...workers].sort();
  const shown = ids.slice(0, WORKERS_LISTED).join(', ');
  return ids.length > WORKERS_LISTED ? `${shown} +${ids.length - WORKERS_LISTED}` : shown;
}
