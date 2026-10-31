// A4-01 repro: a lease that lapsed while the ERP was unreachable is treated as
// free, so the first /desired after recovery asks the host for new workers and
// the new worker's claim fences a live worker. Asserts the SAFE behaviour, so
// a failing test reproduces the claim.
import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { getTestDb, resetDb } from '../../../../apps/backend/tests/helpers/db';
import { api, testEnv } from '../../../../apps/backend/tests/helpers/app';
import { sha256hex } from '../../../../apps/backend/src/fleet/sql';
import { poolKey, seal } from '../../../../apps/backend/src/lib/sealed';

const A = 'host-a-' + randomBytes(8).toString('hex');
const B = 'host-b-' + randomBytes(8).toString('hex');
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function seed() {
  const db = getTestDb();
  const k = poolKey(testEnv)!;
  await db`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative, last_seen_at)
           VALUES ('a', ${sha256hex(A)}, 10, TRUE, NOW()), ('b', ${sha256hex(B)}, 10, TRUE, NOW())`;
  await db`INSERT INTO fleet_items (name, phrases) VALUES ('server_ram', '["server ram"]')`;
  for (let n = 1; n <= 12; n++) {
    const [a] = await db<{ no: number }[]>`
      INSERT INTO fb_pool_accounts (uid, batch, status, password_enc, cookie_enc)
      VALUES (${`61550000000${String(n).padStart(2, '0')}`}, 'fixtures', 'fleet', ${seal(`pw-${n}`, k)}, ${seal(`c_user=6155${n}; xs=x`, k)})
      RETURNING no`;
    await db`INSERT INTO fleet_slots (account_no, last_host_id) VALUES (${a.no}, ${n <= 8 ? 'a' : 'b'})`;
  }
}
const claim = (worker: string, token: string, host: string) =>
  api<any>('POST', '/api/fleet/worker/claim', { headers: bearer(token), body: { host_id: host, worker_id: worker, version: '0.15.0', vnc_port: 5901 } });
const heartbeat = (token: string) =>
  api<any>('POST', '/api/fleet/worker/heartbeat', { headers: bearer(token), body: { state: 'HEALTHY', version: '0.15.0' } });
const desired = (token: string, host: string) => api<any>('GET', `/api/fleet/hosts/${host}/desired`, { headers: bearer(token) });

describe('A4-01 lapsed leases after an ERP outage', () => {
  beforeEach(async () => { await resetDb(); await seed(); });

  it('does not start or let a new worker fence a live one whose lease lapsed during an outage', async () => {
    const tokens: Record<string, string> = {};
    for (let n = 1; n <= 8; n++) { const r = await claim(`a-${n}`, A, 'a'); expect(r.status).toBe(200); tokens[`a-${n}`] = r.body.worker_token; }
    for (let n = 1; n <= 4; n++) { const r = await claim(`b-${n}`, B, 'b'); expect(r.status).toBe(200); tokens[`b-${n}`] = r.body.worker_token; }
    const before = await desired(B, 'b');
    console.log('A4-01 desired(b) before outage:', before.body.count);
    expect(before.body.count).toBe(4);

    // ERP/DB unreachable > lease_minutes (30): every lease lapses, nobody heartbeats.
    const db = getTestDb();
    await db`UPDATE fleet_slots SET lease_expires_at = NOW() - interval '1 minute'`;
    await db`UPDATE fleet_hosts SET last_seen_at = NOW()`;

    // Recovery: b's agent polls before b-1..b-4 heartbeat.
    const after = await desired(B, 'b');
    console.log('A4-01 desired(b) after recovery:', after.body.count);
    const b5 = await claim('b-5', B, 'b');
    const [b1slot] = await db<any[]>`SELECT s.account_no, s.worker_id, s.epoch FROM fleet_slots s JOIN fleet_workers w ON w.account_no = s.account_no WHERE w.worker_id = 'b-1'`;
    console.log('A4-01 b-5 claim:', b5.status, 'account', b5.body?.account?.no, '| b-1 slot now held by', b1slot?.worker_id);
    const hb = await heartbeat(tokens['b-1']);
    console.log('A4-01 b-1 heartbeat after b-5 claim:', hb.status, JSON.stringify(hb.body));

    expect(after.body.count).toBe(4);
    expect(b5.status).not.toBe(200);
    expect(hb.status).toBe(200);
  });
});
