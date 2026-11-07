import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  FLEET_SELLER_MIN_WORKER_VERSION, type ClaimAnswer, type NextTaskAnswer, type SellerReport, type SellerTaskPayload,
} from '@recycle-erp/shared';
import { getTestDb, resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import app from '../src/index';
import { sha256hex, minutesTodaySql } from '../src/fleet/sql';
import { reconcile } from '../src/fleet/scheduler';
import { enqueueSellerTask } from '../src/fleet/seller';
import { seal } from '../src/lib/sealed';
import { poolKey } from '../src/lib/sealed';

// Seller kinds in the fleet task queue (CONTRACTS §4): who is handed them,
// what a lost lease does to them, and the report and screenshot routes. The
// domain side (C's applySellerReport) is a fake here. Every account, host,
// token and message is made up.

const applied = vi.hoisted(() => ({ calls: [] as { accountNo: number; report: SellerReport }[] }));
vi.mock('../src/services/fbSellerReports', () => ({
  applySellerReport: async (_tx: unknown, accountNo: number, report: SellerReport) => {
    applied.calls.push({ accountNo, report });
    return { accepted: true };
  },
}));

const HOST_TOKEN = 'host-' + randomBytes(16).toString('hex');
const SELLS = FLEET_SELLER_MIN_WORKER_VERSION;
const OLD = '0.14.0';

type Headers = Record<string, string>;
const bearer = (token: string): Headers => ({ Authorization: `Bearer ${token}` });

async function seedBase(): Promise<void> {
  const db = getTestDb();
  await db`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative) VALUES ('lab', ${sha256hex(HOST_TOKEN)}, 4, TRUE)`;
  await db`INSERT INTO fleet_items (name, phrases, filters) VALUES ('server_ram', '["server ram"]', '{}')`;
  await db`INSERT INTO fleet_cities (slug, name, enabled) VALUES ('houston', 'Houston', TRUE)`;
}

async function seedSlot(n: number, role: 'search' | 'seller'): Promise<number> {
  const db = getTestDb();
  const k = poolKey(testEnv)!;
  const uid = `6155000000000${n}`;
  const [a] = await db<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (uid, batch, status, holder_name, password_enc, cookie_enc, cookie_uid)
    VALUES (${uid}, 'fixtures', 'fleet', ${`old-worker-${n}`}, ${seal(`pw-${n}`, k)},
            ${seal(`c_user=${uid}; xs=xs-made-up-${n}`, k)}, ${uid})
    RETURNING no`;
  await db`INSERT INTO fleet_slots (account_no, role, last_host_id) VALUES (${a.no}, ${role}, 'lab')`;
  return a.no;
}

async function claim(workerId: string, version: string) {
  return api<ClaimAnswer & { error?: string }>('POST', '/api/fleet/worker/claim', {
    headers: bearer(HOST_TOKEN), body: { host_id: 'lab', worker_id: workerId, version, vnc_port: 5901 },
  });
}

async function claimed(workerId: string, version: string): Promise<ClaimAnswer> {
  const r = await claim(workerId, version);
  expect(r.status).toBe(200);
  return r.body;
}

const nextTask = (token: string, done: unknown = null) =>
  api<NextTaskAnswer & { error?: string }>('POST', '/api/fleet/worker/next-task', { headers: bearer(token), body: { done, wait: 0 } });

const heartbeat = (token: string, state: string, version: string) =>
  api<{ ok: boolean }>('POST', '/api/fleet/worker/heartbeat', { headers: bearer(token), body: { state, version } });

const report = (token: string, body: unknown) =>
  api<{ accepted?: boolean; detail?: string; error?: string }>('POST', '/api/fleet/worker/seller/report', { headers: bearer(token), body });

function payload(kind: SellerTaskPayload['kind'], ref: string): SellerTaskPayload {
  switch (kind) {
    case 'ad-post': return {
      ref, kind, location: 'Denver, CO', title: 'We buy server RAM', description: 'Made-up ad text.',
      price_usd: 1, category: 'Electronics', condition: 'Used - Good', photos: [{ url: 'https://example.invalid/p.jpg', sha256: 'ab' }],
    };
    case 'ad-delete': return { ref, kind, fb_listing_id: '100', title: 'We buy server RAM' };
    case 'inbox-sync': return { ref, kind, max_threads: 20, max_messages: 30 };
    case 'msg-send': return { ref, kind, fb_thread_id: 't-1', body: 'Made-up reply', tail: [{ direction: 'in', body: 'Made-up question' }] };
  }
}

async function enqueue(accountNo: number, kind: SellerTaskPayload['kind'], ref = `${kind}-1`, dueAt = new Date(Date.now() - 1000)) {
  const db = getTestDb();
  return db.begin((tx) => enqueueSellerTask(tx, accountNo, kind, ref, payload(kind, ref), dueAt));
}

async function addSearch(): Promise<number> {
  const [t] = await getTestDb()<{ id: number }[]>`
    INSERT INTO fleet_tasks (city, item, kind, due_at, state, reason) VALUES ('houston', 'server_ram', 'search', NOW(), 'ready', 'cadence')
    RETURNING id::int AS id`;
  return t.id;
}

async function taskState(id: number): Promise<{ state: string; account_no: number | null }> {
  const [t] = await getTestDb()<{ state: string; account_no: number | null }[]>`SELECT state, account_no FROM fleet_tasks WHERE id = ${id}`;
  return t;
}

/** Seven hours of search leased from Eastern midnight today, charged to `no`. */
async function spendBudget(no: number): Promise<void> {
  await getTestDb()`
    WITH today AS (SELECT date_trunc('day', NOW() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York' AS start)
    INSERT INTO fleet_tasks (city, item, due_at, state, account_no, leased_at, lease_expires_at, done_at)
    SELECT 'houston', 'server_ram', start, 'done', ${no}, start, start + interval '30 minutes', start + interval '7 hours' FROM today`;
}

beforeEach(async () => {
  await resetDb();
  await seedBase();
  applied.calls = [];
});

describe('claim', () => {
  it('gives a seller slot only to a worker at or above the seller minimum', async () => {
    await seedSlot(1, 'seller');
    expect((await claim('lab-1', OLD)).status).toBe(409);
    expect((await claim('lab-2', SELLS)).status).toBe(200);
  });

  it('still gives a search slot to an older worker', async () => {
    await seedSlot(1, 'search');
    expect((await claim('lab-1', OLD)).status).toBe(200);
  });
});

describe('who gets a seller task', () => {
  it('hands a seller slot its own task in the seller shape', async () => {
    const no = await seedSlot(1, 'seller');
    const { worker_token } = await claimed('lab-1', SELLS);
    const queued = await enqueue(no, 'msg-send', 'msg-7');
    const r = await nextTask(worker_token);
    expect(r.status).toBe(200);
    expect(r.body.task).toMatchObject({
      id: queued!.taskId, kind: 'msg-send', city: null, item: null,
      payload: { ref: 'msg-7', kind: 'msg-send', fb_thread_id: 't-1' },
    });
    expect(r.body.task).not.toHaveProperty('why');
    expect(await taskState(queued!.taskId)).toEqual({ state: 'leased', account_no: no });
  });

  it('never hands a seller task to a search slot, even its own account’s', async () => {
    const no = await seedSlot(1, 'search');
    const { worker_token } = await claimed('lab-1', SELLS);
    const t = await enqueue(no, 'inbox-sync');
    const r = await nextTask(worker_token);
    expect(r.body).toMatchObject({ task: null, reason: 'nothing_due' });
    expect((await taskState(t!.taskId)).state).toBe('ready');
  });

  it('never hands one account’s seller task to another account’s seller slot', async () => {
    await seedSlot(1, 'seller');
    const other = await seedSlot(2, 'seller');
    const { worker_token, account } = await claimed('lab-1', SELLS);
    expect(account.no).not.toBe(other);
    await enqueue(other, 'ad-post');
    expect((await nextTask(worker_token)).body).toMatchObject({ task: null, reason: 'nothing_due' });
  });

  it('never hands a seller task to a worker that reports a version below the minimum', async () => {
    const no = await seedSlot(1, 'seller');
    const { worker_token } = await claimed('lab-1', SELLS);
    // A downgrade on the same lease: the heartbeat's version is what the pick reads.
    expect((await heartbeat(worker_token, 'HEALTHY', OLD)).status).toBe(200);
    await enqueue(no, 'msg-send');
    expect((await nextTask(worker_token)).body).toMatchObject({ task: null, reason: 'nothing_due' });
  });

  it('never hands a search task to a seller slot', async () => {
    await seedSlot(1, 'seller');
    const { worker_token } = await claimed('lab-1', SELLS);
    const s = await addSearch();
    expect((await nextTask(worker_token)).body).toMatchObject({ task: null, reason: 'nothing_due' });
    expect((await taskState(s)).state).toBe('ready');
  });

  it('gives a quarantined seller slot no seller task', async () => {
    const no = await seedSlot(1, 'seller');
    const { worker_token } = await claimed('lab-1', SELLS);
    await getTestDb()`UPDATE fleet_slots SET quarantined_until = NOW() + interval '1 hour' WHERE account_no = ${no}`;
    await enqueue(no, 'msg-send');
    expect((await nextTask(worker_token)).body).toMatchObject({ task: null, reason: 'quarantined' });
  });

  it('leaves a search worker as it was: it takes searches and nothing else', async () => {
    await seedSlot(1, 'search');
    const seller = await seedSlot(2, 'seller');
    const { worker_token } = await claimed('lab-1', OLD);
    await enqueue(seller, 'ad-post');
    const s = await addSearch();
    const r = await nextTask(worker_token);
    expect(r.body.task).toMatchObject({ id: s, kind: 'search', city: { slug: 'houston', name: 'Houston' }, item: 'server_ram', why: 'other' });
  });
});

describe('budget', () => {
  it('does not charge seller minutes to the search budget', async () => {
    const no = await seedSlot(1, 'seller');
    await getTestDb()`
      WITH today AS (SELECT date_trunc('day', NOW() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York' AS start)
      INSERT INTO fleet_tasks (kind, due_at, state, account_no, leased_at, lease_expires_at, done_at, payload)
      SELECT 'inbox-sync', start, 'done', ${no}, start, start + interval '8 hours', start + interval '7 hours', '{"ref":"inbox:x"}'::jsonb FROM today`;
    await getTestDb()`
      INSERT INTO fleet_tasks (kind, due_at, state, account_no, leased_at, lease_expires_at, payload)
      VALUES ('msg-send', NOW(), 'leased', ${no}, NOW() - interval '20 minutes', NOW() + interval '10 minutes', '{"ref":"m-1"}'::jsonb)`;
    const db = getTestDb();
    const [{ minutes }] = await db<{ minutes: number }[]>`SELECT ${minutesTodaySql(db, no)} AS minutes`;
    expect(minutes).toBe(0);
  });

  it('leaves seller minutes out of the fleet_minutes view, and keeps search minutes in it', async () => {
    const no = await seedSlot(1, 'seller');
    const db = getTestDb();
    // Noon to 2 PM Eastern yesterday: whole inside one Eastern day, whenever CI runs.
    const at = db`(date_trunc('day', NOW() AT TIME ZONE 'America/New_York') - interval '12 hours') AT TIME ZONE 'America/New_York'`;
    await db`
      INSERT INTO fleet_tasks (kind, due_at, state, account_no, leased_at, lease_expires_at, done_at, payload)
      SELECT 'msg-send', s, 'done', ${no}, s, s + interval '3 hours', s + interval '2 hours', '{"ref":"m-1"}'::jsonb FROM (SELECT ${at} AS s) x`;
    await db`
      INSERT INTO fleet_tasks (city, item, due_at, state, account_no, leased_at, lease_expires_at, done_at)
      SELECT 'houston', 'server_ram', s, 'done', ${no}, s, s + interval '3 hours', s + interval '30 minutes' FROM (SELECT ${at} AS s) x`;
    await db`
      INSERT INTO fleet_tasks (kind, due_at, state, account_no, leased_at, lease_expires_at, payload)
      VALUES ('inbox-sync', NOW(), 'leased', ${no}, NOW() - interval '20 minutes', NOW() + interval '10 minutes', '{"ref":"inbox:y"}'::jsonb)`;
    const rows = await db<{ minutes: number }[]>`SELECT minutes::float8 AS minutes FROM fleet_minutes WHERE account_no = ${no}`;
    expect(rows.map((r) => Math.round(r.minutes))).toEqual([30]);
  });

  it('still hands a budget-exhausted seller slot its seller tasks', async () => {
    const no = await seedSlot(1, 'seller');
    await spendBudget(no);
    const { worker_token } = await claimed('lab-1', SELLS);
    const t = await enqueue(no, 'inbox-sync');
    const r = await nextTask(worker_token);
    expect(r.body.task).toMatchObject({ id: t!.taskId, kind: 'inbox-sync' });
  });

  it('still stops an exhausted search slot', async () => {
    const no = await seedSlot(1, 'search');
    await spendBudget(no);
    const { worker_token } = await claimed('lab-1', SELLS);
    await addSearch();
    expect((await nextTask(worker_token)).body).toEqual({ task: null, retry_after: 300, reason: 'budget' });
  });
});

describe('lost leases (CONTRACTS §4.5)', () => {
  async function leasedPair() {
    const no = await seedSlot(1, 'seller');
    const { worker_token } = await claimed('lab-1', SELLS);
    const send = await enqueue(no, 'msg-send');
    const sync = await enqueue(no, 'inbox-sync');
    const first = await nextTask(worker_token);
    // One lease per worker at a time; lease the second straight in the table.
    const other = first.body.task!.id === send!.taskId ? sync!.taskId : send!.taskId;
    await getTestDb()`
      UPDATE fleet_tasks SET state = 'leased', worker_id = 'lab-1', epoch = 1, leased_at = NOW(), lease_expires_at = NOW() + interval '30 minutes'
      WHERE id = ${other}`;
    return { no, token: worker_token, send: send!.taskId, sync: sync!.taskId };
  }

  it('release: a send turns uncertain, an inbox sync goes back to ready on its account', async () => {
    const { no, token, send, sync } = await leasedPair();
    expect((await heartbeat(token, 'CHECKPOINT', SELLS)).status).toBe(200);
    expect(await taskState(send)).toEqual({ state: 'uncertain', account_no: no });
    expect(await taskState(sync)).toEqual({ state: 'ready', account_no: no });
  });

  it('pool fence: a send turns uncertain, an inbox sync is cancelled', async () => {
    const { no, send, sync } = await leasedPair();
    await getTestDb()`UPDATE fb_pool_accounts SET holder_name = 'someone-else' WHERE no = ${no}`;
    expect(await taskState(send)).toEqual({ state: 'uncertain', account_no: no });
    expect(await taskState(sync)).toEqual({ state: 'cancelled', account_no: no });
  });

  it('lease expiry: a send turns uncertain, an inbox sync expires', async () => {
    const { no, send, sync } = await leasedPair();
    await reconcile(getTestDb(), new Date(Date.now() + 24 * 3_600_000));
    expect(await taskState(send)).toEqual({ state: 'uncertain', account_no: no });
    expect(await taskState(sync)).toEqual({ state: 'expired', account_no: no });
  });

  it('treats ad-post and ad-delete like a send', async () => {
    const no = await seedSlot(1, 'seller');
    await claimed('lab-1', SELLS);
    const post = await enqueue(no, 'ad-post');
    const del = await enqueue(no, 'ad-delete');
    await getTestDb()`
      UPDATE fleet_tasks SET state = 'leased', worker_id = 'lab-1', epoch = 1, leased_at = NOW(), lease_expires_at = NOW() - interval '1 minute'
      WHERE id IN (${post!.taskId}, ${del!.taskId})`;
    await reconcile(getTestDb());
    expect((await taskState(post!.taskId)).state).toBe('uncertain');
    expect((await taskState(del!.taskId)).state).toBe('uncertain');
  });
});

describe('enqueueSellerTask', () => {
  it('queues one open task per account, kind and ref', async () => {
    const no = await seedSlot(1, 'seller');
    const first = await enqueue(no, 'msg-send', 'msg-1');
    expect(first?.taskId).toBeGreaterThan(0);
    expect(await enqueue(no, 'msg-send', 'msg-1')).toBeNull();
    expect(await enqueue(no, 'msg-send', 'msg-2')).not.toBeNull();
  });

  it('refuses a payload that names another kind or ref', async () => {
    const no = await seedSlot(1, 'seller');
    await expect(getTestDb().begin((tx) => enqueueSellerTask(tx, no, 'msg-send', 'a', payload('msg-send', 'b'), new Date()))).rejects.toThrow();
  });
});

describe('POST /worker/seller/report', () => {
  async function handedSend() {
    const no = await seedSlot(1, 'seller');
    const { worker_token } = await claimed('lab-1', SELLS);
    const t = await enqueue(no, 'msg-send', 'msg-9');
    expect((await nextTask(worker_token)).body.task?.id).toBe(t!.taskId);
    return { no, token: worker_token, taskId: t!.taskId };
  }

  it('stores a report and calls the domain once, however often it is sent', async () => {
    const { no, token, taskId } = await handedSend();
    const body = { task_id: taskId, kind: 'msg-send', ref: 'msg-9', outcome: 'ok', data: { already_sent: false } };
    expect(await report(token, body)).toMatchObject({ status: 200, body: { accepted: true } });
    expect(await report(token, body)).toMatchObject({ status: 200, body: { accepted: true } });
    expect(applied.calls).toEqual([{ accountNo: no, report: body }]);
    const rows = await getTestDb()<{ kind: string }[]>`SELECT kind FROM fleet_task_events WHERE task_id = ${taskId} AND kind = 'seller_report'`;
    expect(rows).toHaveLength(1);
  });

  it('accepts a report after the worker’s epoch moved on, and never answers 401 or 409 for it', async () => {
    const { no, token, taskId } = await handedSend();
    // The account leaves this worker: the slot's epoch moves on and the send turns uncertain.
    await getTestDb()`UPDATE fb_pool_accounts SET holder_name = 'someone-else' WHERE no = ${no}`;
    expect((await nextTask(token)).status).toBe(409);
    const r = await report(token, { task_id: taskId, kind: 'msg-send', ref: 'msg-9', outcome: 'uncertain', detail: 'The send button vanished' });
    expect(r).toMatchObject({ status: 200, body: { accepted: true } });
    expect(applied.calls).toHaveLength(1);
    expect((await taskState(taskId)).state).toBe('uncertain');
  });

  it('answers 200 accepted: false for a task that is not this worker’s', async () => {
    const { token, taskId } = await handedSend();
    const other = await seedSlot(2, 'seller');
    const foreign = await enqueue(other, 'msg-send', 'msg-x');
    for (const body of [
      { task_id: foreign!.taskId, kind: 'msg-send', ref: 'msg-x', outcome: 'failed', detail: 'no' },
      { task_id: taskId, kind: 'msg-send', ref: 'another-ref', outcome: 'failed', detail: 'no' },
      { task_id: taskId, kind: 'ad-post', ref: 'msg-9', outcome: 'failed', detail: 'no' },
      { task_id: 999999, kind: 'msg-send', ref: 'msg-9', outcome: 'failed', detail: 'no' },
    ]) {
      const r = await report(token, body);
      expect(r.status).toBe(200);
      expect(r.body.accepted).toBe(false);
      expect(typeof r.body.detail).toBe('string');
    }
    expect(applied.calls).toHaveLength(0);
  });

  it('answers 422 for a malformed body', async () => {
    const { token, taskId } = await handedSend();
    for (const body of [
      null,
      { task_id: 'x', kind: 'msg-send', ref: 'msg-9', outcome: 'ok' },
      { task_id: taskId, kind: 'search', ref: 'msg-9', outcome: 'ok' },
      { task_id: taskId, kind: 'msg-send', ref: 'msg-9', outcome: 'maybe' },
      { task_id: taskId, kind: 'msg-send', ref: 'msg-9', outcome: 'ok' },
      { task_id: taskId, kind: 'inbox-sync', ref: 'msg-9', outcome: 'ok', data: { threads: [{ fb_thread_id: 't', messages: [] }] } },
    ]) {
      expect((await report(token, body)).status).toBe(422);
    }
  });

  it('answers 401 only for a token that is not genuine', async () => {
    await handedSend();
    expect((await report('nope.nope', { task_id: 1, kind: 'msg-send', ref: 'x', outcome: 'ok' })).status).toBe(401);
  });

  it('takes an inbox sync with its threads', async () => {
    const no = await seedSlot(1, 'seller');
    const { worker_token } = await claimed('lab-1', SELLS);
    const t = await enqueue(no, 'inbox-sync', 'inbox:2026-11-07T10:00');
    await nextTask(worker_token);
    const threads = [{
      fb_thread_id: 't-1', seller_name: 'A Made-Up Seller', listing_title: 'Made-up listing',
      messages: [{ direction: 'in', body: 'Made-up hello', has_image: false }],
    }];
    const r = await report(worker_token, { task_id: t!.taskId, kind: 'inbox-sync', ref: 'inbox:2026-11-07T10:00', outcome: 'ok', data: { threads } });
    expect(r).toMatchObject({ status: 200, body: { accepted: true } });
    expect(applied.calls[0].report.data).toEqual({ threads });
  });
});

describe('POST /worker/seller/screenshot', () => {
  const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

  async function shot(token: string, fields: Record<string, string>, type = 'image/png') {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set('file', new File([PNG], 'shot.png', { type }));
    const res = await app.fetch(new Request('http://test/api/fleet/worker/seller/screenshot', {
      method: 'POST', headers: { ...bearer(token), 'X-Requested-By': 'recycle-erp' }, body: form,
    }), testEnv);
    return { status: res.status, body: await res.json() as { ok: boolean; key?: string; detail?: string; error?: string } };
  }

  it('stores a screenshot for a task handed to this worker', async () => {
    const no = await seedSlot(1, 'seller');
    const { worker_token } = await claimed('lab-1', SELLS);
    const t = await enqueue(no, 'ad-post', 'pl-3');
    await nextTask(worker_token);
    const r = await shot(worker_token, { task_id: String(t!.taskId), ref: 'pl-3', step: 'publish' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.key).toBe('string');
  });

  it('refuses a type that is not an image, and a task that is not this worker’s', async () => {
    const no = await seedSlot(1, 'seller');
    const { worker_token } = await claimed('lab-1', SELLS);
    const t = await enqueue(no, 'ad-post', 'pl-3');
    await nextTask(worker_token);
    expect((await shot(worker_token, { task_id: String(t!.taskId), ref: 'pl-3', step: 'publish' }, 'application/pdf')).status).toBe(422);
    const r = await shot(worker_token, { task_id: String(t!.taskId), ref: 'pl-4', step: 'publish' });
    expect(r).toMatchObject({ status: 200, body: { ok: false } });
  });
});
