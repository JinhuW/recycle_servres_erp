import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {createLogger} from '../src/logger.ts';
import {FAILING_AFTER, watchOnce, type RelayAlert} from '../src/loops/watch.ts';
import {createTestDb, type TestDb} from './helpers/db.ts';

// The api's watch turns the fleet's heartbeats into ops alerts.

let db: TestDb;
let posted: RelayAlert[];
let relayStatus: number;

beforeAll(async () => {
  db = await createTestDb('watch');
}, 60_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.sql`DELETE FROM workers`;
  await db.sql`DELETE FROM worker_errors`;
  await db.sql`DELETE FROM watch_alerts`;
  posted = [];
  relayStatus = 204;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer relay-token');
    posted.push(JSON.parse(String(init.body)));
    return new Response(null, {status: relayStatus});
  }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const watch = () => watchOnce({
  sql: db.sql,
  logger: createLogger('api-1', 'error'),
  selfId: 'api-1',
  relayUrl: 'https://relay.example/alert',
  relayToken: 'relay-token',
});

async function worker(id: string, opts: {silentS?: number; role?: string; failures?: Record<string, unknown>} = {}) {
  await db.sql`
    INSERT INTO workers (worker_id, role, started_at, last_heartbeat_at, loops, loop_failures)
    VALUES (${id}, ${opts.role ?? 'worker'}, NOW(), NOW() - make_interval(secs => ${opts.silentS ?? 0}),
            '{}'::jsonb, ${db.sql.json((opts.failures ?? {}) as never)})
    ON CONFLICT (worker_id) DO UPDATE
      SET last_heartbeat_at = EXCLUDED.last_heartbeat_at, loop_failures = EXCLUDED.loop_failures`;
}

const failing = (n: number, lastError = 'evaluation failed: 401 Unauthorized') => ({
  evaluate: {consecutiveFailures: n, lastError, lastErrorAt: '2026-10-23T19:00:00.000Z'},
});

describe('worker down', () => {
  it('raises once for a worker silent for ten minutes, then says it is back', async () => {
    await worker('w-1', {silentS: 11 * 60});

    await watch();
    await watch();

    expect(posted).toEqual([{
      topic: 'reddit_workers',
      status: 'firing',
      title: 'Reddit worker down: w-1',
      lines: ['No heartbeat for 11 min.'],
    }]);

    await worker('w-1', {silentS: 0});
    await watch();

    expect(posted[1]).toMatchObject({status: 'resolved', title: 'Reddit worker back: w-1'});
    expect(await db.sql`SELECT 1 FROM watch_alerts`).toHaveLength(0);
  });

  it('says a down worker is gone when its row is removed', async () => {
    await worker('w-1', {silentS: 11 * 60});
    await watch();
    await db.sql`DELETE FROM workers`;

    await watch();

    expect(posted[1]).toMatchObject({status: 'resolved', title: 'Reddit worker gone: w-1'});
  });

  it('leaves a merely stale worker and its own api row alone', async () => {
    await worker('w-1', {silentS: 5 * 60});
    await worker('api-1', {silentS: 60 * 60, role: 'api'});

    await watch();

    expect(posted).toEqual([]);
  });
});

describe('failing loop', () => {
  it(`raises at ${FAILING_AFTER} failed iterations in a row with the last error, and resolves on a clean one`, async () => {
    await worker('w-1', {failures: failing(FAILING_AFTER - 1)});
    await watch();
    expect(posted).toEqual([]);

    await worker('w-1', {failures: failing(FAILING_AFTER)});
    await watch();
    expect(posted[0]).toEqual({
      topic: 'reddit_workers',
      status: 'firing',
      title: 'Reddit evaluate failing on w-1',
      lines: ['3 iterations in a row.', 'Last error: evaluation failed: 401 Unauthorized', 'At 2026-10-23T19:00:00.000Z'],
    });

    await worker('w-1', {failures: failing(0)});
    await watch();
    expect(posted[1]).toMatchObject({status: 'resolved', title: 'Reddit evaluate recovered on w-1'});
  });

  it('does not call a failing loop recovered when its worker has died', async () => {
    await worker('w-1', {failures: failing(5)});
    await watch();
    await worker('w-1', {silentS: 11 * 60, failures: failing(5)});

    await watch();

    expect(posted.map((p) => p.title)).toEqual([
      'Reddit evaluate failing on w-1',
      'Reddit worker down: w-1',
    ]);
  });
});

describe('delivery', () => {
  it('retries an alert the relay refused, and does not page again after a restart', async () => {
    await worker('w-1', {silentS: 11 * 60});
    relayStatus = 502;
    await watch();
    expect(await db.sql`SELECT 1 FROM watch_alerts`).toHaveLength(0);

    relayStatus = 204;
    await watch();
    await watch();

    expect(posted.map((p) => p.title)).toEqual([
      'Reddit worker down: w-1',
      'Reddit worker down: w-1',
    ]);
  });
});

describe('error digest', () => {
  async function line(workerId: string, scope: string, message: string, fields: object = {}, daysAgo = 0) {
    await db.sql`
      INSERT INTO worker_errors (worker_id, scope, level, message, fields, at)
      VALUES (${workerId}, ${scope}, 'warn', ${message}, ${db.sql.json(fields as never)},
              NOW() - make_interval(days => ${daysAgo}))`;
  }

  it('sends every new line once, grouped by what it says', async () => {
    await line('w-2', 'evaluate', 'evaluation failed', {redditId: 't3_a', error: '401'});
    await line('w-1', 'evaluate', 'evaluation failed', {redditId: 't3_b', error: '401'});
    await line('w-1', 'reactions', 'getUpdates failed', {error: 'fetch failed'});

    await watch();
    await watch();

    expect(posted).toEqual([{
      topic: 'reddit_errors',
      status: 'info',
      title: 'Reddit: 3 warn/error lines',
      lines: [
        '2× evaluate · evaluation failed: 401 — w-1, w-2',
        '1× reactions · getUpdates failed: fetch failed — w-1',
      ],
    }]);
    expect(await db.sql`SELECT 1 FROM worker_errors WHERE sent_at IS NULL`).toHaveLength(0);
  });

  it('keeps lines unsent while the relay refuses them', async () => {
    await line('w-1', 'poll', 'blocked by reddit');
    relayStatus = 502;

    await watch();

    expect(await db.sql`SELECT 1 FROM worker_errors WHERE sent_at IS NULL`).toHaveLength(1);
  });

  it('deletes lines older than a week', async () => {
    await line('w-1', 'poll', 'old', {}, 8);
    await db.sql`UPDATE worker_errors SET sent_at = NOW()`;

    await watch();

    expect(await db.sql`SELECT 1 FROM worker_errors`).toHaveLength(0);
  });
});
