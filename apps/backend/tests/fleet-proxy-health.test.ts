import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { proxyHealthState, type FleetProxy, type FleetProxyHealthAnswer } from '@recycle-erp/shared';
import { getTestDb, resetDb } from './helpers/db';
import { api } from './helpers/app';
import { ALEX, MARCUS, loginAs } from './helpers/auth';
import { probeProxy } from '../src/fleet/proxyProbe';
import { runProxyRound } from '../src/fleet/proxyHealth';
import { testEnv } from './helpers/app';

// Proxy health: real sockets against local stand-ins. A plain HTTP server plays
// ipinfo.io, and two small proxies (HTTP CONNECT and SOCKS5) demand a login
// and tunnel to it. Every login here is made up.

const USER = 'decodo-user-' + randomBytes(4).toString('hex');
const PASS = 'pw-' + randomBytes(8).toString('hex');
const EXIT = { ip: '203.0.113.9', city: 'Ashburn', region: 'Virginia', country: 'US', org: 'AS64500 Example' };

const servers: net.Server[] = [];
let lookupUrl = '';
let connectPort = 0;
let socksPort = 0;
let silentPort = 0;
let deadPort = 0;

// Tunnels stay open, and server.close() waits for every one of them.
const open = new Set<net.Socket>();

function listen(server: net.Server): Promise<number> {
  servers.push(server);
  server.on('connection', (s: net.Socket) => { open.add(s); s.on('close', () => open.delete(s)); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

function pipeTo(client: net.Socket, port: number, onOpen: () => void) {
  const up = net.connect(port, '127.0.0.1', onOpen);
  up.on('error', () => client.destroy());
  client.on('error', () => up.destroy());
  client.pipe(up).pipe(client);
}

beforeAll(async () => {
  const lookupPort = await listen(http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ...EXIT, readme: 'https://ipinfo.io/missingauth' }));
  }));
  lookupUrl = `http://127.0.0.1:${lookupPort}/json`;

  connectPort = await listen(net.createServer((client) => {
    let head = '';
    const onData = (d: Buffer) => {
      head += d.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      client.off('data', onData);
      const want = `Proxy-Authorization: Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
      if (!head.includes(want)) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
      const port = Number(/^CONNECT [^:]+:(\d+)/.exec(head)?.[1]);
      pipeTo(client, port, () => client.write('HTTP/1.1 200 Connection established\r\n\r\n'));
    };
    client.on('data', onData);
  }));

  socksPort = await listen(net.createServer((client) => {
    let buf = Buffer.alloc(0);
    let step = 0;
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (step === 0 && buf.length >= 2 + buf[1]) {
        buf = buf.subarray(2 + buf[1]);
        client.write(Buffer.from([5, 2]));
        step = 1;
      }
      if (step === 1 && buf.length >= 2 && buf.length >= 3 + buf[1] + (buf[2 + buf[1]] ?? 255)) {
        const u = buf.subarray(2, 2 + buf[1]).toString();
        const p = buf.subarray(3 + buf[1], 3 + buf[1] + buf[2 + buf[1]]).toString();
        buf = buf.subarray(3 + buf[1] + buf[2 + buf[1]]);
        if (u !== USER || p !== PASS) { client.end(Buffer.from([1, 1])); return; }
        client.write(Buffer.from([1, 0]));
        step = 2;
      }
      if (step === 2 && buf.length >= 5 && buf.length >= 7 + buf[4]) {
        const port = buf.readUInt16BE(5 + buf[4]);
        client.off('data', onData);
        pipeTo(client, port, () => client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])));
      }
    };
    client.on('data', onData);
  }));

  // Accepts and never says a word.
  silentPort = await listen(net.createServer(() => {}));
  // Taken, then let go: nothing listens there.
  const dead = net.createServer();
  deadPort = await new Promise<number>((resolve) => dead.listen(0, '127.0.0.1', () => resolve((dead.address() as net.AddressInfo).port)));
  await new Promise((resolve) => dead.close(resolve));
});

afterAll(async () => {
  for (const s of open) s.destroy();
  for (const s of servers) await new Promise((resolve) => s.close(resolve));
});

describe('probeProxy', () => {
  it('comes out through an HTTP CONNECT proxy with the exit it reports', async () => {
    const r = await probeProxy(`http://${USER}:${PASS}@127.0.0.1:${connectPort}`, lookupUrl);
    expect(r).toMatchObject({ ok: true, exit: EXIT });
    expect(r.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('comes out through a SOCKS5 proxy with a login', async () => {
    expect(await probeProxy(`socks5://${USER}:${PASS}@127.0.0.1:${socksPort}`, lookupUrl)).toMatchObject({ ok: true, exit: EXIT });
  });

  it('words every failure itself, never with the login', async () => {
    const cases: [string, string][] = [
      [`http://${USER}:wrong@127.0.0.1:${connectPort}`, 'Proxy refused the login'],
      [`socks5://${USER}:wrong@127.0.0.1:${socksPort}`, 'Proxy refused the login'],
      [`http://${USER}:${PASS}@127.0.0.1:${deadPort}`, 'Connection refused'],
    ];
    for (const [url, error] of cases) {
      const r = await probeProxy(url, lookupUrl);
      expect(r).toMatchObject({ ok: false, error });
      expect(JSON.stringify(r)).not.toContain(PASS);
    }
    expect(await probeProxy(`http://${USER}:${PASS}@127.0.0.1:${silentPort}`, lookupUrl, 300))
      .toMatchObject({ ok: false, error: 'Timed out' });
  });
});

describe('proxyHealthState', () => {
  it('is down only after two misses in a row', () => {
    expect(proxyHealthState([])).toBe('unchecked');
    expect(proxyHealthState([{ ok: true, latency_ms: 400 }])).toBe('up');
    expect(proxyHealthState([{ ok: true, latency_ms: 3200 }])).toBe('degraded');
    expect(proxyHealthState([{ ok: false, latency_ms: 10 }, { ok: true, latency_ms: 400 }])).toBe('degraded');
    expect(proxyHealthState([{ ok: false, latency_ms: 10 }, { ok: false, latency_ms: 10 }])).toBe('down');
    expect(proxyHealthState([{ ok: false, latency_ms: 10 }])).toBe('down');
  });
});

describe('the Proxies tab API', () => {
  let token: string;
  let logged: string[] = [];
  const env = () => ({ FLEET_PROXY_LOOKUP_URL: lookupUrl });
  const view = () => api<FleetProxyHealthAnswer>('GET', '/api/fleet/proxies/health', { token, env: env() });
  const check = (body: unknown = {}, extra: Record<string, string> = {}) =>
    api<FleetProxyHealthAnswer>('POST', '/api/fleet/proxies/health/check', { token, body, env: { ...env(), ...extra } });
  const addProxy = async (label: string, url: string) =>
    (await api<FleetProxy>('POST', '/api/fleet/proxies', { token, body: { label, url, timezone: 'America/New_York' } })).body;
  const checks = async () => Number((await getTestDb()<{ n: string }[]>`SELECT COUNT(*) AS n FROM fleet_proxy_checks`)[0].n);

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
      expect(line).not.toContain(USER);
      expect(line).not.toContain(PASS);
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is manager scope', async () => {
    const purchaser = (await loginAs(MARCUS)).token;
    expect((await api('GET', '/api/fleet/proxies/health', { token: purchaser })).status).toBe(403);
    expect((await api('POST', '/api/fleet/proxies/health/check', { token: purchaser, body: {} })).status).toBe(403);
  });

  it('lists every ERP proxy unchecked, then up or down after Check now, without a login anywhere', async () => {
    const good = await addProxy('NY 1', `http://${USER}:${PASS}@127.0.0.1:${connectPort}`);
    const bad = await addProxy('NY 2', `socks5://${USER}:${PASS}@127.0.0.1:${deadPort}`);

    const before = (await view()).body;
    expect(before.proxies.map((p) => [p.label, p.state])).toEqual([['NY 1', 'unchecked'], ['NY 2', 'unchecked']]);
    expect(before.round_at).toBeNull();

    const res = await check();
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(PASS);
    expect(JSON.stringify(res.body)).not.toContain(USER);
    const [up, down] = res.body.proxies;
    expect(up).toMatchObject({
      proxy_id: good.id, source: 'erp', exit: `http://127.0.0.1:${connectPort}`, state: 'up', uptime: 1, checks: 1,
      last: { ok: true, exit_ip: EXIT.ip, city: 'Ashburn', org: EXIT.org, error: null },
    });
    expect(up.buckets).toHaveLength(48);
    expect(up.buckets[47]).toBe('up');
    expect(down).toMatchObject({ proxy_id: bad.id, state: 'down', uptime: 0, last: { ok: false, error: 'Connection refused' } });
    expect(res.body.coordinator).toBe('not_configured');
    expect(res.body.round_at).not.toBeNull();

    // A second full round moments later is the same round.
    await check();
    expect(await checks()).toBe(2);
    // One proxy can always be checked again.
    const again = await check({ proxy_id: good.id });
    expect(again.body.proxies[0].checks).toBe(2);
    expect(await checks()).toBe(3);
    expect((await check({ proxy_id: 99999 })).status).toBe(404);

    const rows = await getTestDb()`SELECT * FROM fleet_proxy_checks`;
    expect(JSON.stringify(rows)).not.toContain(PASS);
  });

  it('flags an exit IP that changed during the day', async () => {
    const p = await addProxy('NY 1', `http://${USER}:${PASS}@127.0.0.1:${connectPort}`);
    await getTestDb()`
      INSERT INTO fleet_proxy_checks (exit, source, proxy_id, checked_at, ok, latency_ms, exit_ip)
      VALUES ('http://x:1', 'erp', ${p.id}, NOW() - INTERVAL '3 hours', TRUE, 500, '198.51.100.4')`;
    await check({ proxy_id: p.id });
    const [row] = (await view()).body.proxies;
    expect(row.last?.exit_ip).toBe(EXIT.ip);
    expect(row.previous_ip).toBe('198.51.100.4');
    expect(row.buckets.filter(Boolean)).toHaveLength(2);
  });

  it('adds the homelab ports the console reports, and keeps the last list when it stops answering', async () => {
    const console_ = { COORDINATOR_API_URL: 'http://console.test', COORDINATOR_API_TOKEN: 'console-token' };
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe('http://console.test/v1/proxies/health');
      return new Response(JSON.stringify({ proxies: [{
        url: 'http://isp.example.com:10001', workers: ['homelab-1', 'wc-1'], ok: true, latency_ms: 812,
        ip: '203.0.113.1', city: 'Denver', region: 'Colorado', country: 'US', org: 'AS1', checked_at: '2026-10-27T15:00:00Z',
      }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await check({}, console_);
    expect(res.body.coordinator).toBe('ok');
    expect(res.body.proxies).toEqual([expect.objectContaining({
      source: 'coordinator', exit: 'http://isp.example.com:10001', host: 'isp.example.com', port: 10001,
      workers: ['homelab-1', 'wc-1'], state: 'up', last: expect.objectContaining({ latency_ms: 812, city: 'Denver' }),
    })]);

    // A console from before the endpoint: the list stays as last answered.
    fetchMock.mockResolvedValue(new Response('{"detail":"Not Found"}', { status: 404 }));
    await getTestDb()`UPDATE fleet_proxy_rounds SET started_at = '-infinity'`;
    const later = await check({}, console_);
    expect(later.body.coordinator).toBe('unsupported');
    expect(later.body.proxies).toHaveLength(1);
  });

  it('shows a port in both lists once, on the ERP row, with the homelab workers on it', async () => {
    const p = await addProxy('NY 1', `http://${USER}:${PASS}@127.0.0.1:${connectPort}`);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ proxies: [
      { url: `http://127.0.0.1:${connectPort}`, workers: ['nyc-1'], ok: true, latency_ms: 300, checked_at: '2026-10-27T15:00:00Z' },
      { url: 'http://isp.example.com:10019', workers: [], ok: true, latency_ms: 500, checked_at: '2026-10-27T15:00:00Z' },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const res = await check({}, { COORDINATOR_API_URL: 'http://console.test', COORDINATOR_API_TOKEN: 'console-token' });
    expect(res.body.proxies.map((r) => [r.source, r.proxy_id, r.port, r.workers])).toEqual([
      ['erp', p.id, connectPort, ['nyc-1']],
      ['coordinator', null, 10019, []],
    ]);
  });

  it('answers and claims rounds when the round row is missing', async () => {
    await addProxy('NY 1', `http://${USER}:${PASS}@127.0.0.1:${connectPort}`);
    await getTestDb()`DELETE FROM fleet_proxy_rounds`;
    const empty = await view();
    expect(empty.status).toBe(200);
    expect(empty.body.round_at).toBeNull();
    expect(empty.body.proxies.map((p) => p.state)).toEqual(['unchecked']);
    expect(await runProxyRound(getTestDb(), { ...testEnv, FLEET_PROXY_LOOKUP_URL: lookupUrl })).toBe(true);
    const after = await view();
    expect(after.body.round_at).not.toBeNull();
    expect(after.body.proxies[0].state).toBe('up');
  });

  it('starts at most one round per five minutes, and prunes checks past two weeks', async () => {
    await addProxy('NY 1', `http://${USER}:${PASS}@127.0.0.1:${connectPort}`);
    await getTestDb()`
      INSERT INTO fleet_proxy_checks (exit, source, checked_at, ok) VALUES ('http://old:1', 'erp', NOW() - INTERVAL '15 days', FALSE)`;
    const sql = getTestDb();
    const env2 = { ...testEnv, FLEET_PROXY_LOOKUP_URL: lookupUrl };
    const [a, b] = await Promise.all([runProxyRound(sql, env2), runProxyRound(sql, env2)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await runProxyRound(sql, env2)).toBe(false);
    const rows = await sql<{ exit: string }[]>`SELECT exit FROM fleet_proxy_checks`;
    expect(rows.map((r) => r.exit)).toEqual([`http://127.0.0.1:${connectPort}`]);
  });
});
