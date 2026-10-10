import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createAdaptorServer } from '@hono/node-server';
import app from '../src/index';
import { attachVncBridge, closeVncBridges, openVncBridges, VNC_SESSION_LAPSED } from '../src/vncBridge';
import { getTestDb, resetDb } from './helpers/db';
import { testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import type { Env } from '../src/types';

// The bridge end to end over real sockets: an ERP server with the bridge
// attached, and a stand-in facade that mints tickets and speaks first on its
// socket the way an RFB server does. What matters is that the browser's
// session gates the socket, that the facade's credentials (and only the
// ticket) cross upstream, and that bytes move both ways.

const FACADE_TOKEN = 'console-secret';
const ACCESS_ID = 'svc.access';
const ACCESS_SECRET = 'access-secret';

let facade: Server;
let facadeWss: WebSocketServer;
let facadeUrl: string;
let erp: Server;
let erpPort: number;
const issued = new Set<string>();
const seen: { auth?: string; access?: string; ticketHeaders?: Record<string, string | undefined> } = {};

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

beforeAll(async () => {
  facade = createServer((req, res) => {
    const m = /^\/v1\/vnc\/([^/]+)\/ticket$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !m) { res.writeHead(404).end(); return; }
    seen.ticketHeaders = {
      authorization: req.headers.authorization,
      access: req.headers['cf-access-client-id'] as string | undefined,
    };
    if (req.headers.authorization !== `Bearer ${FACADE_TOKEN}`) { res.writeHead(401).end(); return; }
    // A path new WebSocket() throws on synchronously.
    if (m[1] === 'frag-1') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ path: '/v1/vnc/frag-1/ws#x' }));
      return;
    }
    if (m[1] !== 'ne-1') {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"detail":"No VNC target for this worker"}');
      return;
    }
    const ticket = `t${issued.size}`;
    issued.add(ticket);
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ path: `/v1/vnc/ne-1/ws?ticket=${ticket}` }));
  });
  facadeWss = new WebSocketServer({ noServer: true });
  facade.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const ticket = url.searchParams.get('ticket') ?? '';
    seen.access = req.headers['cf-access-client-id'] as string | undefined;
    seen.auth = req.headers.authorization;
    if (!issued.delete(ticket)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    facadeWss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(Buffer.from('RFB 003.008\n'));
      ws.on('message', (data) => {
        if (String(data) === 'bye') { ws.close(1011, 'rs-monitor-ne:5900 is not answering'); return; }
        ws.send(Buffer.concat([Buffer.from('echo:'), data as Buffer]));
      });
    });
  });
  facadeUrl = `http://127.0.0.1:${await listen(facade)}`;

  const env: Env = Object.assign(Object.create(testEnv), {
    COORDINATOR_API_URL: facadeUrl,
    COORDINATOR_API_TOKEN: FACADE_TOKEN,
    COORDINATOR_ACCESS_CLIENT_ID: ACCESS_ID,
    COORDINATOR_ACCESS_CLIENT_SECRET: ACCESS_SECRET,
  });
  erp = createAdaptorServer({ fetch: (req) => app.fetch(req, env) }) as Server;
  attachVncBridge(erp, app, env);
  erpPort = await listen(erp);
});

afterAll(async () => {
  facadeWss.close();
  erp.closeAllConnections();
  await new Promise((r) => erp.close(r));
  facade.closeAllConnections();
  await new Promise((r) => facade.close(r));
});

beforeEach(async () => {
  await resetDb();
});

type Outcome = { messages: string[]; close?: { code: number; reason: string }; status?: number };

// Open a viewer socket and collect what it sees until it closes or `until`
// says enough.
function connect(path: string, opts: { token?: string; origin?: string; send?: string[]; until?: (o: Outcome) => boolean }): Promise<Outcome> {
  return new Promise((resolve) => {
    const out: Outcome = { messages: [] };
    const headers: Record<string, string> = {};
    if (opts.token) headers.Cookie = `at=${opts.token}`;
    if (opts.origin) headers.Origin = opts.origin;
    const ws = new WebSocket(`ws://127.0.0.1:${erpPort}${path}`, { headers });
    let sent = false;
    ws.on('message', (data) => {
      out.messages.push(String(data));
      if (!sent) { sent = true; for (const m of opts.send ?? []) ws.send(Buffer.from(m)); }
      if (opts.until?.(out)) { ws.close(); }
    });
    ws.on('unexpected-response', (_req, res) => { out.status = res.statusCode; resolve(out); });
    ws.on('close', (code, reason) => { out.close = { code, reason: String(reason) }; resolve(out); });
    ws.on('error', () => { /* surfaced through close / unexpected-response */ });
  });
}

describe('VNC bridge (/api/coordinator/vnc/:workerId/ws)', () => {
  it('relays bytes both ways with the facade credentials kept server-side', async () => {
    const { token } = await loginAs(ALEX);
    const out = await connect('/api/coordinator/vnc/ne-1/ws', {
      token, origin: 'http://localhost:5173', send: ['hello'],
      until: (o) => o.messages.length >= 2,
    });
    expect(out.status).toBeUndefined();
    expect(out.messages).toEqual(['RFB 003.008\n', 'echo:hello']);
    // The ticket was minted with the bearer token, and the socket carried the
    // Access service token past the edge.
    expect(seen.ticketHeaders?.authorization).toBe(`Bearer ${FACADE_TOKEN}`);
    expect(seen.access).toBe(ACCESS_ID);
  });

  it('passes the facade’s close reason through to the viewer', async () => {
    const { token } = await loginAs(ALEX);
    const out = await connect('/api/coordinator/vnc/ne-1/ws', {
      token, origin: 'http://localhost:5173', send: ['bye'],
    });
    expect(out.close?.code).toBe(1011);
    expect(out.close?.reason).toBe('rs-monitor-ne:5900 is not answering');
  });

  it('names a worker the facade cannot reach in the close reason', async () => {
    const { token } = await loginAs(ALEX);
    const out = await connect('/api/coordinator/vnc/se-1/ws', { token, origin: 'http://localhost:5173' });
    expect(out.close?.code).toBe(1011);
    expect(out.close?.reason).toMatch(/no VNC target for se-1/);
  });

  it('refuses the handshake without a manager session, before any ticket is minted', async () => {
    const before = issued.size;
    expect((await connect('/api/coordinator/vnc/ne-1/ws', { origin: 'http://localhost:5173' })).status).toBe(401);
    const { token } = await loginAs(MARCUS);
    expect((await connect('/api/coordinator/vnc/ne-1/ws', { token, origin: 'http://localhost:5173' })).status).toBe(403);
    expect(issued.size).toBe(before);
  });

  it('refuses a foreign origin and any other upgrade path', async () => {
    const { token } = await loginAs(ALEX);
    expect((await connect('/api/coordinator/vnc/ne-1/ws', { token, origin: 'https://evil.example' })).status).toBe(403);
    expect((await connect('/api/orders', { token, origin: 'http://localhost:5173' })).status).toBe(404);
  });

  it('releases the bridge once the viewer leaves', async () => {
    const { token } = await loginAs(ALEX);
    await connect('/api/coordinator/vnc/ne-1/ws', {
      token, origin: 'http://localhost:5173', until: (o) => o.messages.length >= 1,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(openVncBridges()).toBe(0);
  });
});

// The minute re-check, at 100 ms on a server of its own. Every test here ends
// with its socket closed, so no re-check runs into the next resetDb.
describe('VNC bridge session re-check', () => {
  let fast: Server;
  let fastPort: number;

  beforeAll(async () => {
    const env: Env = Object.assign(Object.create(testEnv), {
      COORDINATOR_API_URL: facadeUrl,
      COORDINATOR_API_TOKEN: FACADE_TOKEN,
    });
    fast = createAdaptorServer({ fetch: (req) => app.fetch(req, env) }) as Server;
    attachVncBridge(fast, app, env, { revalidateMs: 100 });
    fastPort = await listen(fast);
  });

  afterAll(async () => {
    fast.closeAllConnections();
    await new Promise((r) => fast.close(r));
  });

  // Opens a viewer, lets `during` run once the first frame arrives, and
  // resolves with how the socket ended — or still open after `holdMs`, in
  // which case the test closes it.
  function watch(token: string, during: () => Promise<void>, holdMs = 1500): Promise<{ code?: number; reason?: string; messages: string[] }> {
    return new Promise((resolve) => {
      const out: { code?: number; reason?: string; messages: string[] } = { messages: [] };
      const ws = new WebSocket(`ws://127.0.0.1:${fastPort}/api/coordinator/vnc/ne-1/ws`, {
        headers: { Cookie: `at=${token}`, Origin: 'http://localhost:5173' },
      });
      let timer: NodeJS.Timeout | undefined;
      ws.on('message', (data) => {
        out.messages.push(String(data));
        if (out.messages.length === 1) {
          void during().then(() => { timer = setTimeout(() => ws.close(), holdMs); });
        }
      });
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        if (code !== 1005) { out.code = code; out.reason = String(reason); }
        resolve(out);
      });
      ws.on('error', () => { /* surfaced through close */ });
    });
  }

  it('keeps a socket whose session still stands, without minting another ticket', async () => {
    const { token } = await loginAs(ALEX);
    const before = issued.size;
    const out = await watch(token, async () => {}, 600);
    expect(out.code).toBeUndefined();
    expect(out.messages).toEqual(['RFB 003.008\n']);
    // Every ticket is consumed on use, so a re-check that minted one would
    // leave it behind here.
    expect(issued.size).toBe(before);
  });

  it('closes with 4401 once the manager is deactivated', async () => {
    const { token } = await loginAs(ALEX);
    const out = await watch(token, async () => {
      await getTestDb()`UPDATE users SET active = FALSE WHERE email = ${ALEX}`;
    });
    expect(out.code).toBe(VNC_SESSION_LAPSED);
    expect(out.reason).toBe('Your sign-in has run out');
  });

  it('closes with 1008 once the manager is demoted', async () => {
    const { token } = await loginAs(ALEX);
    const out = await watch(token, async () => {
      await getTestDb()`UPDATE users SET role = 'purchaser' WHERE email = ${ALEX}`;
    });
    expect(out.code).toBe(1008);
    expect(out.reason).toBe('You can no longer watch this worker');
  });
});

// A pasted secret with a trailing newline passes fetch (which strips it) but
// not a socket's handshake headers; and whatever the socket constructor
// throws must close this viewer, not the process.
describe('VNC bridge upstream setup failures', () => {
  let crlf: Server;
  let crlfPort: number;

  beforeAll(async () => {
    const env: Env = Object.assign(Object.create(testEnv), {
      COORDINATOR_API_URL: facadeUrl,
      COORDINATOR_API_TOKEN: `${FACADE_TOKEN}\r\n`,
      COORDINATOR_ACCESS_CLIENT_ID: `${ACCESS_ID}\n`,
      COORDINATOR_ACCESS_CLIENT_SECRET: `${ACCESS_SECRET}\r`,
    });
    crlf = createAdaptorServer({ fetch: (req) => app.fetch(req, env) }) as Server;
    attachVncBridge(crlf, app, env);
    crlfPort = await listen(crlf);
  });

  afterAll(async () => {
    crlf.closeAllConnections();
    await new Promise((r) => crlf.close(r));
  });

  function open(workerId: string, token: string, until?: (o: Outcome) => boolean): Promise<Outcome> {
    return new Promise((resolve) => {
      const out: Outcome = { messages: [] };
      const ws = new WebSocket(`ws://127.0.0.1:${crlfPort}/api/coordinator/vnc/${workerId}/ws`, {
        headers: { Cookie: `at=${token}`, Origin: 'http://localhost:5173' },
      });
      ws.on('message', (data) => { out.messages.push(String(data)); if (until?.(out)) ws.close(); });
      ws.on('unexpected-response', (_req, res) => { out.status = res.statusCode; resolve(out); });
      ws.on('close', (code, reason) => { out.close = { code, reason: String(reason) }; resolve(out); });
      ws.on('error', () => { /* surfaced through close */ });
    });
  }

  it('relays with credentials that carry a trailing CR/LF', async () => {
    const { token } = await loginAs(ALEX);
    const out = await open('ne-1', token, (o) => o.messages.length >= 1);
    expect(out.messages).toEqual(['RFB 003.008\n']);
    expect(seen.auth).toBe(`Bearer ${FACADE_TOKEN}`);
    expect(seen.access).toBe(ACCESS_ID);
  });

  it('closes the viewer, and keeps serving, when the upstream socket cannot be built', async () => {
    const { token } = await loginAs(ALEX);
    const out = await open('frag-1', token);
    expect(out.close?.code).toBe(1011);
    expect(out.close?.reason).toMatch(/could not open/);
    const again = await open('ne-1', token, (o) => o.messages.length >= 1);
    expect(again.messages).toEqual(['RFB 003.008\n']);
  });
});

// Last in the file: the shutdown flag is module state and never resets.
describe('VNC bridge during shutdown', () => {
  it('refuses a handshake admitted after the shutdown sweep', async () => {
    const { token } = await loginAs(ALEX);
    closeVncBridges();
    const out = await connect('/api/coordinator/vnc/ne-1/ws', { token, origin: 'http://localhost:5173' });
    expect(out.status).toBe(503);
    expect(openVncBridges()).toBe(0);
  });
});
