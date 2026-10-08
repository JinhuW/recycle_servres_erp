import { Hono } from 'hono';
import type { ContentfulStatusCode, StatusCode } from 'hono/utils/http-status';
import { authMiddleware } from '../auth';
import { log } from '../lib/log';
import { allowedAppOrigin } from '../lib/origins';
import { requireManager } from '../lib/role';
import type { Env, User } from '../types';

// ─── Facebook worker control-plane proxy ──────────────────────────────────────
// Manager-only pass-through to the coordinator API, so its bearer token never
// reaches the browser. Explicit allowlist rather than a catch-all: the
// coordinator also exposes worker lifecycle and credential endpoints this UI
// has no business calling. Self-applies authMiddleware
// (tracker pattern), so index.ts mounts it with a single app.route().

const TIMEOUT_MS = 10_000;
// A checkpoint screenshot is a full browser-window PNG the coordinator may be
// capturing on demand, so it gets a longer budget than the JSON calls.
const SCREENSHOT_TIMEOUT_MS = 20_000;

const NOT_CONFIGURED =
  'The worker control plane is not configured — set COORDINATOR_API_URL and COORDINATOR_API_TOKEN';
const UNREACHABLE = 'The worker control plane is unreachable';

const coordinator = new Hono<{ Bindings: Env; Variables: { user: User } }>()
  .use('*', authMiddleware)
  .use('*', requireManager);

export function upstream(env: Env): { base: string; headers: Record<string, string> } | null {
  const base = env.COORDINATOR_API_URL?.replace(/\/+$/, '');
  const token = env.COORDINATOR_API_TOKEN;
  if (!base || !token) return null;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  // The facade's tunnel hostname sits behind Cloudflare Access; the service
  // token gets this request past the edge, the bearer token past the facade.
  if (env.COORDINATOR_ACCESS_CLIENT_ID && env.COORDINATOR_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = env.COORDINATOR_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = env.COORDINATOR_ACCESS_CLIENT_SECRET;
  }
  return { base, headers };
}

// The facade refusing *our* credentials (a stale COORDINATOR_API_TOKEN, an
// Access service token that was rotated) must never reach the browser as a
// 401/403: the SPA reads a 401 from any /api route as "your session expired",
// refreshes, retries, and on a second 401 signs the manager out. It is a
// misconfiguration on this side, so it goes out as a 502 that names the fix.
const UPSTREAM_AUTH_REFUSED =
  'The fleet console refused the ERP’s credentials — check COORDINATOR_API_TOKEN (and the Access service token)';

function upstreamAuthRefused(c: { json: (body: unknown, status?: number) => Response }, status: number, path: string): Response {
  log.warn('coordinator upstream refused our credentials', { module: 'coordinator', upstreamStatus: status, upstreamPath: path });
  return c.json({ error: UPSTREAM_AUTH_REFUSED }, 502);
}

const isAuthRefusal = (status: number) => status === 401 || status === 403;

// Statuses a Response may not carry a body on; building one with a body throws.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const INVALID_ACCOUNT = 'Invalid account data';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// FastAPI says why it refused a write in `detail`: a sentence from the
// coordinator's own checks, or a list of field errors from schema validation.
// The SPA shows only `error`, so a route that opts in gets the sentence there.
function detailAsError(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  if (typeof payload.detail === 'string') return { error: payload.detail };
  if (Array.isArray(payload.detail)) return { error: INVALID_ACCOUNT };
  return payload;
}

async function forward(
  c: {
    env: Env;
    json: (body: unknown, status?: number) => Response;
    body: (data: null, status: StatusCode) => Response;
  },
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  opts: { detailAsError?: boolean } = {},
): Promise<Response> {
  const up = upstream(c.env);
  if (!up) return c.json({ error: NOT_CONFIGURED }, 501);

  const headers: Record<string, string> = { ...up.headers };
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(up.base + path, init);
  } catch {
    return c.json({ error: UNREACHABLE }, 502);
  }

  if (isAuthRefusal(res.status)) return upstreamAuthRefused(c, res.status, path);
  if (NULL_BODY_STATUSES.has(res.status)) return c.body(null, res.status as StatusCode);
  // Pass the upstream body and status through: the coordinator's 4xx bodies
  // carry actionable messages the UI shows as-is.
  const payload = await res.json().catch(() => ({ error: `coordinator returned ${res.status}` }));
  const refused = res.status >= 400 && res.status < 500;
  return c.json(opts.detailAsError && refused ? detailAsError(payload) : payload, res.status as ContentfulStatusCode);
}

coordinator.get('/workers', (c) => forward(c, 'GET', '/v1/workers'));

coordinator.get('/stats/reviews', (c) => {
  // Pass the days window through untouched; the facade validates it.
  const query = new URL(c.req.url).search;
  return forward(c, 'GET', `/v1/stats/reviews${query}`);
});

coordinator.get('/stats/alert-hits', (c) => {
  const query = new URL(c.req.url).search;
  return forward(c, 'GET', `/v1/stats/alert-hits${query}`);
});

coordinator.get('/filter-prompt', (c) => forward(c, 'GET', '/v1/config/filter-prompt'));

// The composed fleet view: fleet.toml + master.toml + the live monitor config
// joined to worker health, assembled by the facade so the browser never sees
// a config file. Proxies arrive as env-var names only.
coordinator.get('/fleet', (c) => forward(c, 'GET', '/v1/fleet'));

// Queue a Facebook re-login for one worker: the coordinator rides a one-shot
// directive back on the worker's next heartbeat, and the worker re-enters its
// username, password and 2FA code from the vault. Moves no credential and
// names no account, which is why the facade lets it through.
coordinator.post('/workers/:id/relogin', (c) =>
  forward(c, 'POST', `/v1/workers/${encodeURIComponent(c.req.param('id'))}/relogin`));

// ── The account pool ─────────────────────────────────────────────────────────
// Managers create and edit vault accounts here. Secrets travel one way: a
// write may carry them, but every answer says only which ones are stored.
// Each write is rebuilt from an allowlist, so nothing else the browser sends
// reaches the vault — not `changed_by`, not password-login release — and no
// body is ever logged, because it holds the secrets.

// The coordinator's own rule for an account id. Anything else never reaches
// the facade's URL space.
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

const ACCOUNT_FIELDS = ['fb_username', 'worker_id', 'region'] as const;
const SECRET_FIELDS: ReadonlySet<string> = new Set([
  'password', 'email', 'email_password', 'totp_secret', 'imap_host', 'imap_port',
]);

const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

// Upstream reads an absent key as "keep" and an explicit null as "clear", so
// the distinction survives the rebuild. Unknown secret names are dropped; a
// value of the wrong type refuses the whole write (null).
function accountWrite(raw: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const key of ACCOUNT_FIELDS) {
    if (!Object.hasOwn(raw, key)) continue;
    if (!isStringOrNull(raw[key])) return null;
    out[key] = raw[key];
  }
  if (Object.hasOwn(raw, 'secrets')) {
    if (!isRecord(raw.secrets)) return null;
    const secrets: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(raw.secrets)) {
      if (!SECRET_FIELDS.has(key)) continue;
      if (!isStringOrNull(value)) return null;
      secrets[key] = value;
    }
    out.secrets = secrets;
  }
  return out;
}

// The vault's audit trail names the manager who made the change, so it comes
// from the session, never from the request body.
const changedBy = (user: User) => user.name || user.email;

coordinator.get('/accounts', (c) =>
  forward(c, 'GET', '/v1/accounts', undefined, { detailAsError: true }));

coordinator.post('/accounts', async (c) => {
  const raw: unknown = await c.req.json().catch(() => null);
  if (!isRecord(raw)) return c.json({ error: 'invalid body' }, 400);
  if (typeof raw.account_id !== 'string' || !ACCOUNT_ID.test(raw.account_id)) {
    return c.json({ error: 'Invalid account id' }, 400);
  }
  const write = accountWrite(raw);
  if (!write) return c.json({ error: INVALID_ACCOUNT }, 400);
  return forward(c, 'POST', '/v1/accounts',
    { account_id: raw.account_id, ...write, changed_by: changedBy(c.var.user) },
    { detailAsError: true });
});

coordinator.patch('/accounts/:id', async (c) => {
  const id = c.req.param('id');
  if (!ACCOUNT_ID.test(id)) return c.json({ error: 'Invalid account id' }, 400);
  const raw: unknown = await c.req.json().catch(() => null);
  if (!isRecord(raw)) return c.json({ error: 'invalid body' }, 400);
  const write = accountWrite(raw);
  if (!write) return c.json({ error: INVALID_ACCOUNT }, 400);
  return forward(c, 'PATCH', `/v1/accounts/${encodeURIComponent(id)}`,
    { ...write, changed_by: changedBy(c.var.user) },
    { detailAsError: true });
});

// ── Watching a worker's browser ──────────────────────────────────────────────
// The bytes themselves are relayed by vncBridge.ts, which owns the HTTP
// upgrade. Before it accepts a socket it replays the handshake through the
// app to this route, so the proxy-secret gate, the session cookie and the
// manager check all apply exactly as they do to any other request. A 204 is
// the only answer that opens a socket.

// What a worker id may look like: what fleet.toml and RS_WORKER_ID use.
// Anything else never reaches the facade's URL space.
export const VNC_WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

coordinator.get('/vnc/:workerId/ws', (c) => {
  // A plain GET is not a socket; browsers cannot forge an Upgrade header.
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'Expected a WebSocket upgrade' }, 426);
  }
  // CORS never runs for a handshake and the cookie rides on one from any
  // site, so a foreign page must be refused here or it could drive a
  // manager's session into a worker's browser.
  if (!allowedAppOrigin(c.req.header('origin'), c.env.CORS_ALLOWED_ORIGINS)) {
    return c.json({ error: 'Origin not allowed' }, 403);
  }
  if (!VNC_WORKER_ID.test(c.req.param('workerId'))) {
    return c.json({ error: 'Unknown worker' }, 404);
  }
  if (!upstream(c.env)) return c.json({ error: NOT_CONFIGURED }, 501);
  return c.body(null, 204);
});

coordinator.get('/challenges', (c) => {
  // Pass the status filter through untouched; the coordinator validates it.
  const query = new URL(c.req.url).search;
  return forward(c, 'GET', `/v1/challenges${query}`);
});

coordinator.post('/challenges/:id/resolve', (c) =>
  // `resolved_by` is taken from the session, never from the request body — the
  // audit trail on the control plane has to name the human who actually
  // cleared the checkpoint.
  forward(c, 'POST', `/v1/challenges/${encodeURIComponent(c.req.param('id'))}/resolve`, {
    resolved_by: c.var.user.name || c.var.user.email,
  }));

// The bytes are served from our own origin, so the upstream's type is not
// trusted as-is: an HTML or SVG body relayed under its own type would run as
// script on the ERP's origin. Anything but a raster image downloads instead.
const SCREENSHOT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function screenshotType(upstreamType: string | null): string {
  const type = (upstreamType ?? '').split(';')[0].trim().toLowerCase();
  return SCREENSHOT_TYPES.has(type) ? type : 'application/octet-stream';
}

// Image, not JSON: the browser can't send the bearer token, so the <img> src
// points here and the bytes are relayed with the upstream content type.
coordinator.get('/challenges/:id/screenshot', async (c) => {
  const up = upstream(c.env);
  if (!up) return c.json({ error: NOT_CONFIGURED }, 501);

  const path = `/v1/challenges/${encodeURIComponent(c.req.param('id'))}/screenshot`;
  let res: Response;
  try {
    res = await fetch(up.base + path, {
      headers: up.headers,
      signal: AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS),
    });
  } catch {
    return c.json({ error: UNREACHABLE }, 502);
  }

  // Only a 200 carries image bytes; errors come back as JSON.
  if (isAuthRefusal(res.status)) return upstreamAuthRefused(c, res.status, path);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: `coordinator returned ${res.status}` }));
    return c.json(payload, res.status as ContentfulStatusCode);
  }

  const bytes = await res.arrayBuffer();
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': screenshotType(res.headers.get('Content-Type')),
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': String(bytes.byteLength),
      // A capture never changes, but the challenge it belongs to disappears
      // once resolved — cache it briefly, and never in a shared cache.
      'Cache-Control': 'private, max-age=60',
    },
  });
});

export default coordinator;
