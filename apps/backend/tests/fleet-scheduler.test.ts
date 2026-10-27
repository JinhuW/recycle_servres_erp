import { beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { getTestDb, resetDb, TEST_DATABASE_URL } from './helpers/db';
import { reconcile } from '../src/fleet/scheduler';
import { loadSettings } from '../src/fleet/cities';

// The scheduler on a bare catalog: cities and items written straight to the
// tables, reconcile() called with a pinned clock, tasks read back. The routes
// around it are fleet-cities.test.ts's business.

const HOUR = 3_600_000;
const NOW = new Date('2026-10-24T12:00:00Z');
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);
const backendRoot = join(import.meta.dirname, '..');
const MASTER = join(backendRoot, '..', '..', 'trackers', 'facebook', 'configs', 'master.toml');

type Task = {
  id: string; city: string; item: string; kind: string; state: string; due_at: Date; reason: string | null;
  priority: number; account_no: number | null; worker_id: string | null;
};

async function catalog(cities: Array<[slug: string, enabled?: boolean, perDay?: number | null]>, items: string[] = ['server_ram']) {
  const db = getTestDb();
  for (const [slug, enabled = true, perDay = null] of cities) {
    await db`
      INSERT INTO fleet_cities (slug, name, enabled, per_day, verified_at, verified_as)
      VALUES (${slug}, ${slug}, ${enabled}, ${perDay}, ${NOW}, ${enabled ? 'imported' : null})`;
  }
  for (const name of items) await db`INSERT INTO fleet_items (name, phrases) VALUES (${name}, '["x"]')`;
}

const tasks = (where: 'open' | 'all' = 'all') => getTestDb()<Task[]>`
  SELECT * FROM fleet_tasks
  WHERE ${where === 'open' ? getTestDb()`state IN ('ready', 'leased')` : getTestDb()`TRUE`}
  ORDER BY city, item, kind, id`;

async function done(city: string, item: string, hoursAgo: number) {
  await getTestDb()`
    INSERT INTO fleet_tasks (city, item, kind, due_at, state, leased_at, done_at, reason)
    VALUES (${city}, ${item}, 'search', ${at(-hoursAgo - 1)}, 'done', ${at(-hoursAgo - 0.1)}, ${at(-hoursAgo)}, 'cadence')`;
}

describe('reconcile: one open search per enabled pair', () => {
  beforeEach(async () => { await resetDb(); });

  it('inserts one task per enabled city and item, due now and reason added, and nothing twice', async () => {
    await catalog([['houston'], ['dallas'], ['austin', false]], ['server_ram', 'enterprise_ssd']);
    const first = await reconcile(getTestDb(), NOW);
    expect(first.inserted).toBe(4);
    expect(first.notified.sort()).toEqual(['enterprise_ssd', 'server_ram']);
    const open = await tasks('open');
    expect(open.map((t) => `${t.city}/${t.item}`)).toEqual([
      'dallas/enterprise_ssd', 'dallas/server_ram', 'houston/enterprise_ssd', 'houston/server_ram',
    ]);
    for (const t of open) {
      expect(t.kind).toBe('search');
      expect(t.reason).toBe('added');
      expect(t.due_at.getTime()).toBe(NOW.getTime());
      expect(t.priority).toBe(0);
    }
    const second = await reconcile(getTestDb(), NOW);
    expect(second.inserted).toBe(0);
    expect(second.notified).toEqual([]);
    expect((await tasks('open')).length).toBe(4);
  });

  it('follows the cadence from the last finished search: per_day_default, then the city\'s own per_day', async () => {
    await catalog([['houston'], ['dallas', true, 4]]);
    await done('houston', 'server_ram', 1);
    await done('dallas', 'server_ram', 1);
    await reconcile(getTestDb(), NOW);
    const open = await tasks('open');
    const houston = open.find((t) => t.city === 'houston')!;
    const dallas = open.find((t) => t.city === 'dallas')!;
    expect(houston.reason).toBe('cadence');
    expect(houston.due_at.getTime()).toBe(at(23).getTime());
    expect(dallas.due_at.getTime()).toBe(at(5).getTime());
  });

  it('never dates a task in the past: a pair done long ago is due now', async () => {
    await catalog([['houston']]);
    await done('houston', 'server_ram', 30);
    const r = await reconcile(getTestDb(), NOW);
    expect(r.notified).toEqual(['server_ram']);
    const [t] = await tasks('open');
    expect(t.due_at.getTime()).toBe(NOW.getTime());
  });

  it('does not notify for a task that is due later', async () => {
    await catalog([['houston']]);
    await done('houston', 'server_ram', 1);
    const r = await reconcile(getTestDb(), NOW);
    expect(r.inserted).toBe(1);
    expect(r.notified).toEqual([]);
  });
});

describe('reconcile: cancel, expire', () => {
  beforeEach(async () => { await resetDb(); });

  it('cancels waiting tasks on a disabled city or item, and keeps an unverified city\'s verify-slug task', async () => {
    await catalog([['houston'], ['dallas'], ['boise', false]], ['server_ram', 'enterprise_ssd']);
    await reconcile(getTestDb(), NOW);
    await getTestDb()`
      INSERT INTO fleet_tasks (city, item, kind, due_at, priority, state, reason)
      VALUES ('boise', 'server_ram', 'verify-slug', ${NOW}, 50, 'ready', 'verify')`;
    await getTestDb()`UPDATE fleet_cities SET enabled = FALSE, disabled_at = ${NOW} WHERE slug = 'dallas'`;
    await getTestDb()`UPDATE fleet_items SET enabled = FALSE WHERE name = 'enterprise_ssd'`;
    const r = await reconcile(getTestDb(), at(0.01));
    expect(r.cancelled).toBe(3); // dallas × 2 items, houston/enterprise_ssd
    const all = await tasks();
    expect(all.filter((t) => t.state === 'cancelled').map((t) => `${t.city}/${t.item}`).sort())
      .toEqual(['dallas/enterprise_ssd', 'dallas/server_ram', 'houston/enterprise_ssd']);
    const open = all.filter((t) => t.state === 'ready');
    expect(open.map((t) => `${t.city}/${t.item}/${t.kind}`)).toEqual(['boise/server_ram/verify-slug', 'houston/server_ram/search']);
    // Removing the unverified city (disabled_at set) takes its verify task with it.
    await getTestDb()`UPDATE fleet_cities SET disabled_at = ${NOW} WHERE slug = 'boise'`;
    await reconcile(getTestDb(), at(0.02));
    expect((await tasks('open')).map((t) => t.city)).toEqual(['houston']);
  });

  it('expires a lease past its time, logs the event, and a fresh task takes the pair', async () => {
    await catalog([['houston'], ['dallas']]);
    await reconcile(getTestDb(), at(-2));
    const db = getTestDb();
    await db`
      UPDATE fleet_tasks SET state = 'leased', worker_id = 'lab-1', account_no = 7, epoch = 1,
        leased_at = ${at(-1)}, lease_expires_at = ${at(-0.5)}
      WHERE city = 'houston'`;
    // Dallas is leased and renewed, but has run longer than task_max_minutes (45).
    await db`
      UPDATE fleet_tasks SET state = 'leased', worker_id = 'lab-2', account_no = 8, epoch = 1,
        leased_at = ${at(-1)}, lease_expires_at = ${at(0.4)}
      WHERE city = 'dallas'`;
    const r = await reconcile(db, NOW);
    expect(r.expired).toBe(2);
    expect(r.inserted).toBe(2);
    const all = await tasks();
    const expired = all.filter((t) => t.state === 'expired');
    expect(expired.map((t) => t.city).sort()).toEqual(['dallas', 'houston']);
    const events = await db<{ task_id: string; kind: string; worker_id: string }[]>`SELECT task_id, kind, worker_id FROM fleet_task_events ORDER BY task_id`;
    expect(events.map((e) => e.kind)).toEqual(['expired', 'expired']);
    expect(events.map((e) => e.task_id).sort()).toEqual(expired.map((t) => t.id).sort());
    const open = all.filter((t) => t.state === 'ready');
    expect(open.map((t) => t.city).sort()).toEqual(['dallas', 'houston']);
    for (const t of open) expect(t.due_at.getTime()).toBe(NOW.getTime());
  });

  it('leaves a live lease alone', async () => {
    await catalog([['houston']]);
    await reconcile(getTestDb(), at(-0.2));
    await getTestDb()`
      UPDATE fleet_tasks SET state = 'leased', worker_id = 'lab-1', leased_at = ${at(-0.2)}, lease_expires_at = ${at(0.3)}`;
    const r = await reconcile(getTestDb(), NOW);
    expect(r.expired).toBe(0);
    expect(r.inserted).toBe(0);
    expect((await tasks()).map((t) => t.state)).toEqual(['leased']);
  });
});

describe('reconcile: probes for quarantined slots', () => {
  beforeEach(async () => { await resetDb(); });

  // A worker runs the slot unless `lease` says otherwise: 'none' is an
  // account no worker holds, 'parked' the infinite lease a park leaves.
  async function slot(uid: string, home: string[], quarantinedUntil: Date | null, lease: 'held' | 'none' | 'parked' = 'held'): Promise<number> {
    const db = getTestDb();
    const [a] = await db<{ no: number }[]>`
      INSERT INTO fb_pool_accounts (uid, batch, status, holder_name) VALUES (${uid}, 'fixtures', 'fleet', 'lab') RETURNING no`;
    const expires = lease === 'held' ? db`${at(1000)}::timestamptz` : lease === 'parked' ? db`'infinity'::timestamptz` : db`NULL`;
    await db`
      INSERT INTO fleet_slots (account_no, home_cities, quarantined_until, worker_id, lease_expires_at)
      VALUES (${a.no}, ${db.json(home)}, ${quarantinedUntil}, ${lease === 'none' ? null : 'worker-' + uid}, ${expires})`;
    return a.no;
  }

  it('writes one probe per quarantined slot on its first enabled home city, once per quarantine_probe_hours', async () => {
    await catalog([['houston'], ['dallas'], ['boise', false]], ['enterprise_ssd', 'server_ram']);
    const quarantined = await slot('61550000000011', ['boise', 'dallas'], at(48));
    await slot('61550000000012', ['houston'], null);
    const r = await reconcile(getTestDb(), NOW);
    expect(r.probes).toBe(1);
    const probes = (await tasks()).filter((t) => t.kind === 'probe');
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({ city: 'dallas', item: 'enterprise_ssd', reason: 'probe', state: 'ready', account_no: quarantined, priority: 10 });

    expect((await reconcile(getTestDb(), at(1))).probes).toBe(0);
    // Finished three hours ago: still inside the six-hour interval.
    await getTestDb()`UPDATE fleet_tasks SET state = 'done', done_at = ${at(-3)}, leased_at = ${at(-3.1)} WHERE kind = 'probe'`;
    expect((await reconcile(getTestDb(), NOW)).probes).toBe(0);
    // Seven hours on, the slot is due another.
    expect((await reconcile(getTestDb(), at(4))).probes).toBe(1);
    // And none once the quarantine has ended.
    await getTestDb()`UPDATE fleet_tasks SET state = 'done', done_at = ${at(4.2)} WHERE kind = 'probe' AND state = 'ready'`;
    expect((await reconcile(getTestDb(), at(49))).probes).toBe(0);
  });

  it('writes no probe for an account no worker runs, and cancels one left waiting when its worker goes', async () => {
    await catalog([['dallas']], ['enterprise_ssd']);
    await slot('61550000000014', ['dallas'], at(48), 'none');
    await slot('61550000000015', ['dallas'], at(48), 'parked');
    const running = await slot('61550000000016', ['dallas'], at(48));
    expect((await reconcile(getTestDb(), NOW)).probes).toBe(1);
    const [probe] = (await tasks()).filter((t) => t.kind === 'probe');
    expect(probe.account_no).toBe(running);

    // Its worker stops: the probe is cancelled rather than waiting for ever.
    await getTestDb()`UPDATE fleet_slots SET lease_expires_at = ${at(0.5)} WHERE account_no = ${running}`;
    const r = await reconcile(getTestDb(), at(1));
    expect(r.probes).toBe(0);
    expect((await tasks()).find((t) => t.id === probe.id)?.state).toBe('cancelled');

    // Claimed again within the probe interval, it gets a fresh probe at once.
    await getTestDb()`UPDATE fleet_slots SET lease_expires_at = ${at(1000)} WHERE account_no = ${running}`;
    expect((await reconcile(getTestDb(), at(2))).probes).toBe(1);
  });

  it('falls back to the most overdue city when no home city is enabled', async () => {
    await catalog([['houston'], ['dallas']]);
    await done('dallas', 'server_ram', 30);
    await done('houston', 'server_ram', 2);
    await reconcile(getTestDb(), NOW); // dallas due now, houston due in 22 h
    await slot('61550000000013', ['nowhere'], at(48));
    await reconcile(getTestDb(), NOW);
    const [probe] = (await tasks()).filter((t) => t.kind === 'probe');
    expect(probe.city).toBe('dallas');
  });
});

describe('reconcile: import and concurrency', () => {
  beforeEach(async () => { await resetDb(); });

  function importMaster(extra: string[] = []) {
    return spawnSync('node', [join(backendRoot, 'scripts', 'fleet-import.mjs'), '--master', MASTER, ...extra], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      encoding: 'utf8',
    });
  }

  it('imports master.toml: 127 cities, 2 items, the search settings; 254 ready tasks after reconcile', async () => {
    const dry = importMaster(['--dry-run']);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('cities: 127 new');
    expect((await getTestDb()`SELECT COUNT(*)::int AS n FROM fleet_cities`)[0].n).toBe(0);

    const run = importMaster();
    expect(run.status, run.stderr).toBe(0);
    const db = getTestDb();
    const cities = await db<{ slug: string; enabled: boolean; verified_as: string; region: string; radius_km: number; name: string }[]>`SELECT * FROM fleet_cities ORDER BY slug`;
    expect(cities).toHaveLength(127);
    expect(cities.every((c) => c.enabled && c.verified_as === 'imported')).toBe(true);
    expect(cities.find((c) => c.slug === 'houston')).toMatchObject({ name: 'Houston, TX', region: 'South Central', radius_km: 100 });
    expect(cities.find((c) => c.slug === 'boston')).toMatchObject({ name: 'Boston, MA', region: 'Northeast', radius_km: 100 });
    const items = await db<{ name: string; phrases: string[]; filters: Record<string, unknown> }[]>`SELECT * FROM fleet_items ORDER BY name`;
    expect(items.map((i) => i.name)).toEqual(['enterprise_ssd', 'server_ram']);
    expect(items[1].phrases).toEqual(['server ram memory ddr4 ddr5 ecc']);
    expect(Object.keys(items[1].filters).sort()).toEqual(['antikeywords', 'description', 'keywords']);
    const settings = await loadSettings(db);
    expect(settings.search).toMatchObject({ delivery_method: 'local_pick_up', max_results: 120, title_prefilter: true, min_unit_count: 5 });
    expect(settings.search.prompt).toContain('Recycle Servers');

    // Two instances reconciling at the same moment, three times over.
    const reports = await Promise.all([reconcile(db, NOW), reconcile(db, NOW), reconcile(db, NOW)]);
    expect(reports.reduce((n, r) => n + r.inserted, 0)).toBe(254);
    const [{ n }] = await db<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM fleet_tasks WHERE state = 'ready'`;
    expect(n).toBe(254);
    const [{ pairs }] = await db<{ pairs: number }[]>`
      SELECT COUNT(*)::int AS pairs FROM (SELECT city, item FROM fleet_tasks WHERE state IN ('ready','leased') GROUP BY 1, 2 HAVING COUNT(*) > 1) d`;
    expect(pairs).toBe(0);

    // A second import changes nothing and says so.
    const again = importMaster(['--dry-run']);
    expect(again.stdout).toContain('cities: 0 new, 0 changed, 127 unchanged');
    expect(again.stdout).toContain('search settings: unchanged');
  });

  it('keeps a manager\'s edits unless --overwrite, and refuses a remote database without the opt-in', async () => {
    expect(importMaster().status).toBe(0);
    const db = getTestDb();
    await db`UPDATE fleet_cities SET enabled = FALSE, disabled_at = NOW(), name = 'Renamed' WHERE slug = 'houston'`;
    await db`UPDATE fleet_cities SET verified_as = 'override' WHERE slug = 'boston'`;
    await db`UPDATE fleet_items SET phrases = '["edited"]' WHERE name = 'server_ram'`;
    await db`UPDATE fleet_settings SET value = value - 'max_results' WHERE key = 'search'`;

    const dry = importMaster(['--dry-run']);
    expect(dry.stdout).toContain('cities: 0 new, 1 changed, 126 unchanged');
    expect(dry.stdout).toContain('differ (kept; --overwrite takes master.toml\'s): houston');
    expect(dry.stdout).toContain('search settings: 1 new key(s): max_results');

    expect(importMaster().status).toBe(0);
    const [houston] = await db<{ enabled: boolean; name: string }[]>`SELECT enabled, name FROM fleet_cities WHERE slug = 'houston'`;
    expect(houston).toEqual({ enabled: false, name: 'Renamed' });
    expect((await db<{ phrases: string[] }[]>`SELECT phrases FROM fleet_items WHERE name = 'server_ram'`)[0].phrases).toEqual(['edited']);
    expect((await loadSettings(db)).search.max_results).toBe(120);

    expect(importMaster(['--overwrite']).status).toBe(0);
    const [back] = await db<{ enabled: boolean; name: string; disabled_at: Date | null }[]>`SELECT enabled, name, disabled_at FROM fleet_cities WHERE slug = 'houston'`;
    expect(back).toEqual({ enabled: true, name: 'Houston, TX', disabled_at: null });
    expect((await db<{ verified_as: string }[]>`SELECT verified_as FROM fleet_cities WHERE slug = 'boston'`)[0].verified_as).toBe('override');
    expect((await db<{ phrases: string[] }[]>`SELECT phrases FROM fleet_items WHERE name = 'server_ram'`)[0].phrases).toEqual(['server ram memory ddr4 ddr5 ecc']);

    const remote = spawnSync('node', [join(backendRoot, 'scripts', 'fleet-import.mjs'), '--master', MASTER], {
      env: { ...process.env, DATABASE_URL: 'postgres://u:p@db.example.invalid:5432/prod', NODE_ENV: 'test' }, encoding: 'utf8',
    });
    expect(remote.status).toBe(1);
    expect(remote.stderr).toContain('FLEET_IMPORT_REMOTE=true');
  });

  it('wakes a LISTEN fleet_tasks subscriber with the item', async () => {
    await catalog([['houston']]);
    const db = getTestDb();
    const got: string[] = [];
    const sub = await db.listen('fleet_tasks', (payload) => { got.push(payload); });
    try {
      await reconcile(db, NOW);
      await new Promise((r) => setTimeout(r, 200));
      expect(got).toEqual(['server_ram']);
    } finally {
      await sub.unlisten();
    }
  });
});

describe('verification and quarantine recovery', () => {
  beforeEach(async () => { await resetDb(); });

  it('creates the missing check after the first item, and replaces an expired check', async () => {
    const db = getTestDb();
    await db`INSERT INTO fleet_cities (slug, name) VALUES ('new-city', 'New city')`;
    await reconcile(db);
    expect((await tasks()).length).toBe(0);
    await db`INSERT INTO fleet_items (name, phrases) VALUES ('server_ram', '["ram"]')`;
    await reconcile(db);
    const [first] = await tasks();
    expect(first.kind).toBe('verify-slug');
    await db`UPDATE fleet_tasks SET state = 'leased', leased_at = NOW() - interval '1 hour', lease_expires_at = NOW() - interval '1 minute' WHERE id = ${first.id}`;
    await reconcile(db);
    const open = await tasks('open');
    expect(open).toHaveLength(1); expect(open[0].kind).toBe('verify-slug');
    expect(open[0].id).not.toBe(first.id);
  });

  it('ports zero-card evidence, preserves a manual release, and schedules per-account probes on one city', async () => {
    const db = getTestDb(); await catalog([['houston']]);
    const accounts = await db`INSERT INTO fb_pool_accounts (uid, batch, status) VALUES
      ('6155000000091','test','fleet'), ('6155000000092','test','fleet'), ('6155000000093','test','fleet') RETURNING no`;
    for (const a of accounts) await db`
      INSERT INTO fleet_slots (account_no, home_cities, worker_id, lease_expires_at)
      VALUES (${a.no}, '["houston"]', ${'worker-' + a.no}, NOW() + interval '1 day')`;
    for (const [index, a] of accounts.entries()) {
      for (let i = 0; i < 2; i++) await db`INSERT INTO fleet_tasks (city,item,kind,state,due_at,done_at,account_no,result)
        VALUES ('houston','server_ram','search','done',NOW(),NOW(),${a.no},${db.json({cards: index === 2 ? 20 : 0})})`;
    }
    await reconcile(db);
    const slots = await db`SELECT * FROM fleet_slots ORDER BY account_no`;
    expect(slots[0].quarantined_until).not.toBeNull(); expect(slots[1].quarantined_until).not.toBeNull();
    expect(slots[2].quarantined_until).toBeNull();
    const probes = await db`SELECT * FROM fleet_tasks WHERE kind = 'probe' AND state = 'ready'`;
    expect(probes).toHaveLength(2);
    await db`UPDATE fleet_slots SET quarantined_until = NULL, quarantine_reset_at = NOW() WHERE account_no = ${accounts[0].no}`;
    await reconcile(db);
    expect((await db`SELECT quarantined_until FROM fleet_slots WHERE account_no = ${accounts[0].no}`)[0].quarantined_until).toBeNull();
  });
});

describe('quarantine evidence exclusions', () => {
  beforeEach(async () => { await resetDb(); });
  it('does not quarantine stopped work or cities nobody sees cards in', async () => {
    const db = getTestDb(); await catalog([['houston']]);
    const [a] = await db`INSERT INTO fb_pool_accounts (uid,batch,status) VALUES ('6155000000095','test','fleet') RETURNING no`;
    await db`INSERT INTO fleet_slots (account_no) VALUES (${a.no})`;
    for (let i = 0; i < 2; i++) await db`INSERT INTO fleet_tasks (city,item,state,due_at,done_at,account_no,result)
      VALUES ('houston','server_ram','done',NOW(),NOW(),${a.no},'{"cards":0,"stopped":"connect failed"}')`;
    await reconcile(db);
    expect((await db`SELECT quarantined_until FROM fleet_slots`)[0].quarantined_until).toBeNull();
    await db`UPDATE fleet_tasks SET result = '{"cards":0}' WHERE state = 'done'`;
    await reconcile(db);
    expect((await db`SELECT quarantined_until FROM fleet_slots`)[0].quarantined_until).toBeNull();
  });
});

describe('reconcile: cadence changes, manual tasks, stopped results', () => {
  beforeEach(async () => { await resetDb(); });

  it('moves a waiting search when its city\'s per_day changes, but never one already due', async () => {
    const db = getTestDb();
    await catalog([['houston'], ['dallas']]);
    await done('houston', 'server_ram', 1);
    await done('dallas', 'server_ram', 30);
    await reconcile(db, NOW);
    expect((await tasks('open')).find((t) => t.city === 'houston')!.due_at.getTime()).toBe(at(23).getTime());
    const dallasBefore = (await tasks('open')).find((t) => t.city === 'dallas')!;
    expect(dallasBefore.due_at.getTime()).toBe(NOW.getTime());

    // One a day to six a day: four hours after the last search, not twenty-three.
    await db`UPDATE fleet_cities SET per_day = 6`;
    const later = new Date(NOW.getTime() + 60_000 * 5);
    await reconcile(db, later);
    const open = await tasks('open');
    expect(open.find((t) => t.city === 'houston')!.due_at.getTime()).toBe(at(3).getTime());
    // Dallas was due already and keeps its place in line.
    expect(open.find((t) => t.city === 'dallas')!.due_at.getTime()).toBe(NOW.getTime());

    // Down to one a day again: the wait grows back. A second pass writes nothing.
    await db`UPDATE fleet_cities SET per_day = NULL`;
    await reconcile(db, later);
    expect((await tasks('open')).find((t) => t.city === 'houston')!.due_at.getTime()).toBe(at(23).getTime());
    const [{ n }] = await db<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM fleet_tasks`;
    await reconcile(db, later);
    expect((await db<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM fleet_tasks`)[0].n).toBe(n);

    // A setting lowered so far that the next search is overdue becomes due now and wakes a poll.
    await db`UPDATE fleet_cities SET per_day = 24 WHERE slug = 'houston'`;
    const woke = await reconcile(db, later);
    expect((await tasks('open')).find((t) => t.city === 'houston')!.due_at.getTime()).toBe(later.getTime());
    expect(woke.notified).toEqual(['server_ram']);
  });

  it('keeps a manager\'s search-now on a switched-off or unverified city; a disabled item still cancels it', async () => {
    const db = getTestDb();
    await catalog([['houston', false]]);
    await db`UPDATE fleet_cities SET disabled_at = ${NOW}`;
    await db`INSERT INTO fleet_cities (slug, name) VALUES ('unverified', 'Unverified')`;
    for (const city of ['houston', 'unverified']) {
      await db`INSERT INTO fleet_tasks (city, item, kind, due_at, priority, state, reason)
               VALUES (${city}, 'server_ram', 'search', ${NOW}, 100, 'ready', 'manual')`;
    }
    await reconcile(db, NOW);
    expect((await tasks('open')).filter((t) => t.reason === 'manual').map((t) => t.city)).toEqual(['houston', 'unverified']);
    await db`UPDATE fleet_items SET enabled = FALSE`;
    await reconcile(db, NOW);
    expect((await tasks('open')).filter((t) => t.reason === 'manual')).toEqual([]);
  });

  it('counts a result that says stopped: false as a finished search', async () => {
    const db = getTestDb(); await catalog([['houston']]);
    const accounts = await db<{ no: number }[]>`INSERT INTO fb_pool_accounts (uid, batch, status) VALUES
      ('6155000000081','test','fleet'), ('6155000000082','test','fleet') RETURNING no`;
    for (const a of accounts) await db`INSERT INTO fleet_slots (account_no) VALUES (${a.no})`;
    for (const [index, a] of accounts.entries()) {
      for (let i = 0; i < 2; i++) await db`INSERT INTO fleet_tasks (city,item,kind,state,due_at,done_at,account_no,result)
        VALUES ('houston','server_ram','search','done',NOW(),NOW(),${a.no},${db.json({ cards: index === 1 ? 9 : 0, stopped: false })})`;
    }
    await reconcile(db);
    const slots = await db<{ quarantined_until: Date | null }[]>`SELECT quarantined_until FROM fleet_slots ORDER BY account_no`;
    expect(slots[0].quarantined_until).not.toBeNull();
    expect(slots[1].quarantined_until).toBeNull();
  });
});

describe('reconcile: verify-slug backoff', () => {
  beforeEach(async () => { await resetDb(); });

  it('waits 15 min after a check that gave no verdict, doubling to 6 h, and not after one that did', async () => {
    const db = getTestDb();
    await db`INSERT INTO fleet_items (name, phrases) VALUES ('server_ram', '["x"]')`;
    await db`INSERT INTO fleet_cities (slug, name) VALUES ('flaky', 'Flaky')`;
    const fail = async (minutesAgo: number) => {
      const done = new Date(NOW.getTime() - minutesAgo * 60_000);
      await db`UPDATE fleet_tasks SET state = 'done', done_at = ${done} WHERE city = 'flaky' AND state = 'ready'`;
    };
    const open = async () => (await tasks('open')).filter((t) => t.kind === 'verify-slug');

    await reconcile(db, NOW);
    expect((await open())[0].due_at.getTime()).toBe(NOW.getTime());
    await fail(1);
    const r = await reconcile(db, NOW);
    expect((await open())[0].due_at.getTime()).toBe(NOW.getTime() - 60_000 + 15 * 60_000);
    expect(r.notified).toEqual([]);
    await fail(1);
    await reconcile(db, NOW);
    expect((await open())[0].due_at.getTime()).toBe(NOW.getTime() - 60_000 + 30 * 60_000);
    for (let i = 0; i < 8; i++) { await fail(1); await reconcile(db, NOW); }
    expect((await open())[0].due_at.getTime()).toBe(NOW.getTime() - 60_000 + 6 * HOUR);

    // Checks that ended with a verdict do not count: after a reverify the next check is due at once.
    const ids = (await db<{ id: string }[]>`SELECT id FROM fleet_tasks WHERE city = 'flaky' AND state = 'done'`).map((t) => t.id);
    for (const id of ids) {
      await db`INSERT INTO fleet_task_events (task_id, worker_id, kind, detail) VALUES (${id}, 'lab-1', 'finished', '{"matches": false}')`;
    }
    await db`UPDATE fleet_tasks SET state = 'cancelled' WHERE city = 'flaky' AND state = 'ready'`;
    await reconcile(db, NOW);
    expect((await open())[0].due_at.getTime()).toBe(NOW.getTime());
  });
});
