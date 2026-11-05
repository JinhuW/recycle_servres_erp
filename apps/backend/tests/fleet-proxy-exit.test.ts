import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { FleetProxy, FleetProxyHealthAnswer } from '@recycle-erp/shared';
import { api, testEnv } from './helpers/app';
import { ALEX, loginAs } from './helpers/auth';
import { getTestDb, resetDb } from './helpers/db';
import { poolKey, seal } from '../src/lib/sealed';
import { exitAlertText, exitMoved, latestProxyExit, type PendingChange } from '../src/fleet/proxyExit';
import { runProxyRound } from '../src/fleet/proxyHealth';

// Exit tracking through real probes: local CONNECT proxies tunnel to a stand-in
// for ipinfo.io whose answer each test moves, or breaks.

const ASHBURN = { ip: '203.0.113.9', city: 'Ashburn', region: 'Virginia', country: 'US', org: 'AS64500', timezone: 'America/New_York' };
const DENVER = { ip: '198.51.100.4', city: 'Denver', region: 'Colorado', country: 'US', org: 'AS64500', timezone: 'America/Denver' };

let exit: Record<string, string> = ASHBURN;
let lookupFails = false;
let lookupUrl = '';
const ports: number[] = [];
const servers: net.Server[] = [];
const open = new Set<net.Socket>();

function listen(server: net.Server): Promise<number> {
  servers.push(server);
  server.on('connection', (s: net.Socket) => { open.add(s); s.on('close', () => open.delete(s)); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

const connectProxy = () => net.createServer((client) => {
  client.once('data', (d: Buffer) => {
    const port = Number(/^CONNECT [^:]+:(\d+)/.exec(d.toString('latin1'))?.[1]);
    const up = net.connect(port, '127.0.0.1', () => client.write('HTTP/1.1 200 Connection established\r\n\r\n'));
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
    client.pipe(up).pipe(client);
  });
});

beforeAll(async () => {
  const lookupPort = await listen(http.createServer((_req, res) => {
    if (lookupFails) { res.statusCode = 500; res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ...exit, readme: 'https://ipinfo.io/missingauth' }));
  }));
  lookupUrl = `http://127.0.0.1:${lookupPort}/json`;
  for (let i = 0; i < 14; i++) ports.push(await listen(connectProxy()));
});

afterAll(async () => {
  for (const s of open) s.destroy();
  for (const s of servers) await new Promise((resolve) => s.close(resolve));
});

type Change = {
  exit: string; source: string; proxy_id: number | null; changed_at: Date; previous_at: Date;
  old_ip: string; old_city: string | null; old_timezone: string | null;
  new_ip: string; new_city: string | null; new_timezone: string | null;
  slots: number[]; workers: string[]; notified_at: Date | null;
};

describe('exit tracking', () => {
  let token: string;
  const env = () => ({ ...testEnv, FLEET_PROXY_LOOKUP_URL: lookupUrl });
  const round = () => runProxyRound(getTestDb(), env(), 0);
  const changes = () => getTestDb()<Change[]>`SELECT * FROM fleet_proxy_exit_changes ORDER BY id`;
  const alerts = () => getTestDb()<{ user_id: string; title: string; body: string; tone: string }[]>`
    SELECT user_id, title, body, tone FROM notifications WHERE kind = 'fleet_proxy_exit' ORDER BY created_at, id`;
  const managers = async () => Number((await getTestDb()<{ n: string }[]>`
    SELECT COUNT(*) AS n FROM users WHERE role = 'manager' AND COALESCE(active, TRUE)`)[0].n);
  const check = (body: unknown = {}) =>
    api<FleetProxyHealthAnswer>('POST', '/api/fleet/proxies/health/check', { token, body, env: { FLEET_PROXY_LOOKUP_URL: lookupUrl } });
  const view = async () => (await api<FleetProxyHealthAnswer>('GET', '/api/fleet/proxies/health', { token })).body;

  const addProxy = async (label: string, port: number) =>
    (await api<FleetProxy>('POST', '/api/fleet/proxies', { token, body: { label, url: `http://u:p@127.0.0.1:${port}`, timezone: 'America/New_York' } })).body;
  let accounts = 0;
  async function bindSlot(proxyId: number): Promise<number> {
    const key = poolKey(testEnv)!;
    accounts += 1;
    const [a] = await getTestDb()<{ no: number }[]>`
      INSERT INTO fb_pool_accounts (uid, batch, status, password_enc, totp_enc)
      VALUES (${`61560000000${String(accounts).padStart(3, '0')}`}, 'fixtures', 'available', ${seal('pw', key)}, ${seal('ABCDEFGH', key)})
      RETURNING no`;
    const res = await api('POST', '/api/fleet/slots', { token, body: { account_no: a.no, proxy_id: proxyId } });
    expect(res.status).toBe(201);
    return a.no;
  }

  beforeEach(async () => {
    await resetDb();
    token = (await loginAs(ALEX)).token;
    exit = ASHBURN;
    lookupFails = false;
    accounts = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the exit zone the lookup reports', async () => {
    const p = await addProxy('NY 1', ports[0]!);
    await round();
    const [row] = await getTestDb()<{ timezone: string | null }[]>`SELECT timezone FROM fleet_proxy_checks WHERE proxy_id = ${p.id}`;
    expect(row.timezone).toBe('America/New_York');
    expect((await view()).proxies[0]!.last).toMatchObject({ timezone: 'America/New_York' });
  });

  it('records an IP change with the slots bound then, alerts each manager once and rewrites nothing', async () => {
    const p = await addProxy('NY 1', ports[0]!);
    const no = await bindSlot(p.id);
    await round();
    expect(await changes()).toEqual([]);
    const db = getTestDb();
    const before = await db`SELECT device, proxy_url FROM fleet_slots WHERE account_no = ${no}`;

    exit = DENVER;
    await round();
    const [c, ...rest] = await changes();
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      source: 'erp', proxy_id: p.id, exit: `http://127.0.0.1:${ports[0]}`,
      old_ip: ASHBURN.ip, old_city: 'Ashburn', old_timezone: 'America/New_York',
      new_ip: DENVER.ip, new_city: 'Denver', new_timezone: 'America/Denver',
      slots: [no], workers: [],
    });
    expect(c.previous_at.getTime()).toBeLessThan(c.changed_at.getTime());
    expect(c.notified_at).not.toBeNull();

    const sent = await alerts();
    expect(sent).toHaveLength(await managers());
    expect(sent[0]).toMatchObject({ title: 'Proxy exit changed: NY 1', tone: 'warn' });
    expect(sent[0]!.body).toContain(`#${no}`);
    expect(sent[0]!.body).toContain(`${ASHBURN.ip} (Ashburn, Virginia, US, America/New_York) → ${DENVER.ip}`);

    expect(await db`SELECT device, proxy_url FROM fleet_slots WHERE account_no = ${no}`).toEqual(before);
    const [{ timezone }] = await db<{ timezone: string }[]>`SELECT timezone FROM fleet_proxies WHERE id = ${p.id}`;
    expect(timezone).toBe('America/New_York');

    expect((await view()).proxies[0]).toMatchObject({
      slots: [{ account_no: no, timezone: 'America/New_York' }],
      exit_change: { from: { ip: ASHBURN.ip, timezone: 'America/New_York' }, to: { ip: DENVER.ip, city: 'Denver' } },
    });
  });

  it('counts a geo change on an unchanged IP', async () => {
    const p = await addProxy('NY 1', ports[0]!);
    await bindSlot(p.id);
    await round();
    exit = { ...ASHBURN, city: 'Leesburg' };
    await round();
    expect(await changes()).toEqual([expect.objectContaining({ old_ip: ASHBURN.ip, new_ip: ASHBURN.ip, old_city: 'Ashburn', new_city: 'Leesburg' })]);
    expect(await alerts()).toHaveLength(await managers());
    // Zone alone is geo too.
    exit = { ...exit, timezone: 'America/Chicago' };
    await round();
    expect((await changes()).map((c) => c.new_timezone)).toEqual(['America/New_York', 'America/Chicago']);
  });

  it('sees no change through a failure that recovers on the same exit', async () => {
    const p = await addProxy('NY 1', ports[0]!);
    await bindSlot(p.id);
    await round();
    lookupFails = true;
    await round();
    await round();
    expect((await view()).proxies[0]).toMatchObject({ state: 'down', exit_change: null });
    lookupFails = false;
    await round();
    expect(await changes()).toEqual([]);
    expect(await alerts()).toEqual([]);
  });

  it('dates a change after a failure from the last good measurement', async () => {
    const p = await addProxy('NY 1', ports[0]!);
    await round();
    const [good] = await getTestDb()<{ checked_at: Date }[]>`SELECT checked_at FROM fleet_proxy_checks WHERE proxy_id = ${p.id}`;
    lookupFails = true;
    await round();
    lookupFails = false;
    exit = DENVER;
    await round();
    const [c, ...rest] = await changes();
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ old_ip: ASHBURN.ip, new_ip: DENVER.ip, previous_at: good.checked_at });
  });

  it('does not read rows from before the zone was kept as a change', async () => {
    const p = await addProxy('NY 1', ports[0]!);
    await getTestDb()`
      INSERT INTO fleet_proxy_checks (exit, source, proxy_id, checked_at, ok, exit_ip, city, region, country)
      VALUES (${`http://127.0.0.1:${ports[0]}`}, 'erp', ${p.id}, NOW() - INTERVAL '1 hour', TRUE, ${ASHBURN.ip}, 'Ashburn', 'Virginia', 'US')`;
    await round();
    expect(await changes()).toEqual([]);
  });

  it('records a port nobody uses without alerting', async () => {
    await addProxy('NY 1', ports[0]!);
    await round();
    exit = DENVER;
    await round();
    expect(await changes()).toEqual([expect.objectContaining({ slots: [], workers: [], notified_at: null })]);
    expect(await alerts()).toEqual([]);
  });

  it('groups a provider-wide remap into one alert, and holds the next until the gap has passed', async () => {
    const proxies = [];
    for (const [i, port] of ports.entries()) proxies.push(await addProxy(`Port ${i + 1}`, port));
    const nos = [];
    for (const p of proxies.slice(0, 7)) nos.push(await bindSlot(p.id));
    await round();

    exit = DENVER;
    await round();
    expect(await changes()).toHaveLength(14);
    const sent = await alerts();
    expect(sent).toHaveLength(await managers());
    expect(new Set(sent.map((a) => a.title))).toEqual(new Set(['14 proxy exits changed, 7 with accounts on them']));
    for (const no of nos) expect(sent[0]!.body).toContain(`#${no}`);
    expect(sent[0]!.body).toContain('And 2 more on Fleet ▸ Proxies.');

    // The same day's next move waits, so a flapping port can't alert every round.
    exit = ASHBURN;
    await round();
    expect(await changes()).toHaveLength(28);
    expect(await alerts()).toHaveLength(await managers());

    exit = DENVER;
    await round();
    expect(await alerts()).toHaveLength(await managers());
    await getTestDb()`UPDATE fleet_proxy_exit_changes SET notified_at = notified_at - INTERVAL '31 minutes' WHERE notified_at IS NOT NULL`;
    // A round with no move still delivers what was held.
    await round();
    const after = await alerts();
    expect(after).toHaveLength(2 * await managers());
    expect(after.at(-1)!.title).toContain('proxy exits changed');
    const [{ left }] = await getTestDb()<{ left: number }[]>`
      SELECT COUNT(*)::int AS left FROM fleet_proxy_exit_changes
      WHERE notified_at IS NULL AND CARDINALITY(slots) > 0`;
    expect(left).toBe(0);
  });

  it('sees a change from one proxy\'s Check now, and the next round does not repeat it', async () => {
    const p = await addProxy('NY 1', ports[0]!);
    await bindSlot(p.id);
    await check({ proxy_id: p.id });
    exit = DENVER;
    await check({ proxy_id: p.id });
    expect(await changes()).toHaveLength(1);
    await round();
    expect(await changes()).toHaveLength(1);
  });

  it('starts a proxy over when a manager gives it a new URL', async () => {
    const p = await addProxy('NY 1', ports[0]!);
    await round();
    const res = await api('PUT', `/api/fleet/proxies/${p.id}`, { token, body: { url: `http://u:p@127.0.0.1:${ports[1]}` } });
    expect(res.status).toBe(200);
    exit = DENVER;
    await round();
    expect(await changes()).toEqual([]);
  });

  describe('homelab ports', () => {
    const console_ = { COORDINATOR_API_URL: 'http://console.test', COORDINATOR_API_TOKEN: 'console-token' };
    const answer = (rows: unknown[]) => vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ proxies: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const homelabRound = () => runProxyRound(getTestDb(), { ...env(), ...console_ }, 0);
    const port = (over: Record<string, unknown>) => ({
      url: 'http://isp.example.com:10001', workers: ['homelab-1'], ok: true, latency_ms: 500, ...over,
    });

    it('records and alerts a port a worker dials, keyed by its exit', async () => {
      answer([port({ ip: ASHBURN.ip, city: 'Ashburn' })]);
      await homelabRound();
      answer([port({ ip: DENVER.ip, city: 'Denver' })]);
      await homelabRound();
      expect(await changes()).toEqual([expect.objectContaining({
        source: 'coordinator', proxy_id: null, exit: 'http://isp.example.com:10001', slots: [], workers: ['homelab-1'],
        old_ip: ASHBURN.ip, new_ip: DENVER.ip, new_timezone: null,
      })]);
      const [sent] = await alerts();
      expect(sent!.title).toBe('Proxy exit changed: http://isp.example.com:10001');
      expect(sent!.body).toContain('homelab-1');
    });

    it('takes a failed console check for no change', async () => {
      answer([port({ ip: ASHBURN.ip })]);
      await homelabRound();
      answer([port({ ok: false, error: 'Timed out' })]);
      await homelabRound();
      answer([port({ ip: ASHBURN.ip })]);
      await homelabRound();
      expect(await changes()).toEqual([]);
    });

    it('records a port on both lists once, on its ERP row, with the workers on it', async () => {
      const p = await addProxy('NY 1', ports[0]!);
      const url = `http://127.0.0.1:${ports[0]}`;
      answer([port({ url, ip: ASHBURN.ip })]);
      await homelabRound();
      exit = DENVER;
      answer([port({ url, ip: DENVER.ip })]);
      await homelabRound();
      expect(await changes()).toEqual([expect.objectContaining({ source: 'erp', proxy_id: p.id, workers: ['homelab-1'] })]);
    });
  });

  describe('latestProxyExit', () => {
    it('answers the newest check: nothing before the first, then a good one, then a failed one', async () => {
      const p = await addProxy('NY 1', ports[0]!);
      const db = getTestDb();
      expect(await latestProxyExit(db, p.id)).toBeNull();
      await round();
      const good = await latestProxyExit(db, p.id);
      expect(good).toEqual({ ok: true, exit_ip: ASHBURN.ip, timezone: 'America/New_York', measured_at: expect.any(Date) });
      lookupFails = true;
      await round();
      const failed = await latestProxyExit(db, p.id);
      expect(failed).toEqual({ ok: false, exit_ip: null, timezone: null, measured_at: expect.any(Date) });
      expect(failed!.measured_at.getTime()).toBeGreaterThan(good!.measured_at.getTime());
    });
  });
});

describe('exitMoved', () => {
  const at = { exit_ip: '203.0.113.9', city: 'Ashburn', region: 'Virginia', country: 'US', timezone: 'America/New_York' };
  it('reads an IP or geo difference as a move, and a missing field as nothing', () => {
    expect(exitMoved(at, at)).toBe(false);
    expect(exitMoved(at, { ...at, exit_ip: '198.51.100.4' })).toBe(true);
    expect(exitMoved(at, { ...at, region: 'Ohio' })).toBe(true);
    expect(exitMoved({ ...at, timezone: null }, at)).toBe(false);
    expect(exitMoved(at, { ...at, city: null })).toBe(false);
  });
});

describe('exitAlertText', () => {
  const change = (name: string, over: Partial<PendingChange> = {}): PendingChange => ({
    name, old_ip: '203.0.113.9', old_city: null, old_region: null, old_country: null, old_timezone: null,
    new_ip: '198.51.100.4', new_city: null, new_region: null, new_country: null, new_timezone: null, slots: [], workers: [], ...over,
  });
  it('names the one port, or counts them with everyone on them once', () => {
    expect(exitAlertText([change('NY 1', { slots: [4] })], 0).title).toBe('Proxy exit changed: NY 1');
    const many = exitAlertText([change('NY 1', { slots: [4, 9], workers: ['homelab-2'] }), change('NY 2', { slots: [4] })], 0);
    expect(many.title).toBe('2 proxy exits changed under accounts');
    expect(many.body.split('\n')[0]).toBe('On it: #4, #9; homelab-2.');
    expect(exitAlertText([change('NY 1', { slots: [4] })], 3).title).toBe('4 proxy exits changed, 1 with accounts on them');
  });
});
