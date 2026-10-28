import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { fleetDeviceFor, FLEET_SCREENS, type ClaimAnswer, type FleetProxy, type FleetSlot } from '@recycle-erp/shared';
import { getTestDb, resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { ALEX, MARCUS, loginAs } from './helpers/auth';
import { sha256hex } from '../src/fleet/sql';
import { poolKey, seal, unseal } from '../src/lib/sealed';

// The proxy list and putting pool accounts into the fleet (and out again).
// Every proxy, login and account here is made up.

const LOGIN = 'decodo-user-' + randomBytes(4).toString('hex');
const SECRET = 'pw-' + randomBytes(8).toString('hex');
const url = (port: number, user = LOGIN, pass = SECRET) => `http://${user}:${pass}@isp.example.net:${port}`;
const HOST_TOKEN = 'host-' + randomBytes(16).toString('hex');
const key = () => poolKey(testEnv)!;

type SlotView = FleetSlot & { uid: string | null; pool_status: string };
type Err = { error: string; detail?: string };

let token: string;
// Every log line the requests write, so no login can slip out unseen.
let logged: string[] = [];

async function account(n: number, o: { status?: string; holder?: string | null; password?: boolean; totp?: boolean } = {}): Promise<number> {
  const k = key();
  const [a] = await getTestDb()<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (uid, batch, status, holder_name, password_enc, totp_enc)
    VALUES (${`6156000000000${n}`}, 'fixtures', ${o.status ?? 'available'}, ${o.holder ?? null},
            ${o.password === false ? null : seal(`fb-pw-${n}`, k)}, ${o.totp === false ? null : seal('ABCDEFGH', k)})
    RETURNING no`;
  return a.no;
}

const addProxy = (body: unknown) => api<FleetProxy & Err>('POST', '/api/fleet/proxies', { token, body });
const listProxies = async () => (await api<FleetProxy[]>('GET', '/api/fleet/proxies', { token })).body;
const addSlot = (body: unknown) => api<{ slot: SlotView } & Err>('POST', '/api/fleet/slots', { token, body });
const removeSlot = (no: number) => api<{ ok: true; pool_status: string } & Err>('POST', `/api/fleet/slots/${no}/remove`, { token });
const pool = async (no: number) =>
  (await getTestDb()<{ status: string; holder_name: string | null }[]>`SELECT status, holder_name FROM fb_pool_accounts WHERE no = ${no}`)[0];

function noSecret(v: unknown): void {
  const text = JSON.stringify(v);
  expect(text).not.toContain(LOGIN);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain('url_enc');
  expect(text).not.toContain('v1.');
}

beforeEach(async () => {
  await resetDb();
  token = (await loginAs(ALEX)).token;
  logged = [];
  const capture = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});

afterEach(() => {
  for (const line of logged) {
    expect(line).not.toContain(LOGIN);
    expect(line).not.toContain(SECRET);
  }
  vi.restoreAllMocks();
});

describe('proxies', () => {
  it('adds, lists, edits and removes a proxy without ever answering its login', async () => {
    const made = await addProxy({ label: 'Decodo NY 1', url: url(10001), timezone: 'America/New_York', note: 'pair A' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ label: 'Decodo NY 1', host: 'isp.example.net', port: 10001, timezone: 'America/New_York', note: 'pair A', slots: [] });
    noSecret(made.body);
    const [row] = await getTestDb()<{ url_enc: string }[]>`SELECT url_enc FROM fleet_proxies WHERE id = ${made.body.id}`;
    expect(row.url_enc).not.toContain(SECRET);
    expect(unseal(row.url_enc, key())).toBe(url(10001));

    const list = await listProxies();
    expect(list).toHaveLength(1);
    noSecret(list);

    // The same exit twice is refused, whatever the login or the case.
    const dupe = await addProxy({ label: 'again', url: url(10001, 'other', 'login').replace('isp.', 'ISP.'), timezone: 'America/New_York' });
    expect(dupe.status).toBe(409);
    expect(dupe.body.error).toBe('exists');
    noSecret(dupe.body);

    const put = await api<FleetProxy>('PUT', `/api/fleet/proxies/${made.body.id}`, { token, body: { label: 'NY 1', timezone: 'America/Chicago' } });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ label: 'NY 1', timezone: 'America/Chicago', note: 'pair A', port: 10001 });
    const moved = await api<FleetProxy>('PUT', `/api/fleet/proxies/${made.body.id}`, { token, body: { url: url(10002, 'new-user', 'new-pass') } });
    expect(moved.body).toMatchObject({ host: 'isp.example.net', port: 10002 });
    noSecret(moved.body);
    expect(JSON.stringify(moved.body)).not.toContain('new-pass');

    expect((await api('DELETE', `/api/fleet/proxies/${made.body.id}`, { token })).status).toBe(200);
    expect(await listProxies()).toEqual([]);
    expect((await api('DELETE', `/api/fleet/proxies/${made.body.id}`, { token })).status).toBe(404);
  });

  it('validates the body and never echoes a bad URL', async () => {
    const cases: Array<[unknown, string]> = [
      [{ label: '', url: url(1), timezone: 'America/New_York' }, 'label'],
      [{ label: 'x', url: `ftp://${LOGIN}:${SECRET}@h.example:21`, timezone: 'America/New_York' }, 'scheme'],
      [{ label: 'x', url: `http://${LOGIN}:${SECRET}@h.example`, timezone: 'America/New_York' }, 'port'],
      [{ label: 'x', url: `http://${LOGIN}:${SECRET}@h.example:99999`, timezone: 'America/New_York' }, 'port'],
      [{ label: 'x', url: `http://${LOGIN}:${SECRET}@h.example:10/path`, timezone: 'America/New_York' }, 'url'],
      [{ label: 'x', url: `http://${LOGIN}@h.example:10`, timezone: 'America/New_York' }, 'url'],
      [{ label: 'x', url: url(1), timezone: 'Mars/Olympus' }, 'timezone'],
      [{ label: 'x', url: url(1), timezone: 'EST' }, 'timezone'],
      [{ label: 'x', url: url(1), timezone: 'America/New_York', extra: 1 }, 'extra'],
    ];
    for (const [body, word] of cases) {
      const r = await addProxy(body);
      expect(r.status, word).toBe(422);
      expect(r.body.detail).toContain(word);
      noSecret(r.body);
    }
    // A proxy with no login (an allow-listed IP) is fine, and so is socks5.
    expect((await addProxy({ label: 'open', url: 'socks5://10.0.0.5:1080', timezone: 'UTC' })).status).toBe(201);
    expect((await api('PUT', '/api/fleet/proxies/999', { token, body: { label: 'x' } })).status).toBe(404);
    expect((await api('PUT', '/api/fleet/proxies/1', { token, body: {} })).status).toBe(422);
  });

  it('is manager scope', async () => {
    expect((await api('GET', '/api/fleet/proxies')).status).toBe(401);
    const marcus = await loginAs(MARCUS);
    expect((await api('GET', '/api/fleet/proxies', { token: marcus.token })).status).toBe(403);
    expect((await api('POST', '/api/fleet/slots', { token: marcus.token, body: { account_no: 1, proxy_id: 1 } })).status).toBe(403);
  });
});

describe('add to fleet', () => {
  let proxyId: number;
  beforeEach(async () => {
    proxyId = (await addProxy({ label: 'Decodo NY 1', url: url(10001), timezone: 'America/New_York' })).body.id;
    await getTestDb()`INSERT INTO fleet_cities (slug, name, enabled) VALUES ('nyc', 'New York', TRUE), ('philly', 'Philadelphia', TRUE)`;
  });

  it('makes the slot with the proxy and a generated device, and puts the pool row in the fleet', async () => {
    const no = await account(1);
    const r = await addSlot({ account_no: no, proxy_id: proxyId });
    expect(r.status).toBe(201);
    noSecret(r.body);
    expect(r.body.slot).toMatchObject({
      account_no: no, has_proxy: true, proxy_id: proxyId, parked: false, worker_id: null,
      pool_status: 'fleet', epoch: 0,
    });
    expect(r.body.slot.device).toEqual(fleetDeviceFor(no, 'America/New_York'));
    expect(r.body.slot.device!.user_agent).toBeUndefined();
    expect(r.body.slot.device!.native).toEqual(['user_agent']);
    expect(await pool(no)).toEqual({ status: 'fleet', holder_name: 'ERP fleet' });
    const db = getTestDb();
    const [ev] = await db<{ kind: string; status: string; detail: string; actor_name: string }[]>`
      SELECT kind, status, detail, actor_name FROM fb_pool_events WHERE account_no = ${no} ORDER BY created_at DESC LIMIT 1`;
    expect(ev).toMatchObject({ kind: 'assigned', status: 'fleet', detail: 'ERP fleet' });
    // The pool trigger opened a stint, as it does for any fleet holder.
    const stints = await db`SELECT worker_id FROM fb_worker_accounts WHERE account_no = ${no} AND ended_at IS NULL`;
    expect(stints).toEqual([{ worker_id: 'ERP fleet' }]);
    const [slot] = await db<{ proxy_url: string }[]>`SELECT proxy_url FROM fleet_slots WHERE account_no = ${no}`;
    expect(unseal(slot.proxy_url, key())).toBe(url(10001));
    // The proxy list names the slot.
    expect((await listProxies())[0].slots).toEqual([{ account_no: no, pool_status: 'fleet', parked: false, leased: false }]);
  });

  it('hands the worker the proxy and device on claim, and an edited proxy reaches the slot', async () => {
    const db = getTestDb();
    await db`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative) VALUES ('lab', ${sha256hex(HOST_TOKEN)}, 4, TRUE)`;
    const no = await account(1);
    await addSlot({ account_no: no, proxy_id: proxyId });
    await api('PUT', `/api/fleet/proxies/${proxyId}`, { token, body: { url: url(10009, 'u2', 'p2'), timezone: 'America/Chicago' } });
    const desired = await api<{ count: number }>('GET', '/api/fleet/hosts/lab/desired', { headers: { Authorization: `Bearer ${HOST_TOKEN}` } });
    expect(desired.body.count).toBe(1);
    const claim = await api<ClaimAnswer>('POST', '/api/fleet/worker/claim', {
      headers: { Authorization: `Bearer ${HOST_TOKEN}` }, body: { host_id: 'lab', worker_id: 'lab-1', version: '0.14.6', vnc_port: 5901 },
    });
    expect(claim.status).toBe(200);
    expect(claim.body.proxy).toEqual({ url: url(10009, 'u2', 'p2') });
    const expected = fleetDeviceFor(no, 'America/Chicago');
    expect(claim.body.device).toMatchObject({ ...expected, timezone: 'America/Chicago' });
    // The claim fills in a user agent; the worker leaves it to Chromium.
    expect(claim.body.device.native).toEqual(['user_agent']);
    expect(await pool(no)).toMatchObject({ status: 'fleet', holder_name: 'lab-1' });
    expect((await listProxies())[0].slots[0]).toMatchObject({ leased: true, parked: false });
    // A leased slot cannot be removed, nor its proxy.
    const busy = await removeSlot(no);
    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe('leased');
    const del = await api<Err>('DELETE', `/api/fleet/proxies/${proxyId}`, { token });
    expect(del.status).toBe(409);
    expect(del.body).toMatchObject({ error: 'in_use' });
    expect(del.body.detail).toContain(`#${no}`);
  });

  it('refuses an account that is held, missing, or lacks a password or 2FA key', async () => {
    const taken = await account(1, { status: 'taken', holder: 'Marcus' });
    const coordinator = await account(2, { status: 'fleet', holder: 'homelab-3' });
    const noPassword = await account(3, { password: false });
    const noTotp = await account(4, { totp: false });
    const expectRefusal = async (body: unknown, status: number, error: string) => {
      const r = await addSlot(body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(r.body.error).toBe(error);
    };
    await expectRefusal({ account_no: taken, proxy_id: proxyId }, 409, 'account_busy');
    await expectRefusal({ account_no: coordinator, proxy_id: proxyId }, 409, 'account_busy');
    await expectRefusal({ account_no: noPassword, proxy_id: proxyId }, 409, 'no_login');
    await expectRefusal({ account_no: noTotp, proxy_id: proxyId }, 409, 'no_login');
    await expectRefusal({ account_no: 9999, proxy_id: proxyId }, 404, 'not_found');
    const ok = await account(5);
    await expectRefusal({ account_no: ok, proxy_id: 9999 }, 404, 'not_found');
    await expectRefusal({ account_no: ok, proxy_id: proxyId, home_cities: ['nyc'] }, 422, 'bad_request');
    await expectRefusal({ account_no: 'x', proxy_id: proxyId }, 422, 'bad_request');
    // None of the refusals touched the pool row.
    expect(await pool(ok)).toEqual({ status: 'available', holder_name: null });
    expect(await pool(taken)).toEqual({ status: 'taken', holder_name: 'Marcus' });
    // Once in, a second add is `exists`.
    expect((await addSlot({ account_no: ok, proxy_id: proxyId })).status).toBe(201);
    await expectRefusal({ account_no: ok, proxy_id: proxyId }, 409, 'exists');
    // A fleet account under the ERP's own label and no slot (left over) may come in.
    const leftover = await account(6, { status: 'fleet', holder: 'ERP fleet' });
    expect((await addSlot({ account_no: leftover, proxy_id: proxyId })).status).toBe(201);
  });

  it('holds a proxy to max_accounts_per_proxy non-parked slots', async () => {
    const [a, b, c] = [await account(1), await account(2), await account(3)];
    expect((await addSlot({ account_no: a, proxy_id: proxyId })).status).toBe(201);
    expect((await addSlot({ account_no: b, proxy_id: proxyId })).status).toBe(201);
    const full = await addSlot({ account_no: c, proxy_id: proxyId });
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({ error: 'proxy_full' });
    expect(full.body.detail).toContain('2 of 2');
    // A parked slot does not count.
    await api('POST', `/api/fleet/slots/${a}/park`, { token });
    expect((await addSlot({ account_no: c, proxy_id: proxyId })).status).toBe(201);
    // The limit is a setting, validated like the rest.
    expect((await api('PUT', '/api/fleet/settings', { token, body: { max_accounts_per_proxy: 0 } })).status).toBe(422);
    expect((await api('PUT', '/api/fleet/settings', { token, body: { max_accounts_per_proxy: 11 } })).status).toBe(422);
    const set = await api<{ max_accounts_per_proxy: number }>('PUT', '/api/fleet/settings', { token, body: { max_accounts_per_proxy: 3 } });
    expect(set.body.max_accounts_per_proxy).toBe(3);
    await api('POST', `/api/fleet/slots/${a}/unpark`, { token });
    const d = await account(4);
    expect((await addSlot({ account_no: d, proxy_id: proxyId })).body.error).toBe('proxy_full');
  });

  it('removes a slot nobody holds and puts the account back on the rack', async () => {
    const no = await account(1);
    await addSlot({ account_no: no, proxy_id: proxyId });
    const db = getTestDb();
    await db`INSERT INTO fleet_items (name, phrases) VALUES ('server_ram', '["ram"]')`;
    await db`INSERT INTO fleet_tasks (city, item, kind, due_at, state, account_no) VALUES ('nyc', 'server_ram', 'probe', NOW(), 'ready', ${no})`;
    const r = await removeSlot(no);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, pool_status: 'available' });
    expect(await db`SELECT 1 FROM fleet_slots WHERE account_no = ${no}`).toHaveLength(0);
    expect(await pool(no)).toEqual({ status: 'available', holder_name: null });
    const [ev] = await db<{ kind: string; status: string }[]>`SELECT kind, status FROM fb_pool_events WHERE account_no = ${no} ORDER BY created_at DESC LIMIT 1`;
    expect(ev).toEqual({ kind: 'returned', status: 'available' });
    expect(await db`SELECT state FROM fleet_tasks WHERE account_no = ${no}`).toEqual([{ state: 'cancelled' }]);
    expect((await db`SELECT ended_at FROM fb_worker_accounts WHERE account_no = ${no}`)[0].ended_at).not.toBeNull();
    expect((await removeSlot(no)).status).toBe(404);
    // A parked slot comes out too, and the proxy can then go.
    const other = await account(2);
    await addSlot({ account_no: other, proxy_id: proxyId });
    await api('POST', `/api/fleet/slots/${other}/park`, { token });
    expect((await api('DELETE', `/api/fleet/proxies/${proxyId}`, { token })).status).toBe(200);
    // The parked slot keeps its sealed copy; only the link to the list goes.
    const [kept] = await db<{ proxy_id: number | null; has: boolean }[]>`SELECT proxy_id, proxy_url IS NOT NULL AS has FROM fleet_slots WHERE account_no = ${other}`;
    expect(kept).toEqual({ proxy_id: null, has: true });
    expect((await removeSlot(other)).body).toMatchObject({ ok: true, pool_status: 'available' });
  });
});

describe('fleetDeviceFor', () => {
  it('is fixed by the account number and picks a common screen with the viewport under the browser chrome', () => {
    const seen = new Set<string>();
    for (let no = 1; no <= 200; no++) {
      const d = fleetDeviceFor(no, 'America/Denver');
      expect(fleetDeviceFor(no, 'America/Denver')).toEqual(d);
      const screen = FLEET_SCREENS.find(([w, h]) => w === d.screen![0] && h === d.screen![1])!;
      expect(screen).toBeDefined();
      expect(d.device_scale_factor).toBe(screen[2]);
      expect(d.viewport[0]).toBe(d.screen![0]);
      expect([111, 123, 133]).toContain(d.screen![1] - d.viewport[1]);
      expect(d).toMatchObject({ timezone: 'America/Denver', locale: 'en-US', native: ['user_agent'] });
      expect(d.user_agent).toBeUndefined();
      seen.add(`${d.screen}`);
    }
    // Two hundred accounts use every screen in the list.
    expect(seen.size).toBe(FLEET_SCREENS.length);
  });
});
