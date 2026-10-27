import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { getTestDb, resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { ALEX, MARCUS, loginAs } from './helpers/auth';
import {
  hostAuth, signWorkerToken, verifyWorkerToken, workerAuth, workerTokenKey,
  type HostEnv, type WorkerEnv,
} from '../src/fleet/auth';
import { FLEET_TABLES, sha256hex } from '../src/fleet/sql';
import type { Env } from '../src/types';

// Made-up material throughout: the key, the host token and the pool account
// are fixtures, never anything from a real .env or the real pool.
const KEY_HEX = 'a3f1c9d2e4b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_KEY_HEX = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
const ENV: Partial<Env> = { FLEET_WORKER_TOKEN_KEY: KEY_HEX };
const KEY = Buffer.from(KEY_HEX, 'hex');
const HOST_TOKEN = 'host-token-' + randomBytes(16).toString('hex');
const inSevenDays = () => Math.floor(Date.now() / 1000) + 7 * 86_400;

// The middlewares under test, on a bare app: the real routes they will guard
// belong to later PRs, and what matters here is the scope, not the handler.
const probe = new Hono<{ Bindings: Env; Variables: HostEnv['Variables'] & WorkerEnv['Variables'] }>()
  .get('/host', hostAuth, (c) => c.json({ host: c.var.host.host_id }))
  .get('/hosts/:id/desired', hostAuth, (c) => c.json({ id: c.req.param('id') }))
  .get('/worker', workerAuth, (c) => {
    const w = c.var.worker;
    return c.json({ worker_id: w.worker_id, account_no: w.account_no, epoch: w.epoch, slot_epoch: w.slot.epoch, rotated: w.rotated });
  });

async function hit(path: string, token: string | null, env: Partial<Env> = ENV) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await probe.fetch(new Request('http://test' + path, { headers }), { ...testEnv, ...env });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function seedSlot(epoch: number): Promise<number> {
  const db = getTestDb();
  const [a] = await db<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (uid, batch, status, holder_name)
    VALUES ('61550000000001', 'fixtures', 'fleet', 'lab-1') RETURNING no`;
  await db`INSERT INTO fleet_slots (account_no, worker_id, epoch) VALUES (${a.no}, 'lab-1', ${epoch})`;
  return a.no;
}

describe('fleet schema', () => {
  beforeEach(async () => { await resetDb(); });

  it('migrates every fleet relation, the open-task index and the minutes view', async () => {
    const db = getTestDb();
    const rows = await db<{ table_name: string; table_type: string }[]>`
      SELECT table_name, table_type FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'fleet\\_%' ORDER BY table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([...FLEET_TABLES]);
    expect(rows.find((r) => r.table_name === 'fleet_minutes')?.table_type).toBe('VIEW');

    const idx = await db<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'fleet_tasks_open_idx'`;
    expect(idx[0]?.indexdef).toMatch(/UNIQUE/);
    expect(idx[0]?.indexdef).toMatch(/WHERE/);
  });

  it('keeps one open task per city, item and kind', async () => {
    const db = getTestDb();
    await db`INSERT INTO fleet_cities (slug, name) VALUES ('houston', 'Houston')`;
    await db`INSERT INTO fleet_items (name, phrases) VALUES ('server_ram', '["server ram"]')`;
    const open = () => db`
      INSERT INTO fleet_tasks (city, item, due_at, state) VALUES ('houston', 'server_ram', NOW(), 'ready')`;
    await open();
    await expect(open()).rejects.toMatchObject({ code: '23505' });
    await db`UPDATE fleet_tasks SET state = 'done', done_at = NOW()`;
    await expect(open()).resolves.toBeDefined();
  });
});

describe('GET /api/fleet/health', () => {
  beforeEach(async () => { await resetDb(); });

  it('is a manager route', async () => {
    expect((await api('GET', '/api/fleet/health')).status).toBe(401);
    const { token } = await loginAs(MARCUS);
    expect((await api('GET', '/api/fleet/health', { token })).status).toBe(403);
  });

  it('lists the fleet tables', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ ok: boolean; tables: string[] }>('GET', '/api/fleet/health', { token });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.tables).toEqual([...FLEET_TABLES]);
  });
});

describe('host scope', () => {
  beforeEach(async () => {
    await resetDb();
    await getTestDb()`INSERT INTO fleet_hosts (host_id, token_hash) VALUES ('lab', ${sha256hex(HOST_TOKEN)})`;
  });

  it('refuses no token, an unknown token and a worker token', async () => {
    expect((await hit('/host', null)).status).toBe(401);
    expect((await hit('/host', 'not-a-host-token')).status).toBe(401);
    const worker = signWorkerToken({ worker_id: 'lab-1', account_no: 1, epoch: 1, exp: inSevenDays() }, KEY);
    expect((await hit('/host', worker)).status).toBe(401);
  });

  it('admits the host whose hash is stored, and only for its own id', async () => {
    const ok = await hit('/host', HOST_TOKEN);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ host: 'lab' });
    expect((await hit('/hosts/lab/desired', HOST_TOKEN)).status).toBe(200);
    expect((await hit('/hosts/other/desired', HOST_TOKEN)).status).toBe(401);
  });
});

describe('worker scope', () => {
  beforeEach(async () => { await resetDb(); });

  it('signs and verifies, and rejects another key, a tampered payload and an expired token', () => {
    const claims = { worker_id: 'lab-1', account_no: 7, epoch: 3, exp: inSevenDays() };
    const token = signWorkerToken(claims, KEY);
    expect(verifyWorkerToken(token, KEY)).toEqual(claims);
    expect(verifyWorkerToken(token, Buffer.from(OTHER_KEY_HEX, 'hex'))).toBeNull();
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, epoch: 4 })).toString('base64url');
    expect(verifyWorkerToken(`${forged}.${sig}`, KEY)).toBeNull();
    expect(verifyWorkerToken(payload, KEY)).toBeNull();
    const expired = signWorkerToken({ ...claims, exp: Math.floor(Date.now() / 1000) - 1 }, KEY);
    expect(verifyWorkerToken(expired, KEY)).toBeNull();
  });

  it('refuses no token, a garbage token, a host token and a token under another key', async () => {
    await getTestDb()`INSERT INTO fleet_hosts (host_id, token_hash) VALUES ('lab', ${sha256hex(HOST_TOKEN)})`;
    const no = await seedSlot(1);
    // The 401 bodies the worker matches to know its token, not the ERP, is at fault.
    expect(await hit('/worker', null)).toEqual({ status: 401, body: { error: 'unauthorized', detail: 'missing_token' } });
    expect(await hit('/worker', 'garbage')).toEqual({ status: 401, body: { error: 'unauthorized', detail: 'bad_token' } });
    expect((await hit('/worker', HOST_TOKEN)).status).toBe(401);
    const expired = signWorkerToken({ worker_id: 'lab-1', account_no: no, epoch: 1, exp: 1 }, KEY);
    expect(await hit('/worker', expired)).toEqual({ status: 401, body: { error: 'unauthorized', detail: 'expired_token' } });
    const other = signWorkerToken(
      { worker_id: 'lab-1', account_no: no, epoch: 1, exp: inSevenDays() }, Buffer.from(OTHER_KEY_HEX, 'hex'),
    );
    const r = await hit('/worker', other);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'unauthorized', detail: 'bad_token' });
  });

  it('admits a token under the previous key after a rotation, and says so', async () => {
    const no = await seedSlot(2);
    const old = signWorkerToken({ worker_id: 'lab-1', account_no: no, epoch: 2, exp: inSevenDays() }, Buffer.from(OTHER_KEY_HEX, 'hex'));
    const rotated: Partial<Env> = { FLEET_WORKER_TOKEN_KEY: KEY_HEX, FLEET_WORKER_TOKEN_KEY_PREVIOUS: OTHER_KEY_HEX };
    const r = await hit('/worker', old, rotated);
    expect(r.status).toBe(200);
    expect(r.body?.rotated).toBe(true);
    // Without the previous key it is just another bad signature.
    expect((await hit('/worker', old)).body).toEqual({ error: 'unauthorized', detail: 'bad_token' });
  });

  it('answers 409 stale_epoch when the slot moved on, or is gone', async () => {
    const no = await seedSlot(2);
    const stale = signWorkerToken({ worker_id: 'lab-1', account_no: no, epoch: 1, exp: inSevenDays() }, KEY);
    const r = await hit('/worker', stale);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'stale_epoch' });

    const gone = signWorkerToken({ worker_id: 'lab-1', account_no: no + 1000, epoch: 0, exp: inSevenDays() }, KEY);
    expect((await hit('/worker', gone)).status).toBe(409);
  });

  it('admits the current epoch and hands the handler the slot', async () => {
    const no = await seedSlot(2);
    const token = signWorkerToken({ worker_id: 'lab-1', account_no: no, epoch: 2, exp: inSevenDays() }, KEY);
    const r = await hit('/worker', token);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ worker_id: 'lab-1', account_no: no, epoch: 2, slot_epoch: 2, rotated: false });
  });

  it('answers 503 unavailable, never 401, when production has no key, and derives one elsewhere', async () => {
    const no = await seedSlot(0);
    const prod: Partial<Env> = { FLEET_WORKER_TOKEN_KEY: undefined, NODE_ENV: 'production' };
    const r = await hit('/worker', 'anything', prod);
    expect(r).toEqual({ status: 503, body: { error: 'unavailable', detail: 'FLEET_WORKER_TOKEN_KEY is not set' } });

    const dev: Partial<Env> = { FLEET_WORKER_TOKEN_KEY: undefined };
    const derived = workerTokenKey({ ...testEnv, ...dev });
    expect(derived).not.toBeNull();
    const token = signWorkerToken({ worker_id: 'lab-1', account_no: no, epoch: 0, exp: inSevenDays() }, derived!);
    expect((await hit('/worker', token, dev)).status).toBe(200);
  });
});
