import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { ClaimAnswer, ClaimTicketAnswer } from '@recycle-erp/shared';
import { getTestDb, resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { sha256hex } from '../src/fleet/sql';
import { poolKey, seal } from '../src/lib/sealed';

// Per-container claim tickets: the agent mints one before each `docker run`
// and the worker claims with it instead of the host token. Every account,
// host and token here is made up.

const HOST_TOKEN = 'a'.repeat(8) + randomBytes(28).toString('hex');
const OTHER_HOST_TOKEN = 'b'.repeat(8) + randomBytes(28).toString('hex');

type Headers = Record<string, string>;
const bearer = (token: string): Headers => ({ Authorization: `Bearer ${token}` });

async function seed(): Promise<void> {
  const db = getTestDb();
  await db`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative)
           VALUES ('lab', ${sha256hex(HOST_TOKEN)}, 2, TRUE), ('other', ${sha256hex(OTHER_HOST_TOKEN)}, 1, TRUE)`;
  await db`INSERT INTO fleet_items (name, phrases, filters) VALUES ('server_ram', '["server ram"]', '{}')`;
}

async function seedSlot(n: number): Promise<number> {
  const db = getTestDb();
  const k = poolKey(testEnv)!;
  const uid = `6155000000000${n}`;
  const [a] = await db<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (uid, batch, status, holder_name, password_enc, totp_enc, cookie_enc, cookie_uid)
    VALUES (${uid}, 'fixtures', 'fleet', ${`old-worker-${n}`}, ${seal(`pw-${n}`, k)}, ${seal(`abcd-${n}`, k)},
            ${seal(`c_user=${uid}; xs=xs-${n}`, k)}, ${uid})
    RETURNING no`;
  await db`INSERT INTO fleet_slots (account_no) VALUES (${a.no})`;
  return a.no;
}

const mint = (body: Record<string, unknown>, token = HOST_TOKEN, hostId = 'lab', extra: Headers = {}) =>
  api<ClaimTicketAnswer & { error?: string; detail?: string }>('POST', `/api/fleet/hosts/${hostId}/tickets`, {
    headers: { ...bearer(token), ...extra }, body,
  });

async function ticketFor(workerId: string, handoff?: number): Promise<string> {
  const r = await mint({ worker_id: workerId, ...(handoff !== undefined ? { handoff_epoch: handoff } : {}) });
  expect(r.status).toBe(200);
  return r.body.ticket;
}

const claim = (token: string, workerId: string, more: Record<string, unknown> = {}, hostId = 'lab') =>
  api<ClaimAnswer & { error?: string; detail?: string }>('POST', '/api/fleet/worker/claim', {
    headers: bearer(token),
    body: { host_id: hostId, worker_id: workerId, version: '0.14.5', vnc_port: 5901, ...more },
  });

describe('POST /api/fleet/hosts/:id/tickets', () => {
  beforeEach(async () => { await resetDb(); await seed(); });

  it('mints a ticket for one of the host’s workers, kept only as a hash with a ten-minute life', async () => {
    const before = Date.now();
    const r = await mint({ worker_id: 'lab-1', handoff_epoch: 4 });
    expect(r.status).toBe(200);
    expect(r.body.ticket).toMatch(/^fct_[A-Za-z0-9_-]{43}$/);
    const expires = Date.parse(r.body.expires_at);
    expect(expires).toBeGreaterThan(before + 9 * 60_000);
    expect(expires).toBeLessThan(before + 11 * 60_000);
    const rows = await getTestDb()<Record<string, unknown>[]>`SELECT * FROM fleet_claim_tickets`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ token_hash: sha256hex(r.body.ticket), host_id: 'lab', worker_id: 'lab-1', handoff_epoch: 4, consumed_at: null });
    expect(JSON.stringify(rows)).not.toContain(r.body.ticket);
  });

  it('is host scope, for the host’s own worker ids, and checks the body', async () => {
    expect((await mint({ worker_id: 'lab-1' }, 'nope')).status).toBe(401);
    expect((await mint({ worker_id: 'lab-1' }, OTHER_HOST_TOKEN)).status).toBe(401);
    expect((await mint({ worker_id: 'other-1' })).status).toBe(422);
    expect((await mint({ worker_id: 'lab-x' })).status).toBe(422);
    expect((await mint({})).status).toBe(422);
    expect((await mint({ worker_id: 'lab-1', handoff_epoch: -1 })).status).toBe(422);
    expect((await mint({ worker_id: 'lab-1', handoff_epoch: '3' })).status).toBe(422);
  });

  it('needs no CSRF header: the agent posts with a bearer and no cookie', async () => {
    expect((await mint({ worker_id: 'lab-1' }, HOST_TOKEN, 'lab', { 'X-Requested-By': 'fleet-agent' })).status).toBe(200);
  });

  it('voids the worker’s older tickets and sweeps expired ones', async () => {
    const first = await ticketFor('lab-1');
    await getTestDb()`INSERT INTO fleet_claim_tickets (token_hash, host_id, worker_id, expires_at)
                      VALUES ('stale', 'lab', 'lab-2', NOW() - interval '1 minute')`;
    await ticketFor('lab-1');
    const rows = await getTestDb()<{ token_hash: string }[]>`SELECT token_hash FROM fleet_claim_tickets`;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(sha256hex(first));
    await seedSlot(1);
    expect((await claim(first, 'lab-1')).body).toEqual({ error: 'unauthorized', detail: 'bad_ticket' });
  });

  it('refuses a second agent instance for the host, as desired and report do', async () => {
    expect((await mint({ worker_id: 'lab-1' }, HOST_TOKEN, 'lab', { 'X-Fleet-Agent-Instance': 'agent-a' })).status).toBe(200);
    const r = await mint({ worker_id: 'lab-1' }, HOST_TOKEN, 'lab', { 'X-Fleet-Agent-Instance': 'agent-b' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('agent_conflict');
  });
});

describe('POST /api/fleet/worker/claim with a ticket', () => {
  beforeEach(async () => { await resetDb(); await seed(); });

  it('claims once; a retry of the same boot (claim_id) is the same answer, any other claim is refused', async () => {
    const no = await seedSlot(1);
    await seedSlot(2);
    const ticket = await ticketFor('lab-1');
    const first = await claim(ticket, 'lab-1', { claim_id: 'boot-1' });
    expect(first.status).toBe(200);
    expect(first.body.account).toMatchObject({ no, password: 'pw-1' });
    const [row] = await getTestDb()<{ consumed_at: Date | null; claim_id: string }[]>`SELECT consumed_at, claim_id FROM fleet_claim_tickets`;
    expect(row.consumed_at).not.toBeNull();
    expect(row.claim_id).toBe('boot-1');

    const retry = await claim(ticket, 'lab-1', { claim_id: 'boot-1' });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ epoch: first.body.epoch, account: { no } });

    expect((await claim(ticket, 'lab-1', { claim_id: 'boot-2' })).body).toEqual({ error: 'unauthorized', detail: 'used_ticket' });
    expect((await claim(ticket, 'lab-1')).body).toEqual({ error: 'unauthorized', detail: 'used_ticket' });
  });

  it('two boots racing with one ticket: one claims, the other is refused', async () => {
    await seedSlot(1);
    await seedSlot(2);
    const ticket = await ticketFor('lab-1');
    const rs = await Promise.all([claim(ticket, 'lab-1', { claim_id: 'a' }), claim(ticket, 'lab-1', { claim_id: 'b' })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 401]);
    const slots = await getTestDb()<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM fleet_slots WHERE worker_id = 'lab-1'`;
    expect(slots[0].n).toBe(1);
  });

  it('a no_slot answer leaves the ticket unspent', async () => {
    const ticket = await ticketFor('lab-1');
    expect((await claim(ticket, 'lab-1', { claim_id: 'a' })).body).toEqual({ error: 'no_slot' });
    await seedSlot(1);
    expect((await claim(ticket, 'lab-1', { claim_id: 'b' })).status).toBe(200);
  });

  it('is bound to its worker id, its handoff epoch and its host', async () => {
    await seedSlot(1);
    const ticket = await ticketFor('lab-1');
    expect((await claim(ticket, 'lab-2')).body).toEqual({ error: 'unauthorized', detail: 'ticket_mismatch' });
    expect((await claim(ticket, 'lab-1', { handoff_epoch: 3 })).body).toEqual({ error: 'unauthorized', detail: 'ticket_mismatch' });
    expect((await claim(ticket, 'other-1', {}, 'other')).status).toBe(422);
    expect((await claim(ticket, 'lab-1', {}, 'other')).status).toBe(422);

    const handoff = await ticketFor('lab-2', 3);
    expect((await claim(handoff, 'lab-2')).body).toEqual({ error: 'unauthorized', detail: 'ticket_mismatch' });
    expect((await claim(handoff, 'lab-2', { handoff_epoch: 4 })).body).toEqual({ error: 'unauthorized', detail: 'ticket_mismatch' });
    // Nothing was spent by the refusals.
    expect((await claim(ticket, 'lab-1')).status).toBe(200);
  });

  it('expires, even for a retry of the boot that spent it', async () => {
    await seedSlot(1);
    const ticket = await ticketFor('lab-1');
    expect((await claim(ticket, 'lab-1', { claim_id: 'boot-1' })).status).toBe(200);
    await getTestDb()`UPDATE fleet_claim_tickets SET expires_at = NOW() - interval '1 second'`;
    expect((await claim(ticket, 'lab-1', { claim_id: 'boot-1' })).body).toEqual({ error: 'unauthorized', detail: 'expired_ticket' });

    await seedSlot(2);
    const unused = await ticketFor('lab-2');
    await getTestDb()`UPDATE fleet_claim_tickets SET expires_at = NOW() - interval '1 second' WHERE worker_id = 'lab-2'`;
    expect((await claim(unused, 'lab-2')).body).toEqual({ error: 'unauthorized', detail: 'expired_ticket' });
    expect((await claim('fct_' + 'x'.repeat(43), 'lab-2')).body).toEqual({ error: 'unauthorized', detail: 'bad_ticket' });
  });

  it('reaches no host route: desired, report, stopped and tickets all answer 401', async () => {
    const no = await seedSlot(1);
    const ticket = await ticketFor('lab-1');
    const a = await claim(ticket, 'lab-1', { claim_id: 'boot-1' });
    expect(a.status).toBe(200);
    const fresh = await ticketFor('lab-2');
    for (const t of [ticket, fresh]) {
      expect((await api('GET', '/api/fleet/hosts/lab/desired', { headers: bearer(t) })).status).toBe(401);
      expect((await api('POST', '/api/fleet/hosts/lab/report', { headers: bearer(t), body: { version: 'x', containers: [] } })).status).toBe(401);
      expect((await api('POST', '/api/fleet/hosts/lab/stopped', {
        headers: bearer(t), body: { worker_id: 'lab-1', account_no: no, epoch: a.body.epoch, restart: false },
      })).status).toBe(401);
      expect((await mint({ worker_id: 'lab-3' }, t)).status).toBe(401);
    }
    // The fence did not move: lab-1 still holds its epoch.
    const [slot] = await getTestDb()<{ epoch: number; worker_id: string }[]>`SELECT epoch, worker_id FROM fleet_slots WHERE account_no = ${no}`;
    expect(slot).toEqual({ epoch: a.body.epoch, worker_id: 'lab-1' });
  });

  it('the host token still claims (older agents and workers)', async () => {
    await seedSlot(1);
    expect((await claim(HOST_TOKEN, 'lab-1')).status).toBe(200);
  });
});
