import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, getTestDb } from './helpers/db';

// The nightly prod→dev copy sets dev's fleet aside before it drops the schema
// and puts it back once the backend has migrated the copy. Here the copy is
// stood in for by emptying the fleet tables and scrubbing the pool rows the
// way scrub.sql does, which is what the fleet looks like after a real one.
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'deploy', 'railway-sync');
const keep = readFileSync(join(dir, 'keep-fleet.sql'), 'utf8');
const restore = readFileSync(join(dir, 'restore-fleet.sql'), 'utf8');

const SEALED = ['password_enc', 'totp_enc', 'email_password_enc', 'cookie_enc', 'token_enc'];

async function pool(uid: string, status: string, note: string) {
  const sql = getTestDb();
  const [r] = await sql<{ no: number }[]>`
    INSERT INTO fb_pool_accounts ${sql({
      uid, cookie_uid: uid, batch: 'Batch', status, note, holder_name: 'w-1',
      ...Object.fromEntries(SEALED.map((c) => [c, `v1.${uid}`])),
    })} RETURNING no`;
  return r.no;
}

async function copyLikeTheNightly(nos: number[]) {
  const sql = getTestDb();
  await sql`TRUNCATE fleet_task_attempts, fleet_task_events, fleet_tasks, fleet_workers, fleet_slots,
                     fleet_claim_tickets, fleet_hosts, fleet_settings, fleet_items, fleet_cities`;
  await sql.unsafe(`UPDATE fb_pool_accounts SET ${SEALED.map((c) => `${c} = NULL`).join(', ')},
                      cookie_uid = NULL, cookie_at = NULL, status = 'available', note = 'from prod',
                      holder_name = NULL, held_since = NULL
                    WHERE no IN (${nos.join(',')})`);
}

const snapshot = async () => {
  const sql = getTestDb();
  return {
    hosts: await sql`SELECT * FROM fleet_hosts ORDER BY host_id`,
    slots: await sql`SELECT * FROM fleet_slots ORDER BY account_no`,
    workers: await sql`SELECT * FROM fleet_workers ORDER BY worker_id`,
    cities: await sql`SELECT * FROM fleet_cities ORDER BY slug`,
    items: await sql`SELECT * FROM fleet_items ORDER BY name`,
    settings: await sql`SELECT * FROM fleet_settings ORDER BY key`,
    tasks: await sql`SELECT * FROM fleet_tasks ORDER BY id`,
    events: await sql`SELECT * FROM fleet_task_events ORDER BY id`,
    attempts: await sql`SELECT * FROM fleet_task_attempts ORDER BY id`,
  };
};

describe('prod→dev sync keeps the dev fleet', () => {
  beforeEach(async () => { await resetDb(); });

  it('puts every fleet row and the slotted accounts\' own columns back', async () => {
    const sql = getTestDb();
    const a = await pool('61500000000001', 'fleet', 'fleet pilot');
    const b = await pool('61500000000002', 'fleet', 'fleet pilot');
    const other = await pool('61500000000003', 'available', 'not in the fleet');
    await sql`UPDATE fb_pool_accounts SET cookie_at = NOW() WHERE no IN (${a}, ${b})`;
    await sql`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative) VALUES ('worker-1', 'abc', 4, TRUE)`;
    await sql`INSERT INTO fleet_cities (slug, name, enabled) VALUES ('nyc', 'New York', TRUE), ('reno', 'Reno', TRUE)`;
    await sql`INSERT INTO fleet_items (name, phrases) VALUES ('server_ram', '["server ram"]')`;
    await sql`INSERT INTO fleet_settings (key, value) VALUES ('lease_minutes', '30')`;
    await sql`INSERT INTO fleet_slots (account_no, worker_id, host_id, epoch, proxy_url, device)
              VALUES (${a}, 'worker-1-1', 'worker-1', 3, 'v1.proxy', '{"timezone":"America/New_York"}'),
                     (${b}, NULL, NULL, 1, 'v1.proxy2', NULL)`;
    await sql`INSERT INTO fleet_workers (worker_id, host_id, account_no, epoch, state)
              VALUES ('worker-1-1', 'worker-1', ${a}, 3, 'HEALTHY')`;
    // A finished task: its insert trigger archives the attempt once.
    await sql`INSERT INTO fleet_tasks (city, item, due_at, state, worker_id, account_no, epoch, leased_at, done_at, result)
              VALUES ('nyc', 'server_ram', NOW(), 'done', 'worker-1-1', ${a}, 3, NOW() - interval '20 minutes', NOW(), '{"cards":1}'),
                     ('reno', 'server_ram', NOW(), 'leased', 'worker-1-1', ${a}, 3, NOW(), NULL, NULL)`;
    await sql`INSERT INTO fleet_task_events (task_id, worker_id, kind) SELECT id, worker_id, 'done' FROM fleet_tasks`;
    const before = await snapshot();
    expect(before.attempts).toHaveLength(1);
    const poolBefore = await sql`SELECT * FROM fb_pool_accounts WHERE no IN (${a}, ${b}) ORDER BY no`;
    const otherBefore = await sql`SELECT status, note FROM fb_pool_accounts WHERE no = ${other}`;

    await sql.begin((tx) => tx.unsafe(keep));
    await copyLikeTheNightly([a, b, other]);
    await sql.begin((tx) => tx.unsafe(restore));

    expect(await snapshot()).toEqual(before);
    expect(await sql`SELECT * FROM fb_pool_accounts WHERE no IN (${a}, ${b}) ORDER BY no`).toEqual(poolBefore);
    // Not slotted: it stays as the copy left it.
    expect(await sql`SELECT status, note FROM fb_pool_accounts WHERE no = ${other}`)
      .not.toEqual(otherBefore);
    expect((await sql`SELECT 1 FROM pg_namespace WHERE nspname = 'sync_keep'`)).toHaveLength(0);

    // Sequences start after the kept ids, and the archive trigger is back on.
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO fleet_tasks (city, item, due_at, state, leased_at, done_at, account_no, epoch)
      VALUES ('nyc', 'server_ram', NOW(), 'done', NOW() - interval '1 minute', NOW(), ${b}, 1) RETURNING id`;
    expect(Number(t.id)).toBeGreaterThan(Math.max(...before.tasks.map((r) => Number(r.id))));
    expect(await sql`SELECT 1 FROM fleet_task_attempts WHERE task_id = ${t.id}`).toHaveLength(1);
  });

  it('drops a slot whose pool number now belongs to another account', async () => {
    const sql = getTestDb();
    const a = await pool('61500000000011', 'fleet', 'fleet pilot');
    await sql`INSERT INTO fleet_slots (account_no, epoch) VALUES (${a}, 1)`;
    await sql`INSERT INTO fleet_workers (worker_id, account_no, epoch, state) VALUES ('w-9', ${a}, 1, 'HEALTHY')`;

    await sql.begin((tx) => tx.unsafe(keep));
    await copyLikeTheNightly([a]);
    await sql`UPDATE fb_pool_accounts SET uid = '61500000000099' WHERE no = ${a}`;
    await sql.begin((tx) => tx.unsafe(restore));

    expect(await sql`SELECT * FROM fleet_slots`).toHaveLength(0);
    expect(await sql`SELECT account_no FROM fleet_workers`).toEqual([{ account_no: null }]);
    expect(await sql`SELECT password_enc, status FROM fb_pool_accounts WHERE no = ${a}`)
      .toEqual([{ password_enc: null, status: 'available' }]);
  });
});
