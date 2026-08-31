import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { authMiddleware } from '../auth';
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
  .use('*', async (c, next) => {
    if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
    return next();
  });

function upstream(env: Env): { base: string; headers: Record<string, string> } | null {
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

async function forward(
  c: { env: Env; json: (body: unknown, status?: number) => Response },
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

  // Pass the upstream body and status through verbatim: the coordinator's 4xx
  // bodies carry actionable messages the UI shows as-is.
  const payload = await res.json().catch(() => ({ error: `coordinator returned ${res.status}` }));
  return c.json(payload, res.status as ContentfulStatusCode);
}

coordinator.get('/workers', (c) => forward(c, 'GET', '/v1/workers'));

coordinator.get('/stats/reviews', (c) => {
  // Pass the days window through untouched; the facade validates it.
  const query = new URL(c.req.url).search;
  return forward(c, 'GET', `/v1/stats/reviews${query}`);
});

coordinator.get('/filter-prompt', (c) => forward(c, 'GET', '/v1/config/filter-prompt'));

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
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ error: `coordinator returned ${res.status}` }));
    return c.json(payload, res.status as ContentfulStatusCode);
  }

  const bytes = await res.arrayBuffer();
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': res.headers.get('Content-Type') ?? 'image/png',
      'Content-Length': String(bytes.byteLength),
      // A capture never changes, but the challenge it belongs to disappears
      // once resolved — cache it briefly, and never in a shared cache.
      'Cache-Control': 'private, max-age=60',
    },
  });
});

export default coordinator;
