import { beforeEach, describe, expect, it } from 'vitest';
import type { FleetCityListed, FleetItem, FleetSettings, FleetTask, FleetTaskLog, RoundStartAnswer } from '@recycle-erp/shared';
import { getTestDb, resetDb } from './helpers/db';
import { api } from './helpers/app';
import { ALEX, MARCUS, loginAs } from './helpers/auth';

// The manager routes over the catalog and the queue, driven through the app
// as the Cities and Queue tabs will drive them.

const ITEMS = [
  { name: 'server_ram', phrases: ['server ram memory'], filters: { keywords: ['ram'] } },
  { name: 'enterprise_ssd', phrases: ['ssd lot'] },
];

let token: string;

async function manager() {
  ({ token } = await loginAs(ALEX));
  await api('PUT', '/api/fleet/items', { token, body: ITEMS });
}

const addCity = (body: Record<string, unknown>) => api<FleetCityListed>('POST', '/api/fleet/cities', { token, body });
const putCity = (slug: string, body: Record<string, unknown>) => api<FleetCityListed>('PUT', `/api/fleet/cities/${slug}`, { token, body });
const tasksWhere = async (qs: string) => (await api<FleetTask[]>('GET', `/api/fleet/tasks?${qs}`, { token })).body;

describe('scope', () => {
  beforeEach(async () => { await resetDb(); });

  it('every route is manager-only', async () => {
    const { token: purchaser } = await loginAs(MARCUS);
    for (const [method, path] of [
      ['GET', '/api/fleet/cities'], ['POST', '/api/fleet/cities'], ['PUT', '/api/fleet/cities/x'], ['DELETE', '/api/fleet/cities/x'],
      ['GET', '/api/fleet/items'], ['PUT', '/api/fleet/items'], ['GET', '/api/fleet/settings'], ['PUT', '/api/fleet/settings'],
      ['GET', '/api/fleet/tasks'], ['POST', '/api/fleet/tasks'], ['POST', '/api/fleet/round/start'], ['GET', '/api/fleet/city-log'],
    ] as const) {
      expect((await api(method, path)).status, `${method} ${path} anonymous`).toBe(401);
      expect((await api(method, path, { token: purchaser })).status, `${method} ${path} purchaser`).toBe(403);
    }
  });
});

describe('cities', () => {
  beforeEach(async () => { await resetDb(); await manager(); });

  it('adds a city disabled, with a verify-slug task on the first item', async () => {
    const r = await addCity({ slug: 'Houston', name: ' Houston, TX ', radius_km: 100, region: 'South Central' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ slug: 'houston', name: 'Houston, TX', radius_km: 100, region: 'South Central', enabled: false, verified_at: null, pinned: false, per_day: null });
    expect(r.body.open_tasks).toHaveLength(1);
    expect(r.body.open_tasks[0]).toMatchObject({ city: 'houston', item: 'enterprise_ssd', kind: 'verify-slug', priority: 50, reason: 'verify', state: 'ready' });
    expect(r.body.last_done_at).toEqual({});

    const list = await api<{ cities: FleetCityListed[] }>('GET', '/api/fleet/cities', { token });
    expect(list.body.cities.map((c) => c.slug)).toEqual(['houston']);
    expect(list.body.cities[0].open_tasks[0].kind).toBe('verify-slug');
  });

  it('refuses a bad slug, a missing name, a radius out of range and a duplicate', async () => {
    expect((await addCity({ slug: 'Houston TX', name: 'x' })).status).toBe(422);
    expect((await addCity({ slug: 'houston', name: '' })).status).toBe(422);
    expect((await addCity({ slug: 'houston', name: 'Houston', radius_km: 0 })).status).toBe(422);
    expect((await addCity({ slug: 'houston', name: 'Houston' })).status).toBe(201);
    const dup = await addCity({ slug: 'houston', name: 'Houston again' });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ error: 'exists' });
  });

  it('will not enable an unverified city, but override_verify does and the queue follows at once', async () => {
    await addCity({ slug: 'houston', name: 'Houston' });
    const refused = await putCity('houston', { enabled: true });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'unverified' });

    const r = await putCity('houston', { override_verify: true, per_day: 2, pinned: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, verified_as: 'override', per_day: 2, pinned: true, disabled_at: null });
    expect(r.body.verified_at).not.toBeNull();
    // The verify task is gone; a search task per item took its place, due now.
    expect(r.body.open_tasks.map((t) => `${t.item}/${t.kind}/${t.reason}`).sort())
      .toEqual(['enterprise_ssd/search/added', 'server_ram/search/added']);
    expect(await tasksWhere('state=cancelled&city=houston')).toHaveLength(1);
  });

  it('disabling cancels the waiting tasks; enabling a verified city brings them back', async () => {
    await addCity({ slug: 'houston', name: 'Houston' });
    await putCity('houston', { override_verify: true });
    const off = await putCity('houston', { enabled: false });
    expect(off.body.enabled).toBe(false);
    expect(off.body.disabled_at).not.toBeNull();
    expect(off.body.open_tasks).toEqual([]);
    const on = await putCity('houston', { enabled: true });
    expect(on.body).toMatchObject({ enabled: true, disabled_at: null });
    expect(on.body.open_tasks).toHaveLength(2);
  });

  it('enables a city only on a matching verdict; a mismatch needs override_verify, and reverify checks again', async () => {
    const db = getTestDb();
    await addCity({ slug: 'springfield', name: 'Springfield, IL' });
    const verdict = async (matches: boolean | null, location: string) => {
      const [t] = await db<{ id: string }[]>`SELECT id FROM fleet_tasks WHERE city = 'springfield' AND kind = 'verify-slug' AND state IN ('ready','leased')`;
      await db`INSERT INTO fleet_task_events (task_id, worker_id, kind, detail)
               VALUES (${t.id}, 'lab-1', 'finished', ${db.json(matches === null ? { location } : { matches, location })})`;
      await db`UPDATE fleet_tasks SET state = 'done', done_at = NOW() WHERE id = ${t.id}`;
      await db`UPDATE fleet_cities SET verified_at = NOW(), verified_as = ${location}, enabled = ${matches === true} WHERE slug = 'springfield'`;
    };
    await verdict(false, 'Springfield, MO');
    const refused = await putCity('springfield', { enabled: true });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'unverified' });
    expect((refused.body as unknown as { detail: string }).detail).toContain('Springfield, MO');

    // Back to a fresh check: unverified, disabled, a new verify-slug task.
    expect((await putCity('springfield', { reverify: true, override_verify: true })).status).toBe(422);
    const again = await putCity('springfield', { reverify: true });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ enabled: false, verified_at: null, verified_as: null, disabled_at: null });
    expect(again.body.open_tasks.map((t) => t.kind)).toEqual(['verify-slug']);

    await verdict(true, 'Springfield, IL');
    await putCity('springfield', { enabled: false });
    const on = await putCity('springfield', { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);
  });

  it('a removed city that was never verified comes back through reverify', async () => {
    await addCity({ slug: 'houston', name: 'Houston' });
    await api('DELETE', '/api/fleet/cities/houston', { token });
    expect((await putCity('houston', { enabled: true })).status).toBe(409);
    const r = await putCity('houston', { reverify: true });
    expect(r.body).toMatchObject({ enabled: false, disabled_at: null });
    expect(r.body.open_tasks.map((t) => t.kind)).toEqual(['verify-slug']);
  });

  it('rejects an unknown field, an empty patch and a per_day out of range', async () => {
    await addCity({ slug: 'houston', name: 'Houston' });
    expect((await putCity('houston', { radius_km: 5 })).status).toBe(422);
    expect((await putCity('houston', {})).status).toBe(422);
    expect((await putCity('houston', { per_day: 0 })).status).toBe(422);
    expect((await putCity('nowhere', { pinned: true })).status).toBe(404);
  });

  it('DELETE disables the city and cancels its open tasks', async () => {
    await addCity({ slug: 'houston', name: 'Houston' });
    const r = await api<FleetCityListed>('DELETE', '/api/fleet/cities/houston', { token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: false });
    expect(r.body.disabled_at).not.toBeNull();
    expect(r.body.open_tasks).toEqual([]);
    const cancelled = await tasksWhere('state=cancelled&city=houston');
    expect(cancelled.map((t) => t.kind)).toEqual(['verify-slug']);
    expect((await api('DELETE', '/api/fleet/cities/houston', { token })).status).toBe(200);
    expect((await api('DELETE', '/api/fleet/cities/nowhere', { token })).status).toBe(404);
  });
});

describe('items', () => {
  beforeEach(async () => { await resetDb(); ({ token } = await loginAs(ALEX)); });

  it('upserts the items given and lists them sorted', async () => {
    const r = await api<FleetItem[]>('PUT', '/api/fleet/items', { token, body: ITEMS });
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      { name: 'enterprise_ssd', phrases: ['ssd lot'], filters: {}, enabled: true },
      { name: 'server_ram', phrases: ['server ram memory'], filters: { keywords: ['ram'] }, enabled: true },
    ]);
    const off = await api<FleetItem[]>('PUT', '/api/fleet/items', { token, body: [{ name: 'server_ram', phrases: ['server ram', ' server ram '], enabled: false }] });
    expect(off.body.find((i) => i.name === 'server_ram')).toEqual({ name: 'server_ram', phrases: ['server ram'], filters: {}, enabled: false });
    expect(off.body).toHaveLength(2);
    expect((await api<FleetItem[]>('GET', '/api/fleet/items', { token })).body).toEqual(off.body);
  });

  it('refuses a bad name, no phrases and a non-object filter', async () => {
    expect((await api('PUT', '/api/fleet/items', { token, body: [] })).status).toBe(422);
    expect((await api('PUT', '/api/fleet/items', { token, body: [{ name: 'Server RAM', phrases: ['x'] }] })).status).toBe(422);
    expect((await api('PUT', '/api/fleet/items', { token, body: [{ name: 'server_ram', phrases: [] }] })).status).toBe(422);
    expect((await api('PUT', '/api/fleet/items', { token, body: [{ name: 'server_ram', phrases: ['x'], filters: [1] }] })).status).toBe(422);
  });
});

describe('settings', () => {
  beforeEach(async () => { await resetDb(); ({ token } = await loginAs(ALEX)); });

  it('answers the defaults until something is saved', async () => {
    const r = await api<FleetSettings>('GET', '/api/fleet/settings', { token });
    expect(r.body).toEqual({
      per_day_default: 1, budget_minutes: 360, lease_minutes: 30, task_max_minutes: 45, poll_hold_seconds: 50,
      familiar_days: 7, start_fresh_hours: 2, quarantine_hours: 48, quarantine_probe_hours: 6, search: {},
    });
  });

  it('saves the keys given, merges search values, and records who', async () => {
    const r = await api<FleetSettings>('PUT', '/api/fleet/settings', { token, body: { budget_minutes: 240, search: { date_listed: 'last 7 days', max_results: 120 } } });
    expect(r.status).toBe(200);
    expect(r.body.budget_minutes).toBe(240);
    expect(r.body.lease_minutes).toBe(30);
    expect(r.body.search).toEqual({ date_listed: 'last 7 days', max_results: 120 });
    const again = await api<FleetSettings>('PUT', '/api/fleet/settings', { token, body: { search: { delivery_method: 'shipping', date_listed: ['last 24 hours', 'all'] } } });
    expect(again.body.search).toEqual({ date_listed: ['last 24 hours', 'all'], max_results: 120, delivery_method: 'shipping' });
    const rows = await getTestDb()<{ key: string; updated_by: string | null }[]>`SELECT key, updated_by FROM fleet_settings ORDER BY key`;
    expect(rows.map((x) => x.key)).toEqual(['budget_minutes', 'search']);
    expect(rows.every((x) => x.updated_by)).toBe(true);
  });

  it('refuses an unknown key, a value out of bounds and a search value the monitor would not take', async () => {
    const put = (body: unknown) => api<{ error: string; detail: string }>('PUT', '/api/fleet/settings', { token, body: body as Record<string, unknown> });
    expect((await put({ sweep_at: '13:00' })).status).toBe(422);
    expect((await put({ per_day_default: 0 })).status).toBe(422);
    expect((await put({ lease_minutes: 181 })).status).toBe(422);
    expect((await put({ quarantine_probe_hours: 2.5 })).status).toBe(422);
    expect((await put({ search: { date_listed: 'yesterday' } })).status).toBe(422);
    expect((await put({ search: { search_interval: '45 minutes' } })).status).toBe(422);
    expect((await put({ search: { start_at: ['13:00'] } })).status).toBe(422);
    expect((await put({})).status).toBe(422);
    const r = await put({ budget_minutes: 'lots' });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: 'bad_request' });
    expect(r.body.detail).toMatch(/budget_minutes/);
  });
});

describe('tasks, round start, city log', () => {
  beforeEach(async () => {
    await resetDb();
    await manager();
    await addCity({ slug: 'houston', name: 'Houston' });
    await putCity('houston', { override_verify: true });
    await addCity({ slug: 'dallas', name: 'Dallas' });
    await putCity('dallas', { override_verify: true });
  });

  it('lists and filters tasks', async () => {
    const all = await tasksWhere('');
    expect(all).toHaveLength(6); // 2 cancelled verify tasks + 4 search tasks
    expect(await tasksWhere('state=ready')).toHaveLength(4);
    expect((await tasksWhere('state=ready&city=houston')).map((t) => t.item).sort()).toEqual(['enterprise_ssd', 'server_ram']);
    expect(await tasksWhere('item=server_ram&state=ready')).toHaveLength(2);
    expect(await tasksWhere('worker=nobody')).toHaveLength(0);
    expect((await api('GET', '/api/fleet/tasks?state=flying', { token })).status).toBe(422);
    expect((await api('GET', '/api/fleet/tasks?since=yesterday', { token })).status).toBe(422);
    expect(await tasksWhere(`since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).toHaveLength(0);
  });

  it('a manual task pulls the pair\'s waiting task to the front, and refuses one being searched', async () => {
    const r = await api<FleetTask>('POST', '/api/fleet/tasks', { token, body: { city: 'houston', item: 'server_ram' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ city: 'houston', item: 'server_ram', priority: 100, reason: 'manual', state: 'ready' });
    expect(await tasksWhere('state=ready')).toHaveLength(4);
    expect((await tasksWhere('state=ready'))[0].id).toBe(r.body.id);

    await getTestDb()`UPDATE fleet_tasks SET state = 'leased', worker_id = 'lab-1', leased_at = NOW(), lease_expires_at = NOW() + interval '30 min' WHERE id = ${r.body.id}`;
    const busy = await api<{ error: string }>('POST', '/api/fleet/tasks', { token, body: { city: 'houston', item: 'server_ram' } });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe('exists');

    expect((await api('POST', '/api/fleet/tasks', { token, body: { city: 'houston' } })).status).toBe(422);
    expect((await api('POST', '/api/fleet/tasks', { token, body: { city: 'nowhere', item: 'server_ram' } })).status).toBe(404);
  });

  it('a manual task on a disabled city gets a task of its own, which the next reconcile keeps', async () => {
    await putCity('dallas', { enabled: false });
    const r = await api<FleetTask>('POST', '/api/fleet/tasks', { token, body: { city: 'dallas', item: 'server_ram' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ city: 'dallas', priority: 100, reason: 'manual' });
    // Any catalog write reconciles; the manager's task survives it.
    await putCity('houston', { pinned: true });
    expect((await tasksWhere('state=ready&city=dallas')).map((t) => t.id)).toEqual([r.body.id]);
  });

  it('two clicks at once on a pair with no task write one task, and both answer it', async () => {
    await putCity('dallas', { enabled: false });
    const [a, b] = await Promise.all([1, 2].map(() => api<FleetTask>('POST', '/api/fleet/tasks', { token, body: { city: 'dallas', item: 'server_ram' } })));
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(await tasksWhere('state=ready&city=dallas')).toHaveLength(1);
  });

  it('history reads come newest first, and say when they were cut', async () => {
    const db = getTestDb();
    await db`INSERT INTO fleet_tasks (city, item, kind, due_at, state, done_at, reason)
             SELECT 'houston', 'server_ram', 'search', NOW() - make_interval(mins => g), 'done', NOW() - make_interval(mins => g), 'cadence'
             FROM generate_series(1, 5001) g`;
    const r = await api<FleetTask[]>('GET', '/api/fleet/tasks?state=done', { token });
    expect(r.body).toHaveLength(5000);
    expect(r.headers.get('X-Fleet-Truncated')).toBe('true');
    const newest = r.body[0];
    expect(new Date(newest.done_at!).getTime()).toBeGreaterThan(new Date(r.body[4999].done_at!).getTime());
    expect(new Date(newest.done_at!).getTime()).toBeGreaterThan(Date.now() - 2 * 60_000);
    expect((await api('GET', '/api/fleet/tasks?state=ready', { token })).headers.get('X-Fleet-Truncated')).toBeNull();
  });

  it('round start pulls every waiting search to now except pairs finished within start_fresh_hours', async () => {
    const db = getTestDb();
    await db`UPDATE fleet_tasks SET due_at = NOW() + interval '20 hours' WHERE state = 'ready'`;
    await db`
      INSERT INTO fleet_tasks (city, item, kind, due_at, state, leased_at, done_at, reason)
      VALUES ('dallas', 'server_ram', 'search', NOW() - interval '2 hours', 'done', NOW() - interval '1 hour', NOW() - interval '30 minutes', 'cadence')`;
    const r = await api<RoundStartAnswer>('POST', '/api/fleet/round/start', { token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ started: 3, skipped: 1 });
    const ready = await tasksWhere('state=ready');
    const dueNow = ready.filter((t) => new Date(t.due_at).getTime() <= Date.now());
    expect(dueNow).toHaveLength(3);
    expect(dueNow.every((t) => t.reason === 'start')).toBe(true);
    expect(ready.find((t) => t.city === 'dallas' && t.item === 'server_ram')!.reason).toBe('added');
  });

  it('the city log needs a city or a worker and returns tasks with their events', async () => {
    expect((await api('GET', '/api/fleet/city-log', { token })).status).toBe(422);
    expect((await api('GET', '/api/fleet/city-log?city=houston&hours=0', { token })).status).toBe(422);
    const db = getTestDb();
    const [t] = await db<{ id: string }[]>`SELECT id FROM fleet_tasks WHERE city = 'houston' AND item = 'server_ram' AND state = 'ready'`;
    await db`UPDATE fleet_tasks SET state = 'leased', worker_id = 'lab-1', leased_at = NOW(), lease_expires_at = NOW() + interval '30 min' WHERE id = ${t.id}`;
    await db`INSERT INTO fleet_task_events (task_id, worker_id, kind, detail) VALUES (${t.id}, 'lab-1', 'handed', '{"why":"home"}'), (${t.id}, 'lab-1', 'started', NULL)`;

    const byCity = await api<FleetTaskLog[]>('GET', '/api/fleet/city-log?city=houston', { token });
    expect(byCity.status).toBe(200);
    expect(byCity.body.map((x) => `${x.item}/${x.kind}/${x.state}`).sort())
      .toEqual(['enterprise_ssd/search/ready', 'enterprise_ssd/verify-slug/cancelled', 'server_ram/search/leased']);
    const leased = byCity.body.find((x) => x.state === 'leased')!;
    expect(leased.events.map((e) => e.kind)).toEqual(['handed', 'started']);
    expect(leased.events[0]).toMatchObject({ task_id: Number(t.id), worker_id: 'lab-1', detail: { why: 'home' } });

    const byWorker = await api<FleetTaskLog[]>('GET', '/api/fleet/city-log?worker=lab-1&hours=1', { token });
    expect(byWorker.body.map((x) => x.id)).toEqual([Number(t.id)]);
  });
});
