import {
  FB_FAILED_OUTCOMES, FB_PROXY_EXHAUSTED_AFTER,
  type FbIpGroup, type FbIpStint, type FbProxyMark, type FbStintOutcome,
} from '@recycle-erp/shared';
import type { SqlLike } from '../db';
import { hostPort, latestExitIpOf } from './proxyExit';

// ─── What an IP has burned ────────────────────────────────────────────────────
// Facebook judges the IP, so failed accounts count against the IP a port exits
// from now. A manager rotating it in Decodo clears the count without pressing
// anything: the next check reads a new IP, and the old failures belong to the old
// one. Rotating back onto a burned IP brings its failures back with it.

const ms = (d: Date | null) => (d ? d.getTime() : null);

type MarkRow = { url: string; ip: string | null; failed: number; exhausted_at: Date | null; revived_at: Date | null; revived_by_name: string | null };

/**
 * Each port's distinct failed accounts on its current IP, since its last revive.
 * The account that takes it past FB_PROXY_EXHAUSTED_AFTER exhausts it, at the
 * moment its stint ended. A stint with no IP recorded counts when it ended after
 * the port last changed IP. A port with no failures is left out.
 */
export async function proxyMarks(sql: SqlLike, url?: string): Promise<FbProxyMark[]> {
  const rows = await sql<MarkRow[]>`
    WITH ports AS (
      SELECT DISTINCT w.proxy_url AS url FROM fb_worker_accounts w
      WHERE w.proxy_url IS NOT NULL AND w.outcome = ANY(${FB_FAILED_OUTCOMES as string[]}::text[])
        ${url === undefined ? sql`` : sql`AND w.proxy_url = ${url}`}
    ), state AS (
      SELECT ports.url, cur.exit_ip AS ip, p.revived_at, p.revived_by_name,
             (SELECT MAX(x.changed_at) FROM fleet_proxy_exit_changes x
              WHERE x.exit = ports.url AND x.old_ip <> x.new_ip) AS moved_at
      FROM ports
      LEFT JOIN LATERAL (${latestExitIpOf(sql, sql`ports.url`)}) cur ON TRUE
      LEFT JOIN fb_proxies p ON p.url = ports.url
    ), failed AS (
      SELECT w.proxy_url AS url, w.account_no, MIN(w.ended_at) AS failed_at
      FROM fb_worker_accounts w JOIN state s ON s.url = w.proxy_url
      WHERE w.outcome = ANY(${FB_FAILED_OUTCOMES as string[]}::text[])
        AND w.ended_at > COALESCE(s.revived_at, '-infinity'::timestamptz)
        AND (s.ip IS NULL OR w.exit_ip = s.ip
          OR (w.exit_ip IS NULL AND w.ended_at > COALESCE(s.moved_at, '-infinity'::timestamptz)))
      GROUP BY w.proxy_url, w.account_no
    ), ranked AS (
      SELECT url, failed_at, ROW_NUMBER() OVER (PARTITION BY url ORDER BY failed_at) AS n FROM failed
    )
    SELECT r.url, MAX(s.ip) AS ip, COUNT(*)::int AS failed,
           MAX(r.failed_at) FILTER (WHERE r.n = ${FB_PROXY_EXHAUSTED_AFTER + 1}) AS exhausted_at,
           MAX(s.revived_at) AS revived_at, MAX(s.revived_by_name) AS revived_by_name
    FROM ranked r JOIN state s ON s.url = r.url
    GROUP BY r.url ORDER BY r.url`;
  return rows.map((r) => ({
    url: r.url,
    ip: r.ip,
    failed: r.failed,
    exhausted: r.failed > FB_PROXY_EXHAUSTED_AFTER,
    exhaustedAt: ms(r.exhausted_at),
    revivedAt: ms(r.revived_at),
    revivedBy: r.revived_by_name,
  }));
}

const portName = (host: string, port: number) => `${host.toLowerCase()}:${port}`;

/** The listed proxies no account may be put on or claimed through right now. */
export async function exhaustedProxyIds(sql: SqlLike): Promise<number[]> {
  const spent = (await proxyMarks(sql)).filter((m) => m.exhausted);
  if (!spent.length) return [];
  const ports = new Set(spent.map((m) => { const { host, port } = hostPort(m.url); return portName(host, port); }));
  const listed = await sql<{ id: number; host: string; port: number }[]>`SELECT id, host, port FROM fleet_proxies`;
  return listed.filter((p) => ports.has(portName(p.host, p.port))).map((p) => p.id);
}

type IpStintRow = {
  worker_id: string; account_no: number; uid: string; email: string | null;
  proxy_url: string | null; proxy_known: boolean; exit_ip: string | null;
  started_at: Date; ended_at: Date | null; outcome: FbStintOutcome | null;
};

/**
 * One group per IP this worker has gone out through, each with every account on
 * that IP from any worker. Its stints with no IP keep to themselves: other
 * workers' unrecorded stints and VMs say nothing about this one. The IP it is on
 * now comes first, then the most recently used.
 */
export async function workerIpGroups(sql: SqlLike, worker: string): Promise<FbIpGroup[]> {
  const rows = await sql<IpStintRow[]>`
    SELECT w.worker_id, w.account_no, w.uid, a.email, w.proxy_url, w.proxy_known, w.exit_ip, w.started_at, w.ended_at, w.outcome
    FROM fb_worker_accounts w LEFT JOIN fb_pool_accounts a ON a.no = w.account_no
    WHERE lower(w.worker_id) = lower(${worker})
      OR (w.exit_ip IS NOT NULL AND EXISTS (
        SELECT 1 FROM fb_worker_accounts mine
        WHERE lower(mine.worker_id) = lower(${worker}) AND mine.proxy_url = w.proxy_url AND mine.exit_ip = w.exit_ip))
    ORDER BY w.started_at DESC, w.id DESC`;
  const urls = [...new Set(rows.flatMap((r) => (r.exit_ip && r.proxy_url ? [r.proxy_url] : [])))];
  const [marks, currents] = await Promise.all([
    urls.length ? proxyMarks(sql) : Promise.resolve([] as FbProxyMark[]),
    urls.length ? sql<{ url: string; exit_ip: string | null }[]>`
      SELECT u.url, cur.exit_ip FROM unnest(${sql.array(urls)}::text[]) u(url)
      LEFT JOIN LATERAL (${latestExitIpOf(sql, sql`u.url`)}) cur ON TRUE` : Promise.resolve([]),
  ]);
  const markOf = new Map(marks.map((m) => [m.url, m]));
  const currentOf = new Map(currents.map((c) => [c.url, c.exit_ip]));
  const isMine = (r: IpStintRow) => r.worker_id.toLowerCase() === worker.toLowerCase();

  const byKey = new Map<string, { group: FbIpGroup; lastMine: number }>();
  for (const r of rows) {
    const kind: FbIpGroup['kind'] = r.exit_ip && r.proxy_url ? 'ip' : r.proxy_known && !r.proxy_url ? 'vm' : 'unrecorded';
    const key = kind === 'ip' ? `${r.proxy_url} ${r.exit_ip}` : kind;
    let entry = byKey.get(key);
    if (!entry) {
      const current = kind === 'ip' ? currentOf.get(r.proxy_url!) : null;
      const status: FbIpGroup['status'] = kind !== 'ip' ? null
        : current !== r.exit_ip ? 'deprecated'
        : markOf.get(r.proxy_url!)?.exhausted ? 'exhausted' : 'active';
      entry = {
        group: { kind, ip: kind === 'ip' ? r.exit_ip : null, proxyUrl: kind === 'ip' ? r.proxy_url : null, status, failed: 0, current: false, stints: [] },
        lastMine: 0,
      };
      byKey.set(key, entry);
    }
    const stint: FbIpStint = {
      workerId: r.worker_id, accountNo: r.account_no, uid: r.uid, email: r.email || null, proxyUrl: r.proxy_url,
      proxyKnown: r.proxy_known, startedAt: r.started_at.getTime(), endedAt: ms(r.ended_at), outcome: r.outcome,
    };
    entry.group.stints.push(stint);
    if (isMine(r)) {
      entry.lastMine = Math.max(entry.lastMine, stint.startedAt);
      if (r.ended_at === null) entry.group.current = true;
    }
  }
  for (const { group } of byKey.values()) {
    // The current IP's count is the one that exhausts it: a revive restarts that.
    group.failed = group.status === 'active' || group.status === 'exhausted'
      ? markOf.get(group.proxyUrl!)?.failed ?? 0
      : new Set(group.stints.filter((s) => s.outcome && FB_FAILED_OUTCOMES.includes(s.outcome)).map((s) => s.accountNo)).size;
  }
  return [...byKey.values()]
    .sort((a, b) => Number(b.group.current) - Number(a.group.current) || b.lastMine - a.lastMine)
    .map((e) => e.group);
}
