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
  await db.sql`DELETE FROM worker_errors`;
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

// What has been going wrong travels with the beat.
describe('LoopRegistry failures', () => {
  it('counts iterations that threw or logged a problem, and resets on a clean one', async () => {
    const registry = new LoopRegistry(() => 1_000);
    const boom = registry.wrap('poll', async () => {
      throw new Error('reddit down');
    });
    const warned = registry.wrap('poll', async () => {
      registry.noteProblem('poll', 'warn', 'blocked by reddit', {status: 403});
      return false;
    });
    const clean = registry.wrap('poll', async () => true);

    await expect(boom()).rejects.toThrow();
    await warned();
    expect(registry.failureSnapshot().poll.consecutiveFailures).toBe(2);
    expect(registry.failureSnapshot().poll.lastError).toBe('blocked by reddit');

    await clean();
    expect(registry.failureSnapshot().poll).toMatchObject({consecutiveFailures: 0, lastError: 'blocked by reddit'});
  });

  it('attributes a problem to the loop its scope starts with, and only that loop', async () => {
    const registry = new LoopRegistry(() => 1_000);
    const evaluate = registry.wrap('evaluate', async () => {
      registry.noteProblem('evaluate:llm', 'warn', 'evaluation failed', {error: '401 Unauthorized'});
      return true;
    });
    const notify = registry.wrap('notify', async () => {
      registry.noteProblem('reactions', 'warn', 'getUpdates failed', {});
      return true;
    });

    await evaluate();
    await notify();

    const failures = registry.failureSnapshot();
    expect(failures.evaluate).toMatchObject({consecutiveFailures: 1, lastError: 'evaluation failed: 401 Unauthorized'});
    expect(failures.evaluate.lastErrorAt).toBe(new Date(1_000).toISOString());
    expect(failures.notify.consecutiveFailures).toBe(0);
    // A per-post warning doesn't change what the ERP's fleet view reads.
    expect(registry.snapshot().evaluate.lastSuccessAt).toBe(new Date(1_000).toISOString());
  });

  it('buffers problem lines up to a cap and counts the rest', () => {
    const registry = new LoopRegistry(() => 1_000);
    for (let i = 0; i < 205; i++) registry.noteProblem('poll', 'warn', `line ${i}`, {});

    const batch = registry.pendingProblems();
    expect(batch.problems).toHaveLength(200);
    expect(batch.dropped).toBe(5);
  });

  it('acknowledges only the batch it was given, keeping lines logged meanwhile', () => {
    const registry = new LoopRegistry(() => 1_000);
    registry.noteProblem('poll', 'warn', 'first', {});
    const batch = registry.pendingProblems();
    registry.noteProblem('poll', 'error', 'second', {});

    registry.ackProblems(batch);

    expect(registry.pendingProblems().problems.map((p) => p.message)).toEqual(['second']);
  });
});

describe('heartbeatOnce problems', () => {
  const deps = (registry: LoopRegistry) => ({
    sql: db.sql,
    workerId: 'w-1',
    role: 'worker' as const,
    startedAt: new Date('2026-08-14T10:00:00Z'),
    registry,
  });

  it('writes loop failures and moves buffered lines into worker_errors', async () => {
    const registry = new LoopRegistry(() => 7_000);
    await registry.wrap('evaluate', async () => {
      registry.noteProblem('evaluate', 'warn', 'evaluation failed', {redditId: 't3_a', error: '401'});
      return true;
    })();

    await heartbeatOnce(deps(registry));

    const [row] = await db.sql<Array<{loop_failures: Record<string, {consecutiveFailures: number}>}>>`
      SELECT loop_failures FROM workers WHERE worker_id = 'w-1'`;
    expect(row!.loop_failures['evaluate']!.consecutiveFailures).toBe(1);
    const errors = await db.sql<Array<{worker_id: string; scope: string; level: string; message: string; fields: unknown; at: Date}>>`
      SELECT worker_id, scope, level, message, fields, at FROM worker_errors`;
    expect(errors).toEqual([{
      worker_id: 'w-1',
      scope: 'evaluate',
      level: 'warn',
      message: 'evaluation failed',
      fields: {redditId: 't3_a', error: '401'},
      at: new Date(7_000),
    }]);
    expect(registry.pendingProblems().problems).toEqual([]);

    await heartbeatOnce(deps(registry));
    expect(await db.sql`SELECT 1 FROM worker_errors`).toHaveLength(1);
  });

  it('records dropped lines as one line saying how many', async () => {
    const registry = new LoopRegistry(() => 7_000);
    for (let i = 0; i < 203; i++) registry.noteProblem('heartbeat', 'error', 'heartbeat iteration failed', {});

    await heartbeatOnce(deps(registry));

    const [dropped] = await db.sql<Array<{fields: {count: number}}>>`
      SELECT fields FROM worker_errors WHERE message LIKE 'problem lines dropped%'`;
    expect(dropped!.fields.count).toBe(3);
    expect(registry.pendingProblems()).toEqual({problems: [], dropped: 0});
  });

  it('keeps the buffer while the beat itself cannot be written', async () => {
    const registry = new LoopRegistry(() => 7_000);
    registry.noteProblem('poll', 'warn', 'reddit fetch failed', {});
    await db.sql.unsafe(`ALTER TABLE workers ADD CONSTRAINT refuse CHECK (worker_id <> 'w-1') NOT VALID`);
    try {
      await expect(heartbeatOnce(deps(registry))).rejects.toThrow();
    } finally {
      await db.sql.unsafe('ALTER TABLE workers DROP CONSTRAINT refuse');
    }

    expect(registry.pendingProblems().problems.map((p) => p.message)).toEqual(['reddit fetch failed']);
  });

  it('still beats, and drops the batch, when only the lines are refused', async () => {
    const registry = new LoopRegistry(() => 7_000);
    registry.noteProblem('refused', 'warn', 'reddit fetch failed', {});
    await db.sql.unsafe(`ALTER TABLE worker_errors ADD CONSTRAINT refuse CHECK (scope <> 'refused')`);
    try {
      await expect(heartbeatOnce(deps(registry))).rejects.toThrow();
    } finally {
      await db.sql.unsafe('ALTER TABLE worker_errors DROP CONSTRAINT refuse');
    }

    expect(await db.sql`SELECT 1 FROM workers WHERE worker_id = 'w-1'`).toHaveLength(1);
    expect(registry.pendingProblems().problems).toEqual([]);
  });

  it('stores a line with a NUL in it', async () => {
    const registry = new LoopRegistry(() => 7_000);
    registry.noteProblem('poll', 'warn', 'bad\u0000byte', {error: 'x\u0000y'});

    await heartbeatOnce(deps(registry));

    const [row] = await db.sql<Array<{message: string; fields: {error: string}}>>`
      SELECT message, fields FROM worker_errors`;
    expect(row).toEqual({message: 'badbyte', fields: {error: 'xy'}});
    expect(registry.failureSnapshot().poll.lastError).toBe('badbyte: xy');
  });
});
