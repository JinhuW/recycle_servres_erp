import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ClaimAnswer, FbIpGroup, FleetProxy } from '@recycle-erp/shared';
import { recordExitChanges } from '../src/fleet/proxyExit';
import { exhaustedProxyIds, proxyMarks } from '../src/fleet/proxyMarks';
import { sha256hex } from '../src/fleet/sql';
import { poolKey, seal } from '../src/lib/sealed';
import { ALEX, loginAs } from './helpers/auth';
import { api, testEnv } from './helpers/app';
import { getTestDb, resetDb } from './helpers/db';

// A port is exhausted by what failed on the IP it exits from now, and rotating the
// IP clears that. Every proxy, IP and account here is made up.

const PORT = 10001;
const EXIT = `http://isp.example.net:${PORT}`;
const OLD_IP = '198.51.100.1';
const NEW_IP = '198.51.100.2';
const HOST_TOKEN = 'host-' + randomBytes(16).toString('hex');
const db = () => getTestDb();
const hours = (n: number) => new Date(Date.now() - n * 3_600_000);

let token: string;
let stintNo = 1000;

beforeEach(async () => {
  await resetDb();
  token = (await loginAs(ALEX)).token;
  stintNo = 1000;
});

/** A closed stint, ended `endedAgo` hours back. The pool trigger isn't involved: only /assign and claims write these. */
async function stint(o: { worker?: string; exit?: string | null; ip?: string | null; outcome?: string; endedAgo?: number; known?: boolean; no?: number }) {
  const no = o.no ?? stintNo++;
  const ended = hours(o.endedAgo ?? 1);
  await db()`
    INSERT INTO fb_worker_accounts (worker_id, account_no, uid, proxy_url, proxy_known, exit_ip, started_at, ended_at, outcome)
    VALUES (${o.worker ?? 'lab-1'}, ${no}, ${`615${no}`}, ${o.exit === undefined ? EXIT : o.exit}, ${o.known ?? true}, ${o.ip ?? null},
            ${hours((o.endedAgo ?? 1) + 1)}, ${ended}, ${o.outcome ?? 'retired'})`;
  return no;
}

const failOn = async (n: number, ip: string | null = OLD_IP) => {
  for (let i = 0; i < n; i++) await stint({ ip });
};

const measure = (ip: string, agoHours = 0.1, exit = EXIT) => db()`
  INSERT INTO fleet_proxy_checks (exit, source, checked_at, ok, latency_ms, exit_ip)
  VALUES (${exit}, 'erp', ${hours(agoHours)}, TRUE, 100, ${ip})`;

const moved = (oldIp: string, newIp: string, agoHours = 0.5) => db()`
  INSERT INTO fleet_proxy_exit_changes (exit, source, changed_at, previous_at, old_ip, new_ip)
  VALUES (${EXIT}, 'erp', ${hours(agoHours)}, ${hours(agoHours + 0.1)}, ${oldIp}, ${newIp})`;

const addProxy = async (port = PORT) => (await api<FleetProxy>('POST', '/api/fleet/proxies', {
  token, body: { label: `Decodo ${port}`, url: `http://user:pass@isp.example.net:${port}`, timezone: 'America/New_York' },
})).body;

async function account(n: number): Promise<number> {
  const key = poolKey(testEnv)!;
  const [a] = await db()<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (uid, batch, status, password_enc, totp_enc)
    VALUES (${`6156000000000${n}`}, 'fixtures', 'available', ${seal('pw', key)}, ${seal('ABCDEFGH', key)}) RETURNING no`;
  return a.no;
}

const addSlot = (accountNo: number, proxyId: number) =>
  api<{ error?: string }>('POST', '/api/fleet/slots', { token, body: { account_no: accountNo, proxy_id: proxyId } });

const claim = async () => {
  await db()`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative)
             VALUES ('lab', ${sha256hex(HOST_TOKEN)}, 2, TRUE) ON CONFLICT (host_id) DO NOTHING`;
  return api<ClaimAnswer>('POST', '/api/fleet/worker/claim', {
    headers: { Authorization: `Bearer ${HOST_TOKEN}` },
    body: { host_id: 'lab', worker_id: 'lab-1', version: '0.14.0', vnc_port: 5901 },
  });
};

describe('what exhausts a proxy', () => {
  it('turns on the fifth failed account on the current IP', async () => {
    await measure(OLD_IP);
    await failOn(4);
    expect(await proxyMarks(db())).toMatchObject([{ url: EXIT, ip: OLD_IP, failed: 4, exhausted: false, exhaustedAt: null }]);
    await failOn(1);
    const [mark] = await proxyMarks(db());
    expect(mark).toMatchObject({ failed: 5, exhausted: true });
    expect(mark!.exhaustedAt).not.toBeNull();
  });

  it('counts one account once, and only failures', async () => {
    await measure(OLD_IP);
    for (let i = 0; i < 6; i++) await stint({ ip: OLD_IP, no: 7, endedAgo: i + 1 });
    await stint({ ip: OLD_IP, outcome: 'available' });
    expect(await proxyMarks(db())).toMatchObject([{ failed: 1, exhausted: false }]);
  });

  it('clears when a check reads a new IP, and comes back on a rotation back to the burned one', async () => {
    await measure(OLD_IP, 2);
    await failOn(5);
    expect((await proxyMarks(db()))[0]!.exhausted).toBe(true);

    await moved(OLD_IP, NEW_IP);
    await measure(NEW_IP);
    expect(await proxyMarks(db())).toEqual([]);

    await measure(OLD_IP, 0.01);
    expect((await proxyMarks(db()))[0]).toMatchObject({ ip: OLD_IP, failed: 5, exhausted: true });
  });

  it('holds a stint with no IP against the current one until the port last moved', async () => {
    await measure(NEW_IP);
    await failOn(5, null);
    expect((await proxyMarks(db()))[0]).toMatchObject({ failed: 5, exhausted: true });
    await moved(OLD_IP, NEW_IP);
    expect(await proxyMarks(db())).toEqual([]);
    await stint({ ip: null, endedAgo: 0.1 });
    expect(await proxyMarks(db())).toMatchObject([{ failed: 1, exhausted: false }]);
  });

  it('is not cleared by a move in geo alone', async () => {
    await measure(OLD_IP);
    await failOn(5);
    await moved(OLD_IP, OLD_IP);
    expect((await proxyMarks(db()))[0]!.exhausted).toBe(true);
  });

  it('is cleared by a revive', async () => {
    await measure(OLD_IP);
    await failOn(5);
    const r = await api<{ proxies: unknown[] }>('POST', '/api/facebook-pool/proxies/revive', { token, body: { url: EXIT } });
    expect(r.body.proxies).toEqual([]);
  });
});

describe('an exhausted proxy is not available', () => {
  it('flags the list, and refuses Add to fleet and Change proxy until the IP rotates', async () => {
    const spent = await addProxy();
    const other = await addProxy(10002);
    const moving = await account(1);
    expect((await addSlot(moving, other.id)).status).toBe(201);
    await measure(OLD_IP, 2);
    await failOn(5);

    expect(await exhaustedProxyIds(db())).toEqual([spent.id]);
    const listed = (await api<FleetProxy[]>('GET', '/api/fleet/proxies', { token })).body;
    expect(listed.map((p) => [p.id, p.exhausted])).toEqual([[spent.id, true], [other.id, false]]);

    const refused = await addSlot(await account(2), spent.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('proxy_exhausted');
    const change = await api<{ error?: string }>('POST', `/api/fleet/slots/${moving}/proxy`, {
      token, body: { proxy_id: spent.id, from_proxy_id: other.id, confirm: true },
    });
    expect(change.body.error).toBe('proxy_exhausted');

    await moved(OLD_IP, NEW_IP);
    await measure(NEW_IP);
    expect(await exhaustedProxyIds(db())).toEqual([]);
    expect((await addSlot(await account(3), spent.id)).status).toBe(201);
  });

  it('makes a claim wait for the rotation, and leaves a running account alone', async () => {
    const proxy = await addProxy();
    const running = await account(1);
    expect((await addSlot(running, proxy.id)).status).toBe(201);
    await measure(OLD_IP, 2);
    expect((await claim()).status).toBe(200);
    const [leased] = await db()<{ lease_expires_at: Date; epoch: number }[]>`
      SELECT lease_expires_at, epoch FROM fleet_slots WHERE account_no = ${running}`;

    await failOn(5);
    const [still] = await db()<{ lease_expires_at: Date; epoch: number }[]>`
      SELECT lease_expires_at, epoch FROM fleet_slots WHERE account_no = ${running}`;
    expect(still).toEqual(leased);

    // Its lease lapsing is what would send it through another login.
    await db()`UPDATE fleet_slots SET lease_expires_at = NOW() - interval '1 minute', worker_id = NULL WHERE account_no = ${running}`;
    await db()`DELETE FROM fleet_workers`;
    expect((await claim()).status).toBe(409);

    await moved(OLD_IP, NEW_IP);
    await measure(NEW_IP);
    const claimed = await claim();
    expect(claimed.status).toBe(200);
    expect(claimed.body.account.no).toBe(running);
  });
});

describe('the IP on a stint', () => {
  it('is stamped at claim and follows its port while the stint is open', async () => {
    const proxy = await addProxy();
    const no = await account(1);
    expect((await addSlot(no, proxy.id)).status).toBe(201);
    await measure(OLD_IP, 2);
    expect((await claim()).status).toBe(200);
    const ipOf = async () => (await db()<{ exit_ip: string | null }[]>`
      SELECT exit_ip FROM fb_worker_accounts WHERE account_no = ${no} AND ended_at IS NULL`)[0]!.exit_ip;
    expect(await ipOf()).toBe(OLD_IP);

    await db().begin((tx) => recordExitChanges(tx, [{
      exit: EXIT, source: 'erp', proxy_id: proxy.id, workers: [], ok: true, latency_ms: 100, exit_ip: NEW_IP,
      city: null, region: null, country: null, org: null, timezone: null, error: null,
    }], new Date()));
    expect(await ipOf()).toBe(NEW_IP);
  });

  it('is backfilled from the checks kept, and left NULL where none covers it', async () => {
    const start = (agoHours: number) => hours(agoHours);
    await measure(OLD_IP, 10);
    await measure(NEW_IP, 2);
    const insert = (no: number, s: number, e: number | null, url = EXIT) => db()`
      INSERT INTO fb_worker_accounts (worker_id, account_no, uid, proxy_url, proxy_known, started_at, ended_at, outcome)
      VALUES ('lab-1', ${no}, ${`615${no}`}, ${url}, TRUE, ${start(s)}, ${e === null ? null : start(e)}, ${e === null ? null : 'retired'})`;
    await insert(1, 5, 4); // After the first reading: that one.
    await insert(2, 20, 5); // Before any reading, ending after one: the first during it.
    await insert(3, 40, 30); // No check covers it.
    await insert(4, 20, null); // Open: where it is now.
    await insert(5, 5, 4, 'http://other.example.net:1'); // Another port's readings say nothing.
    const migration = readFileSync(new URL('../migrations/0230_fb_worker_accounts_exit_ip.sql', import.meta.url), 'utf8');
    await db().unsafe(migration.slice(migration.indexOf('UPDATE fb_worker_accounts')));
    const rows = await db()<{ account_no: number; exit_ip: string | null }[]>`
      SELECT account_no, exit_ip FROM fb_worker_accounts ORDER BY account_no`;
    expect(rows.map((r) => r.exit_ip)).toEqual([OLD_IP, OLD_IP, null, NEW_IP, null]);
  });
});

describe('GET /workers/:worker/ips', () => {
  const ips = async (worker = 'lab-1') =>
    (await api<{ ips: FbIpGroup[] }>('GET', `/api/facebook-pool/workers/${worker}/ips`, { token })).body.ips;

  it('groups by IP with each one\'s status, and takes in other workers\' accounts on it', async () => {
    const OTHER_EXIT = 'http://isp.example.net:10002';
    await moved(OLD_IP, NEW_IP, 3);
    await measure(NEW_IP);
    await stint({ ip: OLD_IP, no: 1, endedAgo: 20 });
    await stint({ ip: OLD_IP, no: 2, worker: 'lab-2', endedAgo: 30 });
    await stint({ ip: NEW_IP, no: 3, endedAgo: 2, outcome: 'available' });
    // Exhausted on another port, on which lab-1 has been.
    await measure('203.0.113.9', 0.1, OTHER_EXIT);
    await stint({ exit: OTHER_EXIT, ip: '203.0.113.9', no: 4, endedAgo: 10 });
    for (const no of [5, 6, 7, 8]) await stint({ exit: OTHER_EXIT, ip: '203.0.113.9', no, worker: 'lab-2', endedAgo: 11 });
    // Nothing of lab-2's alone reaches lab-1's page.
    await stint({ ip: '192.0.2.77', no: 9, worker: 'lab-2' });
    await stint({ exit: null, ip: null, no: 10, worker: 'lab-2' });
    // lab-1's own with no IP, and on the VM's.
    await stint({ exit: EXIT, ip: null, no: 11, endedAgo: 100 });
    await stint({ exit: null, ip: null, no: 12, endedAgo: 200 });

    const groups = await ips();
    const summary = groups.map((g) => [g.kind, g.ip, g.status, g.failed, g.stints.map((s) => s.accountNo).sort((a, b) => a - b)]);
    expect(summary).toEqual([
      ['ip', NEW_IP, 'active', 0, [3]],
      ['ip', '203.0.113.9', 'exhausted', 5, [4, 5, 6, 7, 8]],
      ['ip', OLD_IP, 'deprecated', 2, [1, 2]],
      ['unrecorded', null, null, 1, [11]],
      ['vm', null, null, 1, [12]],
    ]);
    expect(groups[2]!.stints.map((s) => s.workerId).sort()).toEqual(['lab-1', 'lab-2']);
  });

  it('puts the IP the worker is on now first, and refuses a bad worker id', async () => {
    await measure(OLD_IP);
    await stint({ ip: NEW_IP, no: 1, endedAgo: 1 });
    await db()`
      INSERT INTO fb_worker_accounts (worker_id, account_no, uid, proxy_url, proxy_known, exit_ip, started_at)
      VALUES ('lab-1', 2, '6152', ${EXIT}, TRUE, ${OLD_IP}, ${hours(40)})`;
    const groups = await ips();
    expect(groups[0]).toMatchObject({ ip: OLD_IP, current: true, status: 'active' });
    expect(groups[1]).toMatchObject({ ip: NEW_IP, current: false, status: 'deprecated' });
    expect((await api('GET', '/api/facebook-pool/workers/a.b/ips', { token })).status).toBe(400);
  });

  it('leaves the worker\'s own stints as they were, for its History', async () => {
    await stint({ ip: OLD_IP, no: 1 });
    await stint({ ip: OLD_IP, no: 2, worker: 'lab-2' });
    const own = await api<{ stints: { accountNo: number }[] }>('GET', '/api/facebook-pool/workers/lab-1/accounts', { token });
    expect(own.body.stints.map((s) => s.accountNo)).toEqual([1]);
    expect((await ips())[0]!.stints).toHaveLength(2);
  });
});
