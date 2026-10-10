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
// coordinator also exposes worker lifecycle and account endpoints this UI has
// no business calling. Self-applies authMiddleware (tracker pattern), so
// index.ts mounts it with a single app.route().

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
  const base = env.COORDINATOR_API_URL?.trim().replace(/\/+$/, '');
  // Trimmed because a pasted secret often ends in a newline: fetch strips it
  // from a header value, but the VNC bridge's socket refuses the whole header.
  const token = env.COORDINATOR_API_TOKEN?.trim();
  if (!base || !token) return null;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  // The facade's tunnel hostname sits behind Cloudflare Access; the service
  // token gets this request past the edge, the bearer token past the facade.
  const accessId = env.COORDINATOR_ACCESS_CLIENT_ID?.trim();
  const accessSecret = env.COORDINATOR_ACCESS_CLIENT_SECRET?.trim();
  if (accessId && accessSecret) {
    headers['CF-Access-Client-Id'] = accessId;
    headers['CF-Access-Client-Secret'] = accessSecret;
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
const REFUSAL_DETAIL_MAX = 200;
// What the facade's own bearer check says. Any other 401 it answers with is
// the coordinator behind it refusing the *facade's* token, relayed verbatim —
// pointing the operator at COORDINATOR_API_TOKEN then would send them to
// reset a token that is fine.
const FACADE_AUTH_DETAILS = new Set(['Missing bearer token', 'Invalid bearer token']);

function upstreamWhy(body: { detail?: unknown; error?: unknown } | null): string | null {
  return typeof body?.detail === 'string' ? body.detail
    : typeof body?.error === 'string' ? body.error
    : null;
}

/**
 * What to tell the manager when the facade answers 401/403; null for any
 * other status, whose body is left unread for the caller. A 401 or 403 that
 * comes bare, as Cloudflare Access's HTML page, or as the facade's own bearer
 * check is our credentials. A 403 the facade explains in JSON means it
 * declined this request, and a 401 it explains otherwise is relayed from the
 * coordinator; either way their own words are the useful part.
 */
export async function refusalMessage(res: Response): Promise<string | null> {
  if (res.status !== 401 && res.status !== 403) return null;
  // Parsed whatever the Content-Type says; an HTML page simply fails to parse.
  let why: string | null;
  try {
    why = upstreamWhy(JSON.parse(await res.text()) as { detail?: unknown; error?: unknown } | null);
  } catch {
    return UPSTREAM_AUTH_REFUSED;
  }
  if (!why || FACADE_AUTH_DETAILS.has(why)) return UPSTREAM_AUTH_REFUSED;
  if (res.status === 401) {
    return `The fleet console’s coordinator refused its token — check RS_COORDINATOR_ADMIN_TOKEN on the console: ${why.slice(0, REFUSAL_DETAIL_MAX)}`;
  }
  return `The fleet console refused this request: ${why.slice(0, REFUSAL_DETAIL_MAX)}`;
}

// The facade and coordinator are FastAPI, whose errors read {detail}; the
// SPA shows only `error`, so without this a 404/409 reads as 'HTTP 409'.
function withError(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && !('error' in payload)) {
    const why = upstreamWhy(payload as { detail?: unknown });
    if (why) return { ...payload, error: why };
  }
  return payload;
}

function upstreamRefused(
  c: { json: (body: unknown, status?: number) => Response }, status: number, path: string, message: string,
): Response {
  log.warn('coordinator upstream refused the request', { module: 'coordinator', upstreamStatus: status, upstreamPath: path });
  return c.json({ error: message }, 502);
}

// Statuses a Response may not carry a body on; building one with a body throws.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

async function forward(
  c: {
    env: Env;
    json: (body: unknown, status?: number) => Response;
    body: (data: null, status: StatusCode) => Response;
  },
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
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

  const refused = await refusalMessage(res);
  if (refused) return upstreamRefused(c, res.status, path, refused);
  if (NULL_BODY_STATUSES.has(res.status)) return c.body(null, res.status as StatusCode);
  // Pass the upstream body and status through verbatim: the coordinator's 4xx
  // bodies carry actionable messages the UI shows as-is.
  const payload = await res.json().catch(() => ({ error: `coordinator returned ${res.status}` }));
  return c.json(withError(payload), res.status as ContentfulStatusCode);
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
  const refused = await refusalMessage(res);
  if (refused) return upstreamRefused(c, res.status, path, refused);
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: `coordinator returned ${res.status}` }));
    return c.json(withError(payload), res.status as ContentfulStatusCode);
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
