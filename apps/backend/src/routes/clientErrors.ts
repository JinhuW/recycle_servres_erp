import { Hono } from 'hono';
import { appendErrorRecord, redactSensitivePath, redactSensitiveQuery } from '../lib/error-log';
import { createRateLimiter } from '../lib/rate-limit';
import type { Env, User } from '../types';

// Where browser-side failures come to be recorded.
//
// The backend's own logs only ever see requests that reached it. A render crash,
// a fetch that never resolved, a response the SPA could not parse — all of those
// are invisible here, so a user reporting "Something went wrong" left nothing to
// grep and every investigation started from a repro attempt. This endpoint is
// the missing half: the SPA posts what it saw, and it lands in the same stream
// as the unhandled-500s.
//
// Authenticated on purpose. An unauthenticated write surface that appends to the
// operator's log is a spam target, and the failures worth chasing happen behind
// the login. The cost is that crashes on the login screen aren't reported.

const clientErrors = new Hono<{
  Bindings: Env;
  Variables: { user: User; requestId: string };
}>();

// A browser in a render loop can call this as fast as it can paint. The SPA caps
// itself too, but that cap lives in the code that just proved it was broken.
const rateLimited = createRateLimiter(60_000, 30);

// Long enough to identify the failure, short enough that the log stays readable
// and one client can't append a megabyte per report.
const MAX = { message: 512, stack: 4096, componentStack: 4096, href: 1024, ua: 256, id: 128 };

const str = (v: unknown, cap: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, cap) : undefined;
};

type Body = {
  message?: unknown; stack?: unknown; componentStack?: unknown;
  path?: unknown; method?: unknown; status?: unknown;
  requestId?: unknown; href?: unknown; userAgent?: unknown; kind?: unknown;
};

clientErrors.post('/', async (c) => {
  const u = c.var.user;

  const retryAfter = rateLimited(u.id);
  if (retryAfter !== null) {
    return c.json({ error: 'Too many reports' }, 429, { 'Retry-After': String(retryAfter) });
  }

  const body = await c.req.json<Body>().catch(() => null);
  if (!body) return c.json({ error: 'JSON body required' }, 400);

  const message = str(body.message, MAX.message);
  if (!message) return c.json({ error: 'message is required' }, 400);

  // The failing path comes from the browser, so it gets the same redaction as
  // anything we log ourselves — a vendor-portal or Shippo URL carries its whole
  // credential in the path, and this sink is durable.
  const raw = str(body.path, MAX.href);
  let path: string | undefined;
  let query: string | undefined;
  if (raw) {
    const [p, q] = raw.split('?');
    path = redactSensitivePath(p!);
    query = q ? redactSensitiveQuery(`?${q}`) : undefined;
  }

  const record = {
    // The id of the request that failed in the browser — not this report's.
    // That is the whole point: it joins to the backend's own log line.
    failedRequestId: str(body.requestId, MAX.id),
    // 'fetch' or 'render' — a failed call and a crashed render need different
    // first questions, and the grep tag alone can't tell them apart.
    failureKind: str(body.kind, 32) ?? 'fetch',
    status: typeof body.status === 'number' ? body.status : undefined,
    method: str(body.method, 16),
    href: str(body.href, MAX.href),
    userAgent: str(body.userAgent, MAX.ua),
    componentStack: str(body.componentStack, MAX.componentStack),
  };

  // stdout first, and not as a nicety: ERROR_LOG_DIR is unset on Railway, so the
  // JSONL sink below never runs there and this line is the only trace that
  // reaches `railway logs`.
  console.error(JSON.stringify({
    level: 'warn',
    kind: 'client-error',
    requestId: c.var.requestId,
    userEmail: u.email,
    message,
    path,
    ...record,
  }));

  const dir = process.env.ERROR_LOG_DIR;
  if (dir) {
    void appendErrorRecord(dir, {
      ts: new Date().toISOString(),
      requestId: c.var.requestId ?? 'unknown',
      level: 'warn',
      method: record.method,
      path,
      query,
      userId: u.id,
      userEmail: u.email,
      message,
      stack: str(body.stack, MAX.stack),
      context: { source: 'client', ...record },
    });
  }

  // Nothing to say back — the SPA never reads this, and it is already showing
  // the user an error.
  return c.body(null, 204);
});

export default clientErrors;
