import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from './helpers/db';
import { purgeHistory } from '../src/fleet/scheduler';
import { loadSettings, readSettingsPatch } from '../src/fleet/cities';

// The hourly purge of finished task history: rows written straight to the
// tables with a pinned clock, purgeHistory() called, what is left read back.

const DAY = 86_400_000;
const NOW = new Date('2026-10-24T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

type Spec = {
  city?: string; item?: string; kind?: 'search' | 'verify-slug' | 'probe';
  state: 'ready' | 'leased' | 'done' | 'cancelled' | 'expired';
  age: number; account?: number | null; event?: Record<string, unknown>;
};

async function task(s: Spec): Promise<string> {
  const db = getTestDb();
  const when = daysAgo(s.age);
  const terminal = !['ready', 'leased'].includes(s.state);
  const leased = s.state !== 'ready' && s.state !== 'cancelled';
  const [row] = await db<{ id: string }[]>`
    INSERT INTO fleet_tasks (city, item, kind, due_at, state, account_no, epoch, leased_at, lease_expires_at, done_at, reason, worker_id)
    VALUES (${s.city ?? 'houston'}, ${s.item ?? 'server_ram'}, ${s.kind ?? 'search'}, ${when}, ${s.state},
            ${leased ? (s.account ?? null) : null}, ${leased ? 1 : null},
            ${leased ? when : null}, ${leased ? new Date(when.getTime() + 1_800_000) : null},
            ${terminal ? when : null}, 'cadence', ${leased ? 'lab-1' : null})
    RETURNING id`;
  await db`
    INSERT INTO fleet_task_events (task_id, worker_id, kind, detail, at)
    VALUES (${row.id}, 'lab-1', ${s.event ? 'finished' : 'handed'}, ${db.json((s.event ?? {}) as never)}, ${when})`;
  return row.id;
}

async function catalog() {
  const db = getTestDb();
  for (const slug of ['houston', 'dallas']) {
    await db`INSERT INTO fleet_cities (slug, name, enabled, verified_at, verified_as) VALUES (${slug}, ${slug}, TRUE, ${NOW}, 'imported')`;
  }
  for (const name of ['server_ram', 'enterprise_ssd']) await db`INSERT INTO fleet_items (name, phrases) VALUES (${name}, '["x"]')`;
}

const ids = async () => (await getTestDb()<{ id: string }[]>`SELECT id FROM fleet_tasks ORDER BY id`).map((r) => r.id);
const count = async (table: 'fleet_task_events' | 'fleet_task_attempts', taskIds: string[]) => {
  const [{ n }] = await getTestDb()<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM ${getTestDb()(table)} WHERE task_id = ANY(${taskIds}::bigint[])`;
  return n;
};
const setting = (key: string, value: number) =>
  getTestDb()`INSERT INTO fleet_settings (key, value) VALUES (${key}, ${getTestDb().json(value)})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;

describe('purgeHistory', () => {
  beforeEach(async () => { await resetDb(); await catalog(); });

  it('deletes old terminal tasks with their events and attempts, and nothing else', async () => {
    const newest = await task({ state: 'done', age: 100 });          // the pair's newest search: kept
    const older = await task({ state: 'done', age: 200 });           // gone
    const cancelled = await task({ state: 'cancelled', age: 120, city: 'dallas' });
    const expired = await task({ state: 'expired', age: 95, city: 'dallas', account: null });
    const recent = await task({ state: 'done', age: 10, city: 'dallas' });
    const fresher = await task({ state: 'done', age: 89, city: 'dallas', item: 'enterprise_ssd' });
    const ready = await task({ state: 'ready', age: 300, city: 'dallas', item: 'enterprise_ssd' });
    const leased = await task({ state: 'leased', age: 300, item: 'enterprise_ssd' });
    const gone = [older, cancelled, expired];
    expect(await count('fleet_task_attempts', [older])).toBe(1);

    const r = await purgeHistory(getTestDb(), NOW);
    expect(r).toEqual({ tasks: 3, events: 3, attempts: 2, days: 90 });
    expect(await ids()).toEqual([newest, recent, fresher, ready, leased].sort((a, b) => Number(a) - Number(b)));
    expect(await count('fleet_task_events', gone)).toBe(0);
    expect(await count('fleet_task_attempts', gone)).toBe(0);
    expect(await count('fleet_task_events', [newest, recent, fresher, ready, leased])).toBe(5);

    // Nothing left to do: a second run deletes nothing.
    expect(await purgeHistory(getTestDb(), NOW)).toEqual({ tasks: 0, events: 0, attempts: 0, days: 90 });
  });

  it('keeps the newest finished search per city and item, and each city\'s latest slug verdict', async () => {
    const pairs = [
      await task({ state: 'done', age: 400 }),
      await task({ state: 'done', age: 300, item: 'enterprise_ssd' }),
    ];
    await task({ state: 'done', age: 500 });
    // An old probe or an expired search is never the pair's last done.
    await task({ state: 'done', age: 350, kind: 'probe', account: null });
    await task({ state: 'expired', age: 200 });

    const oldVerdict = await task({ state: 'done', age: 400, kind: 'verify-slug', city: 'dallas', event: { matches: true } });
    const verdict = await task({ state: 'done', age: 300, kind: 'verify-slug', city: 'dallas', event: { matches: true } });
    // A later check with no verdict (a wall) does not replace it.
    const wall = await task({ state: 'done', age: 200, kind: 'verify-slug', city: 'dallas', event: { matches: false, wall: 'login' } });

    await purgeHistory(getTestDb(), NOW);
    expect(await ids()).toEqual([...pairs, verdict]);
    expect(await count('fleet_task_events', [verdict])).toBe(1);
    expect(await count('fleet_task_events', [oldVerdict, wall])).toBe(0);
  });

  it('follows retention_days, and never keeps less than familiar_days', async () => {
    await task({ state: 'done', age: 1 });
    const mid = await task({ state: 'done', age: 50, city: 'dallas' });
    await task({ state: 'done', age: 40, city: 'dallas' });

    await setting('retention_days', 60);
    expect((await purgeHistory(getTestDb(), NOW))?.tasks).toBe(0);
    await setting('retention_days', 30);
    await setting('familiar_days', 60);
    expect(await purgeHistory(getTestDb(), NOW)).toMatchObject({ tasks: 0, days: 60 });
    await setting('familiar_days', 7);
    expect(await purgeHistory(getTestDb(), NOW)).toMatchObject({ tasks: 1, days: 30 });
    expect(await ids()).not.toContain(mid);
  });

  it('works through a backlog in batches, oldest first', async () => {
    const old: string[] = [];
    for (let i = 0; i < 7; i++) old.push(await task({ state: 'cancelled', age: 200 - i }));
    await task({ state: 'done', age: 1 });
    expect((await purgeHistory(getTestDb(), NOW, 3))?.tasks).toBe(3);
    const left = await ids();
    expect(left).not.toContain(old[0]);
    expect(left).toContain(old[3]);
    expect((await purgeHistory(getTestDb(), NOW, 3))?.tasks).toBe(3);
    expect((await purgeHistory(getTestDb(), NOW, 3))?.tasks).toBe(1);
    expect((await purgeHistory(getTestDb(), NOW, 3))?.tasks).toBe(0);
    expect(await ids()).toHaveLength(1);
  });

  it('lets one instance purge at a time; two at once delete each row once', async () => {
    for (let i = 0; i < 20; i++) await task({ state: 'expired', age: 100 + i, account: null });
    const db = getTestDb();

    // Another instance holds the purge: this one stands aside.
    await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended('fleet:purge', 0))`;
      expect(await purgeHistory(db, NOW)).toBeNull();
    });

    const runs = await Promise.all([purgeHistory(db, NOW, 15), purgeHistory(db, NOW, 15)]);
    const deleted = runs.reduce((n, r) => n + (r?.tasks ?? 0), 0);
    expect(deleted).toBeLessThanOrEqual(20);
    const again = await purgeHistory(db, NOW, 15);
    expect(deleted + (again?.tasks ?? 0)).toBe(20);
    expect(await ids()).toEqual([]);
  });
});

describe('retention_days setting', () => {
  beforeEach(async () => { await resetDb(); });

  it('defaults to 90 and accepts 30 to 730 whole days', async () => {
    expect((await loadSettings(getTestDb())).retention_days).toBe(90);
    expect(readSettingsPatch({ retention_days: 30 })).toEqual({ retention_days: 30 });
    expect(readSettingsPatch({ retention_days: 730 })).toEqual({ retention_days: 730 });
    for (const bad of [29, 731, 45.5, '90']) {
      expect(readSettingsPatch({ retention_days: bad })).toMatchObject({ status: 422, body: { error: 'bad_request' } });
    }
  });
});
