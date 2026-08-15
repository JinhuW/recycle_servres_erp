import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { authMiddleware } from '../auth';
import type { Env, User } from '../types';

// ─── Reddit tracker proxy ─────────────────────────────────────────────────────
// Manager-only pass-through to the reddits_tracker admin API, so its bearer
// token never reaches the browser. Explicit allowlist rather than a catch-all:
// the tracker also exposes settings and requeue endpoints this UI has no
// business calling. Self-applies authMiddleware (oauthAdmin pattern), so
// index.ts mounts it with a single app.route().

const TIMEOUT_MS = 10_000;

const tracker = new Hono<{ Bindings: Env; Variables: { user: User } }>()
  .use('*', authMiddleware)
  .use('*', async (c, next) => {
    if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
    return next();
  });

async function forward(
  c: { env: Env; req: { json(): Promise<unknown> }; json: (body: unknown, status?: number) => Response },
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  withBody: boolean,
): Promise<Response> {
  const base = c.env.TRACKER_API_URL?.replace(/\/+$/, '');
  const token = c.env.TRACKER_API_TOKEN;
  if (!base || !token) {
    return c.json(
      { error: 'Tracker is not configured — set TRACKER_API_URL and TRACKER_API_TOKEN' },
      501,
    );
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (withBody) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify((await c.req.json().catch(() => ({}))) ?? {});
  }

  let res: Response;
  try {
    res = await fetch(base + path, init);
  } catch {
    return c.json({ error: 'Tracker API is unreachable' }, 502);
  }

  // Pass the upstream body and status through verbatim: the tracker's 400s
  // carry actionable validation messages the UI shows as-is.
  const body = await res.json().catch(() => ({ error: `tracker returned ${res.status}` }));
  return c.json(body, res.status as ContentfulStatusCode);
}

tracker.get('/workers', (c) => forward(c, 'GET', '/api/workers', false));
tracker.delete('/workers/:id', (c) =>
  forward(c, 'DELETE', `/api/workers/${encodeURIComponent(c.req.param('id'))}`, false));

tracker.get('/rules', (c) => forward(c, 'GET', '/api/rules', false));
tracker.post('/rules', (c) => forward(c, 'POST', '/api/rules', true));
tracker.patch('/rules/:id', (c) =>
  forward(c, 'PATCH', `/api/rules/${encodeURIComponent(c.req.param('id'))}`, true));
tracker.delete('/rules/:id', (c) =>
  forward(c, 'DELETE', `/api/rules/${encodeURIComponent(c.req.param('id'))}`, false));

tracker.get('/subreddits', (c) => forward(c, 'GET', '/api/subreddits', false));
tracker.post('/subreddits', (c) => forward(c, 'POST', '/api/subreddits', true));
tracker.patch('/subreddits/:name', (c) =>
  forward(c, 'PATCH', `/api/subreddits/${encodeURIComponent(c.req.param('name'))}`, true));
tracker.delete('/subreddits/:name', (c) =>
  forward(c, 'DELETE', `/api/subreddits/${encodeURIComponent(c.req.param('name'))}`, false));

export default tracker;
