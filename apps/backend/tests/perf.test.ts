import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { getDb, type SqlLike } from '../src/db';
import { flushPerf, percentile, PERF_BUCKETS_MS, purgePerf, recordPerf } from '../src/lib/perf';
import { api, testEnv } from './helpers/app';
import { ALEX, MARCUS, loginAs } from './helpers/auth';
import { resetDb } from './helpers/db';

const sql = () => getDb(testEnv);

type Row = { name: string; count: string; errors: string; sum_ms: number; max_ms: number; buckets: string[]; version: string };
const rowsNamed = (name: string) =>
  sql()<Row[]>`SELECT * FROM perf_rollups WHERE name = ${name} ORDER BY bucket`;

describe('percentile', () => {
  const bucketsWith = (entries: Record<number, number>) => {
    const b = new Array<number>(PERF_BUCKETS_MS.length + 1).fill(0);
    for (const [i, n] of Object.entries(entries)) b[Number(i)] = n;
    return b;
  };

  it('interpolates inside the bucket holding the rank', () => {
    // All 10 in 50–100 ms, so the median is halfway through that bucket.
    expect(percentile(bucketsWith({ 4: 10 }), 100, 0.5)).toBe(75);
  });

  it('walks across buckets', () => {
    // 90 at or under 5 ms and 10 in 1–2.5 s: p95 lands mid-way through the slow one.
    expect(percentile(bucketsWith({ 0: 90, 8: 10 }), 2500, 0.95)).toBe(1750);
  });

  it('caps an estimate at the observed maximum', () => {
    expect(percentile(bucketsWith({ 4: 1 }), 60, 0.99)).toBe(60);
  });

  it('uses the maximum as the top of the overflow bucket', () => {
    expect(percentile(bucketsWith({ [PERF_BUCKETS_MS.length]: 1 }), 90_000, 1)).toBe(90_000);
  });

  it('is zero with no samples', () => {
    expect(percentile(bucketsWith({}), 0, 0.5)).toBe(0);
  });
});

describe('rollup storage', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('merges a later flush into the same hour and release', async () => {
    const now = Date.UTC(2026, 10, 4, 10, 15);
    recordPerf('http', 'GET /merge', 3, { now });
    recordPerf('http', 'GET /merge', 70, { now, error: true });
    await flushPerf(sql());
    recordPerf('http', 'GET /merge', 20_000, { now: now + 60_000 });
    await flushPerf(sql());

    const rows = await rowsNamed('GET /merge');
    expect(rows).toHaveLength(1);
    const [r] = rows;
    expect(Number(r!.count)).toBe(3);
    expect(Number(r!.errors)).toBe(1);
    expect(r!.sum_ms).toBe(20_073);
    expect(r!.max_ms).toBe(20_000);
    expect(r!.buckets.map(Number)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0]);
  });

  it('starts a new row on the next hour', async () => {
    const now = Date.UTC(2026, 10, 4, 10, 59);
    recordPerf('http', 'GET /hour', 1, { now });
    recordPerf('http', 'GET /hour', 1, { now: now + 120_000 });
    await flushPerf(sql());
    expect(await rowsNamed('GET /hour')).toHaveLength(2);
  });

  it('keeps counts through a failed flush', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dead = postgres('postgres://nobody:x@127.0.0.1:1/none', { connect_timeout: 1, max: 1 });
    const now = Date.UTC(2026, 10, 4, 11, 0);
    recordPerf('http', 'GET /retry', 10, { now });

    await expect(flushPerf(dead as unknown as SqlLike)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(await rowsNamed('GET /retry')).toHaveLength(0);

    recordPerf('http', 'GET /retry', 10, { now });
    await flushPerf(sql());
    const [r] = await rowsNamed('GET /retry');
    expect(Number(r!.count)).toBe(2);
    warn.mockRestore();
    await dead.end({ timeout: 1 });
  });

  it('purges only what is past retention', async () => {
    recordPerf('http', 'GET /old', 1, { now: Date.now() - 500 * 86_400_000 });
    recordPerf('http', 'GET /new', 1);
    await flushPerf(sql());
    expect(await purgePerf(sql())).toBe(1);
    expect(await rowsNamed('GET /old')).toHaveLength(0);
    expect(await rowsNamed('GET /new')).toHaveLength(1);
  });
});

describe('request recording', () => {
  beforeAll(async () => {
    await resetDb();
  });

  it('names a request by route pattern, never by the real id', async () => {
    const { token } = await loginAs(ALEX);
    await api('GET', '/api/orders/PO-does-not-exist-777', { token });
    await flushPerf(sql());

    const names = (await sql()<{ name: string }[]>`
      SELECT name FROM perf_rollups WHERE kind = 'http'
    `).map((r) => r.name);
    expect(names).toContain('GET /api/orders/:id');
    expect(names.join()).not.toContain('PO-does-not-exist-777');
  });
});

describe('client timing rollups', () => {
  beforeEach(async () => {
    await resetDb();
  });

  const clientNames = async () => (await sql()<{ name: string }[]>`
    SELECT name FROM perf_rollups WHERE kind = 'client' ORDER BY name
  `).map((r) => r.name);

  const report = async (body: Record<string, unknown>) => {
    const { token } = await loginAs(MARCUS);
    const r = await api('POST', '/api/client-timings', { token, body });
    expect(r.status).toBe(204);
    await flushPerf(sql());
  };

  it('records each metric under shell and page', async () => {
    await report({ loadEvent: 300, ttfb: 20, lcp: 500, navType: 'navigate', shell: 'desktop', page: 'inventory' });
    expect(await clientNames()).toEqual([
      'lcp|desktop|inventory', 'load|desktop|inventory', 'ttfb|desktop|inventory',
    ]);
  });

  it('stores a page or shell outside the closed sets as other and unknown', async () => {
    await report({
      loadEvent: 300, navType: 'reload',
      shell: 'https://evil.example', page: '/purchase-orders/PO-1289?token=abc',
    });
    expect(await clientNames()).toEqual(['load|unknown|other']);
  });

  it('accepts a report from a bundle that predates shell and page', async () => {
    await report({ loadEvent: 300, navType: 'navigate' });
    expect(await clientNames()).toEqual(['load|unknown|other']);
  });

  it('counts a page hidden before its load event as no load, keeping its other metrics', async () => {
    await report({ loadEvent: 0, ttfb: 20, lcp: 500, navType: 'navigate', shell: 'desktop', page: 'home' });
    expect(await clientNames()).toEqual(['lcp|desktop|home', 'ttfb|desktop|home']);
  });

  it('leaves bfcache restores out of the rollups', async () => {
    await report({ loadEvent: 2, navType: 'back_forward', shell: 'desktop', page: 'home' });
    expect(await clientNames()).toEqual([]);
  });

  it('stores no user identity in a rollup', async () => {
    await report({ loadEvent: 300, navType: 'navigate', shell: 'mobile', page: 'home' });
    const rows = await sql()`SELECT * FROM perf_rollups`;
    expect(JSON.stringify(rows)).not.toContain('marcus');
  });
});

describe('/api/perf', () => {
  let managerToken = '';

  beforeAll(async () => {
    await resetDb();
    managerToken = (await loginAs(ALEX)).token;
    const now = Date.now();
    for (const v of [['1.0.0', 40], ['1.1.0', 200]] as const) {
      await sql()`
        INSERT INTO perf_rollups (bucket, version, kind, name, count, errors, sum_ms, max_ms, buckets)
        VALUES (
          date_trunc('hour', ${new Date(now - 3_600_000)}::timestamptz), ${v[0]}, 'http', 'GET /api/orders/:id',
          ${v[1]}, 2, ${v[1] * 60}, 100, ${sql().array([0, 0, 0, 0, v[1], 0, 0, 0, 0, 0, 0, 0, 0])}::bigint[]
        ), (
          date_trunc('hour', ${new Date(now - 3_600_000)}::timestamptz), ${v[0]}, 'http', 'POST /api/fleet/worker/heartbeat',
          5, 0, 50, 10, ${sql().array([0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])}::bigint[]
        )
      `;
    }
    await sql()`
      INSERT INTO perf_rollups (bucket, version, kind, name, count, sum_ms, max_ms, buckets)
      VALUES
        (date_trunc('hour', NOW()), '1.1.0', 'client', 'lcp|desktop|inventory', 4, 2000, 800, ${sql().array([0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0])}::bigint[]),
        (date_trunc('hour', NOW()), '1.1.0', 'client', 'load|desktop|inventory', 5, 1000, 300, ${sql().array([0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0])}::bigint[])
    `;
    // Outside every window, and only reachable by naming its release.
    await sql()`
      INSERT INTO perf_rollups (bucket, version, kind, name, count, sum_ms, max_ms, buckets)
      VALUES (NOW() - INTERVAL '90 days', '0.9.0', 'http', 'GET /ancient', 1, 1, 1, ${sql().array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])}::bigint[])
    `;
  });

  it.each(['/routes', '/loads', '/versions', '/compare?from=1.0.0&to=1.1.0'])(
    'refuses a purchaser at %s', async (path) => {
      const { token } = await loginAs(MARCUS);
      const r = await api('GET', `/api/perf${path}`, { token });
      expect(r.status).toBe(403);
    },
  );

  it('refuses an anonymous caller', async () => {
    expect((await api('GET', '/api/perf/routes')).status).toBe(401);
  });

  it('merges a route across releases, ranks by total time and flags machine traffic', async () => {
    const r = await api<{ routes: { route: string; count: number; errorRate: number; p50: number; machine: boolean }[] }>(
      'GET', '/api/perf/routes?window=7d', { token: managerToken },
    );
    expect(r.status).toBe(200);
    const orders = r.body.routes.find((x) => x.route === 'GET /api/orders/:id')!;
    expect(orders.count).toBe(240);
    expect(orders.errorRate).toBeCloseTo(4 / 240);
    expect(orders.p50).toBe(75);
    expect(orders.machine).toBe(false);
    expect(r.body.routes[0]!.route).toBe('GET /api/orders/:id');
    expect(r.body.routes.find((x) => x.route.includes('heartbeat'))!.machine).toBe(true);
    expect(r.body.routes.find((x) => x.route === 'GET /ancient')).toBeUndefined();
  });

  it('flags only callers no person is waiting on as machine traffic', async () => {
    const names = [
      'GET /api/fleet/hosts/:id/desired', 'POST /api/fleet/hosts/:id/report',
      'POST /api/wechat-market/push/reruns/claim', 'GET /api/health', 'GET /metrics',
      'GET /api/fleet/hosts', 'POST /api/fleet/hosts', 'PUT /api/fleet/hosts/:id',
    ];
    for (const name of names) {
      await sql()`
        INSERT INTO perf_rollups (bucket, version, kind, name, count, sum_ms, max_ms, buckets)
        VALUES (date_trunc('hour', NOW()), 'machine-check', 'http', ${name}, 1, 1, 1,
                ${sql().array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])}::bigint[])`;
    }
    const r = await api<{ routes: { route: string; machine: boolean }[] }>(
      'GET', '/api/perf/routes?window=24h', { token: managerToken },
    );
    await sql()`DELETE FROM perf_rollups WHERE version = 'machine-check'`;
    expect(r.body.routes.filter((x) => names.includes(x.route) && x.machine).map((x) => x.route).sort()).toEqual([
      'GET /api/fleet/hosts/:id/desired', 'GET /api/health', 'GET /metrics',
      'POST /api/fleet/hosts/:id/report', 'POST /api/wechat-market/push/reruns/claim',
    ]);
  });

  it('pivots page loads by shell and page', async () => {
    const r = await api<{ loads: Record<string, unknown>[] }>(
      'GET', '/api/perf/loads?window=24h', { token: managerToken },
    );
    expect(r.body.loads).toEqual([{
      shell: 'desktop', page: 'inventory', count: 5,
      lcpP50: 375, lcpP75: 438, lcpP95: 488,
      loadP75: 213, ttfbP75: null,
    }]);
  });

  it('compares two releases, trustworthy rows first', async () => {
    const r = await api<{ rows: { route: string; lowSample: boolean; from: { count: number }; to: { count: number } }[] }>(
      'GET', '/api/perf/compare?from=1.0.0&to=1.1.0', { token: managerToken },
    );
    expect(r.body.rows.map((x) => [x.route, x.lowSample])).toEqual([
      ['GET /api/orders/:id', false],
      ['POST /api/fleet/worker/heartbeat', true],
    ]);
    expect(r.body.rows[0]!.from.count).toBe(40);
    expect(r.body.rows[0]!.to.count).toBe(200);
  });

  it('refuses a compare without two valid versions', async () => {
    const r = await api('GET', '/api/perf/compare?from=1.0.0', { token: managerToken });
    expect(r.status).toBe(400);
  });

  it('lists releases newest first', async () => {
    const r = await api<{ versions: { version: string }[] }>('GET', '/api/perf/versions', { token: managerToken });
    expect(r.body.versions[r.body.versions.length - 1]!.version).toBe('0.9.0');
  });

  it('breaks a tie in the last hour by the later start, then the higher version', async () => {
    const put = (version: string, hoursAgo: number) => sql()`
      INSERT INTO perf_rollups (bucket, version, kind, name, count, sum_ms, max_ms, buckets)
      VALUES (date_trunc('hour', NOW()) + INTERVAL '2 hours' - make_interval(hours => ${hoursAgo}), ${version}, 'http', 'GET /tie', 1, 1, 1,
              ${sql().array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])}::bigint[])`;
    await put('2.9.0', 5);
    await put('2.9.0', 0);
    await put('2.10.0', 0);
    await put('2.11.0', 0);
    const r = await api<{ versions: { version: string }[] }>('GET', '/api/perf/versions', { token: managerToken });
    await sql()`DELETE FROM perf_rollups WHERE name = 'GET /tie'`;
    expect(r.body.versions.slice(0, 3).map((v) => v.version)).toEqual(['2.11.0', '2.10.0', '2.9.0']);
  });
});
