import { Hono } from 'hono';
import {
  PERF_LOW_SAMPLE, PERF_WINDOWS,
  type PerfCompareRow, type PerfCompareSide, type PerfLoadRow, type PerfRouteRow,
  type PerfVersionRow, type PerfWindow,
} from '@recycle-erp/shared';
import { getDb, type SqlLike } from '../db';
import { percentile, type PerfKind } from '../lib/perf';
import { requireManager } from '../lib/role';
import type { Env, User } from '../types';

// Reads what lib/perf.ts stored. Sorted by total time by default, because a
// route called 40,000 times at 80 ms costs more than one called twice at 8 s,
// and that is the ranking an optimization should start from.

const perf = new Hono<{
  Bindings: Env;
  Variables: { user: User; requestId: string };
}>().use('*', requireManager);

const WINDOW_HOURS: Record<PerfWindow, number> = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };

const parseWindow = (v: string | undefined): PerfWindow =>
  (PERF_WINDOWS as readonly string[]).includes(v ?? '') ? (v as PerfWindow) : '7d';

// Versions come from package.json; anything else cannot match a row.
const VERSION_RE = /^[\w.+-]{1,64}$/;

const isMachineRoute = (route: string): boolean =>
  /^[A-Z]+ \/api\/fleet\/(worker|hosts)(\/|$)/.test(route);

type Merged = { name: string; count: number; errors: number; sum_ms: number; max_ms: number; buckets: number[] };

async function merged(
  sql: SqlLike, kind: PerfKind,
  where: { hours: number } | { version: string },
): Promise<Merged[]> {
  const scope = 'hours' in where
    ? sql`bucket >= NOW() - make_interval(hours => ${where.hours})`
    : sql`version = ${where.version}`;
  return sql<Merged[]>`
    WITH picked AS (
      SELECT name, count, errors, sum_ms, max_ms, buckets
      FROM perf_rollups WHERE kind = ${kind} AND ${scope}
    ),
    totals AS (
      SELECT name, SUM(count)::float8 AS count, SUM(errors)::float8 AS errors,
             SUM(sum_ms)::float8 AS sum_ms, MAX(max_ms)::float8 AS max_ms
      FROM picked GROUP BY name
    ),
    per_bound AS (
      SELECT p.name, u.i, SUM(u.n)::float8 AS n
      FROM picked p, unnest(p.buckets) WITH ORDINALITY AS u(n, i)
      GROUP BY p.name, u.i
    ),
    hist AS (
      SELECT name, array_agg(n ORDER BY i) AS buckets FROM per_bound GROUP BY name
    )
    SELECT t.*, h.buckets FROM totals t JOIN hist h USING (name)
  `;
}

perf.get('/routes', async (c) => {
  const rows = await merged(getDb(c.env), 'http', { hours: WINDOW_HOURS[parseWindow(c.req.query('window'))] });
  const routes: PerfRouteRow[] = rows
    .map((r) => ({
      route: r.name,
      count: r.count,
      errorRate: r.count > 0 ? r.errors / r.count : 0,
      p50: percentile(r.buckets, r.max_ms, 0.5),
      p95: percentile(r.buckets, r.max_ms, 0.95),
      p99: percentile(r.buckets, r.max_ms, 0.99),
      maxMs: Math.round(r.max_ms),
      totalMs: Math.round(r.sum_ms),
      machine: isMachineRoute(r.name),
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
  return c.json({ routes });
});

perf.get('/loads', async (c) => {
  const rows = await merged(getDb(c.env), 'client', { hours: WINDOW_HOURS[parseWindow(c.req.query('window'))] });
  type PageMetrics = { shell: string; page: string; metrics: Map<string, Merged> };
  const byPage = new Map<string, PageMetrics>();
  for (const r of rows) {
    const [metric, shell, page] = r.name.split('|') as [string, string, string];
    const key = `${shell}|${page}`;
    const entry = byPage.get(key) ?? { shell, page, metrics: new Map<string, Merged>() };
    entry.metrics.set(metric, r);
    byPage.set(key, entry);
  }
  const at = (m: Merged | undefined, q: number): number | null =>
    m ? percentile(m.buckets, m.max_ms, q) : null;
  const loads: PerfLoadRow[] = [...byPage.values()]
    .map(({ shell, page, metrics }) => {
      const lcp = metrics.get('lcp');
      const load = metrics.get('load');
      return {
        shell,
        page,
        count: load?.count ?? 0,
        lcpP50: at(lcp, 0.5),
        lcpP75: at(lcp, 0.75),
        lcpP95: at(lcp, 0.95),
        loadP75: at(load, 0.75),
        ttfbP75: at(metrics.get('ttfb'), 0.75),
      };
    })
    .sort((a, b) => b.count - a.count);
  return c.json({ loads });
});

perf.get('/versions', async (c) => {
  const sql = getDb(c.env);
  const versions = await sql<PerfVersionRow[]>`
    SELECT version, MIN(bucket) AS "firstSeen", MAX(bucket) AS "lastSeen", SUM(count)::float8 AS count
    FROM perf_rollups WHERE kind = 'http'
    GROUP BY version ORDER BY MAX(bucket) DESC LIMIT 50
  `;
  return c.json({ versions });
});

const side = (m: Merged | undefined): PerfCompareSide | null =>
  m ? { count: m.count, p50: percentile(m.buckets, m.max_ms, 0.5), p95: percentile(m.buckets, m.max_ms, 0.95) } : null;

perf.get('/compare', async (c) => {
  const from = c.req.query('from') ?? '';
  const to = c.req.query('to') ?? '';
  if (!VERSION_RE.test(from) || !VERSION_RE.test(to)) {
    return c.json({ error: 'from and to must name a version' }, 400);
  }
  const sql = getDb(c.env);
  const [before, after] = await Promise.all([
    merged(sql, 'http', { version: from }),
    merged(sql, 'http', { version: to }),
  ]);
  const beforeBy = new Map(before.map((r) => [r.name, r]));
  const afterBy = new Map(after.map((r) => [r.name, r]));
  const rows: PerfCompareRow[] = [...new Set([...beforeBy.keys(), ...afterBy.keys()])]
    .map((route) => {
      const a = beforeBy.get(route);
      const b = afterBy.get(route);
      return {
        route,
        from: side(a),
        to: side(b),
        lowSample: (a?.count ?? 0) < PERF_LOW_SAMPLE || (b?.count ?? 0) < PERF_LOW_SAMPLE,
        machine: isMachineRoute(route),
      };
    })
    // Trustworthy rows first, then the largest p95 regression among them.
    .sort((x, y) =>
      Number(x.lowSample) - Number(y.lowSample)
      || ((y.to?.p95 ?? 0) - (y.from?.p95 ?? 0)) - ((x.to?.p95 ?? 0) - (x.from?.p95 ?? 0)));
  return c.json({ from, to, rows });
});

export default perf;
