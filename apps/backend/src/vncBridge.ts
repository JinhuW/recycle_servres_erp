// Watch a Facebook worker's browser from the ERP: relays a WebSocket between
// the manager's noVNC client and the rs-console facade's VNC bridge.
//
// Why the backend relays rather than the browser connecting to the facade
// directly: the facade's tunnel hostname sits behind Cloudflare Access, and its
// viewer trades a bearer token for each socket. The ERP holds both credentials
// (COORDINATOR_API_TOKEN, COORDINATOR_ACCESS_CLIENT_*), so it is the only party
// that can open the upstream socket — and neither credential ever reaches the
// browser, exactly as for the JSON routes in routes/coordinator.ts.
//
// Flow, per socket:
//   1. The browser opens wss://<erp>/api/coordinator/vnc/<worker>/ws. Its
//      session cookie rides on the handshake.
//   2. The handshake is replayed through the Hono app as a plain GET, so the
//      proxy-secret gate, cookie auth, the manager check and the Origin check
//      (GET /api/coordinator/vnc/:workerId/ws) all run as they would for any
//      request. Anything but a 204 is written back as that HTTP status and the
//      socket is dropped before a WebSocket exists.
//   3. Accepted: the backend asks the facade for a single-use ticket
//      (POST /v1/vnc/<worker>/ticket) and opens the facade's socket with it.
//      From then on it only moves bytes. A failure upstream closes the
//      browser's socket with a reason the viewer shows.
//
// View-only vs. control is the client's business (noVNC's viewOnly): RFB
// input is just bytes here, the same as on the facade's own viewer page.

import { STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Hono } from 'hono';
import { log } from './lib/log';
import { upstream, VNC_WORKER_ID } from './routes/coordinator';
import type { Env } from './types';

const PATH = /^\/api\/coordinator\/vnc\/([^/?#]+)\/ws$/;
const TICKET_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
// Each socket streams a remote screen; a handful of managers watching at once
// is the real ceiling, and anything past this is a client stuck reconnecting.
export const MAX_BRIDGES = 8;
// Bytes queued for a slow browser before the bridge gives up on it rather than
// buffering a framebuffer stream without bound.
const MAX_BUFFERED = 16 * 1024 * 1024;

const vlog = log.child({ module: 'vnc' });

type FetchApp = Pick<Hono<{ Bindings: Env }>, 'fetch'>;

const open = new Set<WebSocket>();

function reject(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

// Close codes a server may send. 1005/1006/1015 are reserved for "no code" and
// would make ws throw, so an upstream that vanished reads as 1011.
function sendableCode(code: number): number {
  if ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) {
    return code;
  }
  return 1011;
}

// A close reason is capped at 123 bytes on the wire.
function reasonText(reason: string): string {
  const buf = Buffer.from(reason, 'utf8');
  return buf.length <= 123 ? reason : buf.subarray(0, 120).toString('utf8') + '…';
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
  try {
    ws.close(sendableCode(code), reasonText(reason));
  } catch {
    ws.terminate();
  }
}

/** Replays the upgrade request through the app; 204 means "may connect". */
async function admit(app: FetchApp, env: Env, req: IncomingMessage): Promise<number> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const res = await app.fetch(new Request(`http://internal${req.url ?? '/'}`, { method: 'GET', headers }), env);
  return res.status;
}

type Grant = { path: string };

async function mintTicket(env: Env, workerId: string): Promise<Grant | { error: string }> {
  const up = upstream(env);
  if (!up) return { error: 'The worker control plane is not configured' };
  let res: Response;
  try {
    res = await fetch(`${up.base}/v1/vnc/${encodeURIComponent(workerId)}/ticket`, {
      method: 'POST',
      headers: up.headers,
      signal: AbortSignal.timeout(TICKET_TIMEOUT_MS),
    });
  } catch {
    return { error: 'The fleet console is unreachable' };
  }
  if (res.status === 404) {
    return { error: `The fleet console has no VNC target for ${workerId} (RS_VNC_TARGETS)` };
  }
  if (res.status === 401 || res.status === 403) {
    return { error: 'The fleet console refused the ERP’s credentials (COORDINATOR_API_TOKEN)' };
  }
  if (!res.ok) return { error: `The fleet console refused a ticket (${res.status})` };
  const body = await res.json().catch(() => null) as { path?: unknown } | null;
  if (!body || typeof body.path !== 'string' || !body.path.startsWith('/')) {
    return { error: 'The fleet console sent an unreadable ticket' };
  }
  return { path: body.path };
}

function pump(client: WebSocket, env: Env, workerId: string): void {
  const startedAt = Date.now();
  let toBrowser = 0;
  let toWorker = 0;
  let upstreamSocket: WebSocket | null = null;
  // RFB has the server speak first, so a client message before the upstream
  // is open is unusual — but buffered rather than lost.
  const pending: Buffer[] = [];

  const finish = (code: number, reason: string) => {
    closeQuietly(client, code, reason);
    if (upstreamSocket) closeQuietly(upstreamSocket, 1000, 'viewer closed');
  };

  client.on('message', (data: RawData) => {
    const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    toWorker += chunk.length;
    if (upstreamSocket?.readyState === WebSocket.OPEN) upstreamSocket.send(chunk, { binary: true });
    else pending.push(chunk);
  });
  client.on('close', () => {
    open.delete(client);
    if (upstreamSocket) closeQuietly(upstreamSocket, 1000, 'viewer closed');
    vlog.info('vnc bridge closed', {
      workerId, ms: Date.now() - startedAt, bytesToBrowser: toBrowser, bytesToWorker: toWorker,
    });
  });
  client.on('error', () => client.terminate());

  void (async () => {
    const grant = await mintTicket(env, workerId);
    if (client.readyState !== WebSocket.OPEN) return;
    if ('error' in grant) {
      finish(1011, grant.error);
      return;
    }
    const up = upstream(env);
    if (!up) {
      finish(1011, 'The worker control plane is not configured');
      return;
    }
    const target = up.base.replace(/^http/i, 'ws') + grant.path;
    const sock = new WebSocket(target, {
      headers: up.headers,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      perMessageDeflate: false,
    });
    upstreamSocket = sock;

    sock.on('open', () => {
      for (const chunk of pending.splice(0)) sock.send(chunk, { binary: true });
    });
    sock.on('message', (data: RawData) => {
      const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      toBrowser += chunk.length;
      if (client.bufferedAmount > MAX_BUFFERED) {
        finish(1013, 'The browser is not keeping up with the screen stream');
        return;
      }
      if (client.readyState === WebSocket.OPEN) client.send(chunk, { binary: true });
    });
    // The facade names the failure in its close reason ("rs-monitor-ne:5900
    // is not answering"); pass it through so the viewer can show it.
    sock.on('close', (code: number, reason: Buffer) => {
      finish(code, reason.toString('utf8') || 'The worker’s VNC session ended');
    });
    sock.on('unexpected-response', (_req, res) => {
      finish(1011, `The fleet console refused the connection (${res.statusCode ?? '?'})`);
      sock.terminate();
    });
    sock.on('error', () => finish(1011, 'The fleet console is unreachable'));
  })();
}

/**
 * Takes over HTTP upgrades on the server. Only the VNC path upgrades; every
 * other upgrade request is refused, as it was before this existed.
 */
export function attachVncBridge(server: Server, app: FetchApp, env: Env): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const path = (req.url ?? '').split('?')[0] ?? '';
    const match = PATH.exec(path);
    if (!match) {
      reject(socket, 404);
      return;
    }
    let workerId: string;
    try {
      workerId = decodeURIComponent(match[1]!);
    } catch {
      reject(socket, 404);
      return;
    }
    if (!VNC_WORKER_ID.test(workerId)) {
      reject(socket, 404);
      return;
    }

    admit(app, env, req).then((status) => {
      if (status !== 204) {
        reject(socket, status);
        return;
      }
      if (open.size >= MAX_BRIDGES) {
        reject(socket, 503);
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => {
        open.add(client);
        vlog.info('vnc bridge opened', { workerId, open: open.size });
        pump(client, env, workerId);
      });
    }).catch((e) => {
      vlog.error('vnc upgrade failed', e);
      reject(socket, 500);
    });
  });

  return wss;
}

/** Closes every relayed socket — for shutdown, so a viewer never pins the process. */
export function closeVncBridges(): void {
  for (const ws of open) closeQuietly(ws, 1001, 'The ERP is restarting — reconnect in a moment');
}

/** Open bridge count, for tests. */
export function openVncBridges(): number {
  return open.size;
}
