import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {heartbeatOnce, LoopRegistry, removeWorker} from '../src/heartbeat.ts';
import {createTestDb, type TestDb} from './helpers/db.ts';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb('heartbeat');
}, 60_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.sql`DELETE FROM workers`;
});

interface WorkerRow {
  worker_id: string;
  role: string;
  started_at: Date;
  last_heartbeat_at: Date;
  loops: Record<string, {lastSuccessAt: string | null; lastWorkAt: string | null}>;
}

async function workerRows(): Promise<WorkerRow[]> {
  return db.sql<WorkerRow[]>`
    SELECT worker_id, role, started_at, last_heartbeat_at, loops
      FROM workers ORDER BY worker_id`;
}

describe('LoopRegistry', () => {
  it('starts every loop with null timestamps', () => {
    const registry = new LoopRegistry();

    expect(registry.snapshot()).toEqual({
      poll: {lastSuccessAt: null, lastWorkAt: null},
      evaluate: {lastSuccessAt: null, lastWorkAt: null},
      notify: {lastSuccessAt: null, lastWorkAt: null},
    });
  });

  it('records a success timestamp, and a work timestamp only when work was done', () => {
    let clock = 1_000;
    const registry = new LoopRegistry(() => clock);

    registry.recordSuccess('poll', false);
    clock = 2_000;
    registry.recordSuccess('poll', true);

    const snapshot = registry.snapshot();
    expect(snapshot.poll.lastSuccessAt).toBe(new Date(2_000).toISOString());
    expect(snapshot.poll.lastWorkAt).toBe(new Date(2_000).toISOString());
    expect(snapshot.evaluate).toEqual({lastSuccessAt: null, lastWorkAt: null});
  });

  it('keeps the older work timestamp when a later iteration found nothing', () => {
    let clock = 1_000;
    const registry = new LoopRegistry(() => clock);

    registry.recordSuccess('evaluate', true);
    clock = 5_000;
    registry.recordSuccess('evaluate', false);

    const snapshot = registry.snapshot();
    expect(snapshot.evaluate.lastSuccessAt).toBe(new Date(5_000).toISOString());
    expect(snapshot.evaluate.lastWorkAt).toBe(new Date(1_000).toISOString());
  });

  it('wrap() records only iterations that resolve', async () => {
    let clock = 1_000;
    const registry = new LoopRegistry(() => clock);

    const ok = registry.wrap('notify', async () => true);
    const boom = registry.wrap('poll', async () => {
      throw new Error('reddit down');
    });

    await expect(ok()).resolves.toBe(true);
    await expect(boom()).rejects.toThrow('reddit down');

    const snapshot = registry.snapshot();
    expect(snapshot.notify.lastSuccessAt).toBe(new Date(1_000).toISOString());
    expect(snapshot.poll.lastSuccessAt).toBeNull();
  });
});

describe('heartbeatOnce', () => {
  it('registers a new worker with its role, start time and loop snapshot', async () => {
    const registry = new LoopRegistry(() => 42_000);
    registry.recordSuccess('poll', true);
    const startedAt = new Date('2026-08-14T10:00:00Z');

    await heartbeatOnce({
      sql: db.sql,
      workerId: 'w-1',
      role: 'worker',
      startedAt,
      registry,
    });

    const rows = await workerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({worker_id: 'w-1', role: 'worker'});
    expect(rows[0]!.started_at.toISOString()).toBe(startedAt.toISOString());
    expect(rows[0]!.loops['poll']!.lastWorkAt).toBe(new Date(42_000).toISOString());
  });

  it('updates the heartbeat and loop snapshot on repeat calls instead of inserting', async () => {
    let clock = 10_000;
    const registry = new LoopRegistry(() => clock);
    const deps = {
      sql: db.sql,
      workerId: 'w-1',
      role: 'worker' as const,
      startedAt: new Date('2026-08-14T10:00:00Z'),
      registry,
    };

    await heartbeatOnce(deps);
    const [first] = await workerRows();

    clock = 99_000;
    registry.recordSuccess('evaluate', true);
    await heartbeatOnce(deps);

    const rows = await workerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last_heartbeat_at.getTime())
      .toBeGreaterThanOrEqual(first!.last_heartbeat_at.getTime());
    expect(rows[0]!.loops['evaluate']!.lastSuccessAt).toBe(new Date(99_000).toISOString());
  });

  it('reports no work so the heartbeat loop always idles', async () => {
    const didWork = await heartbeatOnce({
      sql: db.sql,
      workerId: 'w-1',
      role: 'api',
      startedAt: new Date(),
      registry: new LoopRegistry(),
    });

    expect(didWork).toBe(false);
  });
});

describe('removeWorker', () => {
  it('deletes the row so a cleanly-stopped worker does not linger as dead', async () => {
    await heartbeatOnce({
      sql: db.sql,
      workerId: 'w-gone',
      role: 'worker',
      startedAt: new Date(),
      registry: new LoopRegistry(),
    });

    await removeWorker(db.sql, 'w-gone');

    expect(await workerRows()).toHaveLength(0);
  });

  it('is a no-op for an unknown worker', async () => {
    await expect(removeWorker(db.sql, 'never-existed')).resolves.toBeUndefined();
  });
});
