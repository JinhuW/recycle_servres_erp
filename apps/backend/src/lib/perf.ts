import type { SqlLike } from '../db';
import { log, releaseVersion } from './log';

// The durable half of the timing data. metrics.ts serves the live view, which
// a deploy wipes; this keeps hourly histograms per release in Postgres, so a
// change can be judged against the release before it.

// Stored rows are summed index by index, so changing these bounds makes existing
// rows unreadable. A new set of bounds needs a migration that rewrites them.
export const PERF_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000] as const;

export type PerfKind = 'http' | 'client';

type Cell = {
  bucket: string;
  version: string;
  kind: PerfKind;
  name: string;
  count: number;
  errors: number;
  sum_ms: number;
  max_ms: number;
  buckets: number[];
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const FLUSH_MS = 60_000;
const RETENTION_DAYS = 400;

const pending = new Map<string, Cell>();

function emptyCell(bucket: string, version: string, kind: PerfKind, name: string): Cell {
  return {
    bucket, version, kind, name,
    count: 0, errors: 0, sum_ms: 0, max_ms: 0,
    buckets: new Array<number>(PERF_BUCKETS_MS.length + 1).fill(0),
  };
}

function cellFor(bucket: string, version: string, kind: PerfKind, name: string): Cell {
  const key = `${bucket}\n${version}\n${kind}\n${name}`;
  let cell = pending.get(key);
  if (!cell) {
    cell = emptyCell(bucket, version, kind, name);
    pending.set(key, cell);
  }
  return cell;
}

export function recordPerf(
  kind: PerfKind, name: string, ms: number,
  opts: { error?: boolean; now?: number } = {},
): void {
  const now = opts.now ?? Date.now();
  const bucket = new Date(now - now % HOUR_MS).toISOString();
  const cell = cellFor(bucket, releaseVersion(), kind, name);
  cell.count += 1;
  if (opts.error) cell.errors += 1;
  cell.sum_ms += ms;
  cell.max_ms = Math.max(cell.max_ms, ms);
  const i = PERF_BUCKETS_MS.findIndex((bound) => ms <= bound);
  cell.buckets[i === -1 ? PERF_BUCKETS_MS.length : i]! += 1;
}

/** Never throws: timing data must not be able to take a request or a boot down. */
export async function flushPerf(sql: SqlLike): Promise<void> {
  if (pending.size === 0) return;
  const rows = [...pending.values()];
  pending.clear();
  try {
    await sql`
      INSERT INTO perf_rollups (bucket, version, kind, name, count, errors, sum_ms, max_ms, buckets)
      SELECT r.bucket, r.version, r.kind, r.name, r.count, r.errors, r.sum_ms, r.max_ms, r.buckets
      FROM jsonb_to_recordset(${sql.json(rows as never)}) AS r(
        bucket TIMESTAMPTZ, version TEXT, kind TEXT, name TEXT,
        count BIGINT, errors BIGINT, sum_ms DOUBLE PRECISION, max_ms DOUBLE PRECISION,
        buckets BIGINT[]
      )
      ON CONFLICT (bucket, version, kind, name) DO UPDATE SET
        count   = perf_rollups.count + EXCLUDED.count,
        errors  = perf_rollups.errors + EXCLUDED.errors,
        sum_ms  = perf_rollups.sum_ms + EXCLUDED.sum_ms,
        max_ms  = GREATEST(perf_rollups.max_ms, EXCLUDED.max_ms),
        buckets = ARRAY(SELECT a + b FROM unnest(perf_rollups.buckets, EXCLUDED.buckets) AS t(a, b))
    `;
  } catch (e) {
    // The statement is atomic, so nothing landed: all of it goes back for the
    // next tick, merged with whatever arrived meanwhile.
    for (const row of rows) {
      const cell = cellFor(row.bucket, row.version, row.kind, row.name);
      cell.count += row.count;
      cell.errors += row.errors;
      cell.sum_ms += row.sum_ms;
      cell.max_ms = Math.max(cell.max_ms, row.max_ms);
      row.buckets.forEach((n, i) => { cell.buckets[i]! += n; });
    }
    log.warn('perf rollup flush failed', e);
  }
}

export async function purgePerf(sql: SqlLike, retentionDays = RETENTION_DAYS): Promise<number> {
  const r = await sql`
    DELETE FROM perf_rollups WHERE bucket < NOW() - make_interval(days => ${retentionDays})
  `;
  return r.count;
}

export function startPerfLoop(sql: SqlLike): { stop(): void } {
  const flush = setInterval(() => { void flushPerf(sql); }, FLUSH_MS);
  const purge = () => {
    purgePerf(sql).catch((e) => log.error('perf rollup purge failed', e));
  };
  const first = setTimeout(purge, 60_000);
  const daily = setInterval(purge, DAY_MS);
  flush.unref?.();
  first.unref?.();
  daily.unref?.();
  return { stop() { clearInterval(flush); clearTimeout(first); clearInterval(daily); } };
}

/**
 * The value at quantile `q`, interpolated inside its histogram bucket, so it is
 * an estimate only as fine as the bounds. `maxMs` caps it and stands in as the
 * upper bound of the overflow bucket.
 */
export function percentile(buckets: readonly number[], maxMs: number, q: number): number {
  const total = buckets.reduce((sum, n) => sum + n, 0);
  if (total === 0) return 0;
  const rank = q * total;
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    const n = buckets[i]!;
    if (n > 0 && seen + n >= rank) {
      const lower = i === 0 ? 0 : PERF_BUCKETS_MS[i - 1]!;
      const upper = PERF_BUCKETS_MS[i] ?? Math.max(maxMs, lower);
      return Math.round(Math.min(lower + ((rank - seen) / n) * (upper - lower), maxMs));
    }
    seen += n;
  }
  return Math.round(maxMs);
}
