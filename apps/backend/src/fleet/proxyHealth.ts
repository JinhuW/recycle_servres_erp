import { Hono } from 'hono';
import type { Sql } from 'postgres';
import {
  FLEET_PROXY_BUCKET_MS, FLEET_PROXY_BUCKETS, FLEET_PROXY_ROUND_MS, proxyHealthState,
  type FleetProxyCheck, type FleetProxyHealth, type FleetProxyHealthAnswer, type FleetProxySource,
} from '@recycle-erp/shared';
import { getDb, type SqlLike } from '../db';
import type { Env } from '../types';
import { allLimited } from '../lib/concurrency';
import { log } from '../lib/log';
import { poolKey, unseal } from '../lib/sealed';
import { callFacade } from '../routes/coordinator';
import { managerOnly, unavailable, type ManagerEnv } from './auth';
import { proxyWithoutLogin } from './claim';
import { listProxies } from './proxies';
import { probeProxy, type ProbeResult } from './proxyProbe';
import { notFound } from './sql';

// ─── Proxy health ─────────────────────────────────────────────────────────────
// Every five minutes one backend instance dials through each proxy on the
// ERP's list, and asks rs_console to do the same for the ports the homelab
// workers dial (it holds their logins; the ERP never sees them). Each answer
// is a row in fleet_proxy_checks, kept two weeks, and the Proxies tab draws
// the day from them.

const plog = log.child({ module: 'fleet' });
const KEEP_DAYS = 14;
/** A manager's "Check all now" waits this long after the last round. */
const CHECK_NOW_GAP_MS = 15_000;
const PROBES_AT_ONCE = 4;
// The console builds the fleet document, then dials every port with an 8 s cap.
const CONSOLE_TIMEOUT_MS = 30_000;
const FIRST_RUN_MS = 20_000;
const TICK_MS = 30_000;

type CoordinatorStatus = NonNullable<FleetProxyHealthAnswer['coordinator']>;
type CheckRow = {
  exit: string; source: FleetProxySource; proxy_id: number | null; workers: string[];
  ok: boolean; latency_ms: number | null; exit_ip: string | null; city: string | null;
  region: string | null; country: string | null; org: string | null; error: string | null;
};

const fromProbe = (r: ProbeResult) => r.ok
  ? { ok: true, latency_ms: r.latency_ms, exit_ip: r.exit.ip, city: r.exit.city, region: r.exit.region, country: r.exit.country, org: r.exit.org, error: null }
  : { ok: false, latency_ms: r.latency_ms, exit_ip: null, city: null, region: null, country: null, org: null, error: r.error };

async function probeErp(sql: SqlLike, env: Env, id?: number): Promise<CheckRow[]> {
  const key = poolKey(env);
  if (!key) return [];
  const rows = await sql<{ id: number; url_enc: string }[]>`
    SELECT id, url_enc FROM fleet_proxies ${id === undefined ? sql`` : sql`WHERE id = ${id}`} ORDER BY id`;
  return allLimited(rows.map((r) => async (): Promise<CheckRow> => {
    const url = unseal(r.url_enc, key);
    const result = await probeProxy(url, env.FLEET_PROXY_LOOKUP_URL || undefined);
    return { exit: proxyWithoutLogin(url) ?? '', source: 'erp', proxy_id: r.id, workers: [], ...fromProbe(result) };
  }), PROBES_AT_ONCE);
}

type ConsoleRow = {
  url?: unknown; workers?: unknown; ok?: unknown; latency_ms?: unknown; error?: unknown;
  ip?: unknown; city?: unknown; region?: unknown; country?: unknown; org?: unknown;
};
const text = (v: unknown, max = 200): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);

async function probeCoordinator(env: Env): Promise<{ status: CoordinatorStatus; rows: CheckRow[] }> {
  const got = await callFacade(env, 'GET', '/v1/proxies/health', undefined, CONSOLE_TIMEOUT_MS);
  if (got.status === 501) return { status: 'not_configured', rows: [] };
  // A console from before the endpoint: the tab shows the ERP's proxies alone.
  if (got.status === 404) return { status: 'unsupported', rows: [] };
  if (got.error) return { status: 'unreachable', rows: [] };
  const list = (got.payload as { proxies?: unknown } | null)?.proxies;
  const rows: CheckRow[] = [];
  for (const p of Array.isArray(list) ? (list as ConsoleRow[]) : []) {
    const exit = text(p.url, 500);
    if (!exit) continue;
    rows.push({
      exit, source: 'coordinator', proxy_id: null,
      workers: Array.isArray(p.workers) ? p.workers.filter((w): w is string => typeof w === 'string').slice(0, 100) : [],
      ok: p.ok === true,
      latency_ms: typeof p.latency_ms === 'number' && Number.isFinite(p.latency_ms) ? Math.round(p.latency_ms) : null,
      exit_ip: text(p.ip), city: text(p.city), region: text(p.region), country: text(p.country), org: text(p.org),
      error: p.ok === true ? null : (text(p.error) ?? 'Check failed'),
    });
  }
  return { status: 'ok', rows };
}

async function insertChecks(sql: SqlLike, rows: CheckRow[], at: Date | null): Promise<void> {
  for (const r of rows) {
    await sql`
      INSERT INTO fleet_proxy_checks (exit, source, proxy_id, workers, checked_at, ok, latency_ms, exit_ip, city, region, country, org, error)
      VALUES (${r.exit}, ${r.source}, ${r.proxy_id}, ${sql.array(r.workers)}, ${at ?? sql`NOW()`}, ${r.ok}, ${r.latency_ms},
              ${r.exit_ip}, ${r.city}, ${r.region}, ${r.country}, ${r.org}, ${r.error})`;
  }
}

/**
 * One full round, if no other instance started one within `gapMs`: every ERP
 * proxy and every coordinator port. False when the round was someone else's.
 */
export async function runProxyRound(sql: Sql, env: Env, gapMs = FLEET_PROXY_ROUND_MS - 10_000): Promise<boolean> {
  const [claimed] = await sql<{ started_at: Date }[]>`
    UPDATE fleet_proxy_rounds SET started_at = NOW()
    WHERE started_at <= NOW() - make_interval(secs => ${gapMs / 1000})
    RETURNING started_at`;
  if (!claimed) return false;
  const [erp, coordinator] = await Promise.all([probeErp(sql, env), probeCoordinator(env)]);
  const at = claimed.started_at;
  await sql.begin(async (tx) => {
    await insertChecks(tx, [...erp, ...coordinator.rows], at);
    await tx`
      UPDATE fleet_proxy_rounds SET coordinator = ${coordinator.status},
        coordinator_at = CASE WHEN ${coordinator.status} = 'ok' THEN ${at} ELSE coordinator_at END`;
    await tx`DELETE FROM fleet_proxy_checks WHERE checked_at < NOW() - make_interval(days => ${KEEP_DAYS})`;
  });
  const down = [...erp, ...coordinator.rows].filter((r) => !r.ok).length;
  if (down) plog.warn('fleet proxies failed their check', { failed: down, erp: erp.length, coordinator: coordinator.rows.length });
  return true;
}

type HistoryRow = Omit<CheckRow, 'workers'> & { checked_at: Date };

const toCheck = (r: HistoryRow): FleetProxyCheck => ({
  at: r.checked_at.toISOString(), ok: r.ok, latency_ms: r.latency_ms, exit_ip: r.exit_ip,
  city: r.city, region: r.region, country: r.country, org: r.org, error: r.error,
});

function hostPort(exit: string): { host: string; port: number } {
  const m = /^[a-z0-9]+:\/\/(.+?)(?::(\d+))?$/i.exec(exit);
  return { host: m?.[1] ?? exit, port: Number(m?.[2] ?? 0) };
}

/** The day of one proxy's checks, newest first, into what the tab draws. */
function summarise(checks: HistoryRow[], latest: HistoryRow | undefined, now: number) {
  const day = checks.filter((c) => now - c.checked_at.getTime() < FLEET_PROXY_BUCKETS * FLEET_PROXY_BUCKET_MS);
  const buckets: FleetProxyHealth['buckets'] = Array.from({ length: FLEET_PROXY_BUCKETS }, () => null);
  const rank = { up: 0, degraded: 1, down: 2 } as const;
  for (const c of day) {
    const i = FLEET_PROXY_BUCKETS - 1 - Math.floor(Math.max(0, now - c.checked_at.getTime()) / FLEET_PROXY_BUCKET_MS);
    if (i < 0) continue;
    const s = proxyHealthState([c]) as 'up' | 'degraded' | 'down';
    const cur = buckets[i];
    if (cur === null || rank[s] > rank[cur]) buckets[i] = s;
  }
  const ips = day.filter((c) => c.ok && c.exit_ip).map((c) => c.exit_ip!);
  const previous = ips.find((ip) => ip !== ips[0]) ?? null;
  const recent = checks.length ? checks.slice(0, 2) : latest ? [latest] : [];
  return {
    state: proxyHealthState(recent),
    last: recent[0] ? toCheck(recent[0]) : null,
    previous_ip: previous,
    uptime: day.length ? day.filter((c) => c.ok).length / day.length : null,
    checks: day.length,
    buckets,
  };
}

export async function proxyHealthView(sql: SqlLike): Promise<FleetProxyHealthAnswer> {
  const [[round], proxies, history, latest] = await Promise.all([
    // The database's clock, which stamped every check, places them in buckets.
    sql<{ started_at: Date; coordinator: CoordinatorStatus | null; coordinator_at: Date | null; now: Date }[]>`
      SELECT started_at, coordinator, coordinator_at, NOW() AS now FROM fleet_proxy_rounds`,
    listProxies(sql),
    sql<(HistoryRow & { workers: string[] })[]>`
      SELECT exit, source, proxy_id, workers, checked_at, ok, latency_ms, exit_ip, city, region, country, org, error
      FROM fleet_proxy_checks
      WHERE checked_at > NOW() - make_interval(secs => ${(FLEET_PROXY_BUCKETS * FLEET_PROXY_BUCKET_MS) / 1000})
      ORDER BY checked_at DESC, id DESC`,
    // A proxy whose checks stopped a day ago still shows how it last answered.
    sql<HistoryRow[]>`
      SELECT DISTINCT ON (source, COALESCE(proxy_id::text, exit))
             exit, source, proxy_id, checked_at, ok, latency_ms, exit_ip, city, region, country, org, error
      FROM fleet_proxy_checks
      ORDER BY source, COALESCE(proxy_id::text, exit), checked_at DESC, id DESC`,
  ]);

  const now = round.now.getTime();
  const out: FleetProxyHealth[] = proxies.map((p) => {
    const mine = history.filter((c) => c.source === 'erp' && c.proxy_id === p.id);
    const last = latest.find((c) => c.source === 'erp' && c.proxy_id === p.id);
    return {
      exit: last?.exit ?? `${p.host}:${p.port}`, source: 'erp', proxy_id: p.id, label: p.label,
      host: p.host, port: p.port, slots: p.slots, workers: [], ...summarise(mine, last, now),
    };
  });
  // The homelab ports in use are those of the last round the console answered.
  const at = round.coordinator_at?.getTime();
  const ports = at === undefined ? [] : history.filter((c) => c.source === 'coordinator' && c.checked_at.getTime() === at);
  for (const port of ports) {
    // A port in the ERP list too is one port: its row gains the homelab workers.
    const { host, port: n } = hostPort(port.exit);
    const both = out.find((p) => p.source === 'erp' && p.host === host && p.port === n);
    if (both) {
      both.workers = port.workers;
      continue;
    }
    const mine = history.filter((c) => c.source === 'coordinator' && c.exit === port.exit);
    const last = latest.find((c) => c.source === 'coordinator' && c.exit === port.exit);
    out.push({
      exit: port.exit, source: 'coordinator', proxy_id: null, label: null, host, port: n,
      slots: [], workers: port.workers, ...summarise(mine, last, now),
    });
  }
  return {
    proxies: out,
    round_at: Number.isFinite(round.started_at.getTime()) ? round.started_at.toISOString() : null,
    coordinator: round.coordinator,
  };
}

/** The 30 s tick that starts a round once five minutes have passed. One instance wins each round. */
export function startProxyHealthLoop(sql: Sql, env: Env): { stop(): void } {
  if (env.FLEET_ROLE === 'manager-only') return { stop() {} };
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      await runProxyRound(sql, env);
    } catch (e) {
      plog.error('fleet proxy round failed', e);
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

const health = new Hono<ManagerEnv>().use('*', managerOnly);

health.get('/', async (c) => c.json(await proxyHealthView(getDb(c.env))));

// "Check now": one ERP proxy (`proxy_id`), or a full round unless one started
// in the last few seconds. A coordinator port is only checked with the rest:
// the console probes them together.
health.post('/check', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { proxy_id?: unknown } | null;
  const sql = getDb(c.env);
  const id = body?.proxy_id;
  if (id !== undefined && id !== null) {
    if (!Number.isInteger(id) || (id as number) < 1) return c.json(notFound('proxy').body, 404);
    if (!poolKey(c.env)) return c.json(unavailable('FB_POOL_KEY'), 503);
    const rows = await probeErp(sql, c.env, id as number);
    if (!rows.length) return c.json(notFound('proxy').body, 404);
    await insertChecks(sql, rows, null);
  } else {
    await runProxyRound(sql, c.env, CHECK_NOW_GAP_MS);
  }
  return c.json(await proxyHealthView(sql));
});

export default health;
