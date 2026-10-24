// Watch a fleet worker's browser from the ERP, with no port open on its host.
//
// The coordinator path (vncBridge.ts) dials the console's VNC bridge from the
// ERP. Fleet workers may sit on any network, so the direction is reversed: the
// worker's own websockify dials *in* to GET /api/fleet/worker/vnc with its
// worker token and parks the socket here under its worker_id. A manager's
// noVNC page opens /api/fleet/vnc/<worker_id>/ws, the two sockets are paired,
// and from then on bytes move. RFB's server speaks first, so a parked worker
// cannot dial its VNC server until it knows someone is watching: on pairing
// the relay sends it one text frame, `viewer`, before any viewer byte; every
// other frame either way is binary. RFB is one session per connection, so a pair
// ends together: when either side closes, the other is closed too, and the
// worker dials in again with a fresh socket for the next viewer.
//
// Both handshakes are replayed through the Hono app as plain GETs, so the
// worker token (fleet/auth.ts: 401 bad, 409 stale epoch) and the manager's
// session, role and Origin are checked exactly as on any request. A manager
// whose session lapses mid-view is cut the way vncBridge.ts does it.

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, type WebSocketServer, type RawData } from 'ws';
import type { Hono } from 'hono';
import { log } from '../lib/log';
import type { Env } from '../types';
import { VNC_WORKER_ID } from '../routes/coordinator';

const WORKER_PATH = '/api/fleet/worker/vnc';
const VIEWER_PATH = /^\/api\/fleet\/vnc\/([^/?#]+)\/ws$/;
// A worker parks one socket; a fleet of forty is the real ceiling.
export const MAX_PARKED = 100;
export const MAX_FLEET_BRIDGES = 8;
const MAX_BUFFERED = 16 * 1024 * 1024;
const REVALIDATE_MS = 60_000;
const TERMINATE_GRACE_MS = 2_000;
export const FLEET_VNC_SESSION_LAPSED = 4401;
export const VIEWER_FRAME = 'viewer';

const vlog = log.child({ module: 'fleet-vnc' });

type FetchApp = Pick<Hono<{ Bindings: Env }>, 'fetch'>;

// Worker sockets waiting for a viewer, by worker id.
const parked = new Map<string, WebSocket>();
// Viewer sockets with a worker on the other end.
const bridges = new Set<WebSocket>();
let closing = false;

function reject(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function sendable(code: number): number {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999) ? code : 1011;
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
  try {
    ws.close(sendable(code), Buffer.byteLength(reason) <= 123 ? reason : reason.slice(0, 100));
  } catch {
    ws.terminate();
  }
}

/** Replays the upgrade through the app; the response carries the verdict and, for a worker, its id. */
async function admit(app: FetchApp, env: Env, req: IncomingMessage): Promise<Response> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return app.fetch(new Request(`http://internal${req.url ?? '/'}`, { method: 'GET', headers }), env);
}

const toBuffer = (data: RawData) => (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer));

function park(workerId: string, ws: WebSocket): void {
  const previous = parked.get(workerId);
  if (previous) closeQuietly(previous, 1000, 'replaced by a newer relay socket');
  parked.set(workerId, ws);
  vlog.info('fleet vnc relay parked', { workerId, parked: parked.size });
  ws.on('close', () => {
    if (parked.get(workerId) === ws) parked.delete(workerId);
  });
  ws.on('error', () => ws.terminate());
  // Nothing should arrive before a viewer speaks; a worker that streams into
  // the void is not a relay.
  ws.on('message', () => closeQuietly(ws, 1008, 'no viewer is connected yet'));
}

function pair(viewer: WebSocket, workerId: string, worker: WebSocket): void {
  parked.delete(workerId);
  worker.removeAllListeners('message');
  bridges.add(viewer);
  const startedAt = Date.now();
  let toBrowser = 0;
  let toWorker = 0;
  const finish = (code: number, reason: string) => {
    closeQuietly(viewer, code, reason);
    closeQuietly(worker, 1000, 'viewer closed');
  };
  viewer.on('message', (data: RawData) => {
    const chunk = toBuffer(data);
    toWorker += chunk.length;
    if (worker.bufferedAmount > MAX_BUFFERED) { finish(1013, 'The worker is not keeping up with the input stream'); return; }
    if (worker.readyState === WebSocket.OPEN) worker.send(chunk, { binary: true });
  });
  worker.on('message', (data: RawData) => {
    const chunk = toBuffer(data);
    toBrowser += chunk.length;
    if (viewer.bufferedAmount > MAX_BUFFERED) { finish(1013, 'The browser is not keeping up with the screen stream'); return; }
    if (viewer.readyState === WebSocket.OPEN) viewer.send(chunk, { binary: true });
  });
  worker.on('close', (code: number, reason: Buffer) => {
    closeQuietly(viewer, code, reason.toString('utf8') || 'The worker’s VNC relay ended');
  });
  viewer.on('close', () => {
    bridges.delete(viewer);
    closeQuietly(worker, 1000, 'viewer closed');
    vlog.info('fleet vnc bridge closed', { workerId, ms: Date.now() - startedAt, bytesToBrowser: toBrowser, bytesToWorker: toWorker });
  });
  viewer.on('error', () => viewer.terminate());
  if (worker.readyState === WebSocket.OPEN) worker.send(VIEWER_FRAME);
}

function recheck(viewer: WebSocket, check: () => Promise<number>, everyMs: number): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    check().then((status) => {
      if (status === 401) closeQuietly(viewer, FLEET_VNC_SESSION_LAPSED, 'Your sign-in has run out');
      else if (status === 403) closeQuietly(viewer, 1008, 'You can no longer watch this worker');
    }, (e: unknown) => { vlog.warn('fleet vnc session re-check failed', e); })
      .finally(() => { inFlight = false; });
  }, everyMs);
  timer.unref();
  viewer.once('close', () => clearInterval(timer));
}

/**
 * Takes a fleet VNC upgrade off the server's `upgrade` event; false means the
 * path is not ours and the caller goes on. `wss` is the caller's server, so
 * its frame cap applies here too.
 */
export function handleFleetVncUpgrade(
  req: IncomingMessage, socket: Duplex, head: Buffer, app: FetchApp, env: Env, wss: WebSocketServer,
  { revalidateMs = REVALIDATE_MS }: { revalidateMs?: number } = {},
): boolean {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (path === WORKER_PATH) {
    admit(app, env, req).then((res) => {
      const workerId = res.headers.get('X-Fleet-Worker-Id');
      if (res.status !== 204 || !workerId) { reject(socket, res.status === 204 ? 500 : res.status); return; }
      if (closing || (parked.size >= MAX_PARKED && !parked.has(workerId))) { reject(socket, 503); return; }
      wss.handleUpgrade(req, socket, head, (ws) => park(workerId, ws));
    }).catch((e: unknown) => { vlog.error('fleet vnc worker upgrade failed', e); reject(socket, 500); });
    return true;
  }
  const match = VIEWER_PATH.exec(path);
  if (!match) return false;
  let workerId: string;
  try {
    workerId = decodeURIComponent(match[1]!);
  } catch {
    reject(socket, 404);
    return true;
  }
  if (!VNC_WORKER_ID.test(workerId)) { reject(socket, 404); return true; }
  admit(app, env, req).then((res) => {
    if (res.status !== 204) { reject(socket, res.status); return; }
    if (closing || bridges.size >= MAX_FLEET_BRIDGES) { reject(socket, 503); return; }
    wss.handleUpgrade(req, socket, head, (viewer) => {
      const worker = parked.get(workerId);
      if (!worker || worker.readyState !== WebSocket.OPEN) {
        // Accepted, then closed with a reason: a refused handshake carries none the viewer could show.
        closeQuietly(viewer, 1011, `${workerId} has no VNC relay connected`);
        return;
      }
      vlog.info('fleet vnc bridge opened', { workerId, open: bridges.size + 1 });
      pair(viewer, workerId, worker);
      recheck(viewer, () => admit(app, env, req).then((r) => r.status), revalidateMs);
    });
  }).catch((e: unknown) => { vlog.error('fleet vnc viewer upgrade failed', e); reject(socket, 500); });
  return true;
}

/** Closes every parked and paired socket, for shutdown. */
export function closeFleetVnc({ graceMs = TERMINATE_GRACE_MS }: { graceMs?: number } = {}): void {
  closing = true;
  const all = [...parked.values(), ...bridges];
  for (const ws of all) closeQuietly(ws, 1001, 'The ERP is restarting — reconnect in a moment');
  setTimeout(() => { for (const ws of all) ws.terminate(); }, graceMs).unref();
}

/** Parked worker ids and open viewer count, for tests. */
export function fleetVncState(): { parked: string[]; bridges: number } {
  return { parked: [...parked.keys()], bridges: bridges.size };
}
