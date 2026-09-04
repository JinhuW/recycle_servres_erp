// Recycle Servers ERP — Hono backend entrypoint (served by src/server.ts on Node).
// Routes are mounted under /api/*. CORS is open in dev so the Vite SPA on
// :5173 can call us; set CORS_ALLOWED_ORIGINS in prod to lock it down.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';

import { UPLOAD_HARD_CAP_BYTES } from './lib/settings';
import { appendErrorRecord, redactSensitivePath, redactSensitiveQuery } from './lib/error-log';
import { log, releaseCommit, releaseVersion, runWithLogContext } from './lib/log';

import { describeOcr } from './ai';
import { authMiddleware } from './auth';
import { csrfGuard } from './csrf';
import { describeShipping } from './shipping';
import { getDb } from './db';
import { readBuildTime } from './lib/version';
import { metricsMiddleware, metricsHandler } from './metrics';
import authRoutes from './routes/auth';
import meRoutes from './routes/me';
import dashboardRoutes from './routes/dashboard';
import ordersRoutes from './routes/orders';
import shipmentsRoutes from './routes/shipments';
import { shipmentsList as shipmentsListRoutes, shippingContacts as shippingContactsRoutes } from './routes/shipmentsGlobal';
import packagesRoutes from './routes/packages';
import shippingPublicRoutes from './routes/shippingPublic';
import shippoWebhookRoutes from './routes/shippoWebhook';
import marketRoutes from './routes/market';
import scanRoutes from './routes/scan';
import notificationsRoutes from './routes/notifications';
import trackerRoutes from './routes/tracker';
import coordinatorRoutes from './routes/coordinator';
import bankTxRoutes from './routes/bankTx';
import internalTxRoutes from './routes/internalTx';
import suppliersRoutes from './routes/suppliers';
import warehousesRoutes from './routes/warehouses';
import customersRoutes from './routes/customers';
import sellOrdersRoutes from './routes/sellOrders';
import inventoryRoutes from './routes/inventory';
import membersRoutes from './routes/members';
import lookupsRoutes from './routes/lookups';
import categoriesRoutes from './routes/categories';
import itemTypesRoutes from './routes/itemTypes';
import attachmentsRoutes from './routes/attachments';
import workspaceRoutes from './routes/workspace';
import { fxRates as fxRatesRoutes } from './routes/fxRates';
import vendorPublicRoutes from './routes/vendorPublic';
import vendorBidsRoutes from './routes/vendorBids';
import activityRoutes from './routes/activity';
import clientErrorRoutes from './routes/clientErrors';
import clientTimingRoutes from './routes/clientTimings';
import wellKnown, { oauth as oauthRoutes, oauthAdmin } from './oauth/server';
import { handleMcp } from './mcp/server';
import { bearerGuard } from './oauth/guard';
import type { Env, User } from './types';

const app = new Hono<{ Bindings: Env; Variables: { user: User; requestId: string } }>();

// ── Request ID ───────────────────────────────────────────────────────────────
// Attach a per-request UUID so every log line and error can be correlated.
// Returned in X-Request-Id so clients can surface it in bug reports.
//
// Everything downstream runs inside the log context, so any log.* call in a
// route — or in a .catch() that route registers and never awaits — carries this
// id without being handed anything. Must stay the OUTERMOST middleware: the
// request-log middleware below has to run inside the store.
app.use('*', (c, next) => {
  const id = crypto.randomUUID();
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  return runWithLogContext({ requestId: id }, () => next());
});

// One structured line per completed request. requestId (and userId, once auth
// runs) arrive from the log context opened above. The path is redacted the same
// way the error sink redacts it — vendor portal tokens travel in the URL and
// must not land in stdout.
//
// This deliberately overlaps metricsMiddleware on status and duration: the
// histogram labels by c.req.routePath to bound cardinality, while this carries
// the real path plus a requestId — neither of which can ever be a Prometheus
// label. Aggregate view vs. forensic view; don't merge them.
//
// try/finally because a throw from bodyLimit, the CORS origin callback, or
// app.onError itself escapes past this middleware, and a request that blew up
// is exactly the one you want a line for.

// A 4xx line used to be byte-identical to a 200 except for the status integer,
// which made a refusal undiagnosable after the fact: PATCH /api/orders/:id
// alone has six distinct 409 branches and the line matched all of them equally.
// 4xx only — a 5xx already gets its own log.error with a stack from
// app.onError, and its body is the generic message anyway.
//
// Two different bounds, and they are not interchangeable. ERROR_BODY_MAX guards
// the read; it has to stay well clear of a real body, because the slice happens
// before JSON.parse and a truncated body throws — costing the line the very
// reason it exists for. A committed-lines 409 carrying offendingLineIds runs
// past 256 bytes on three lines alone. REASON_MAX then bounds what is logged,
// which is where a caller-influenced string has to be cut short.
const ERROR_BODY_MAX = 2048;
const REASON_MAX = 256;

async function refusalReason(res: Response): Promise<string | undefined> {
  if (!res.headers.get('Content-Type')?.includes('application/json')) return undefined;
  try {
    // clone(), not the response itself: the body is a live stream the server
    // has yet to consume, and reading it here would leave the client nothing.
    const text = (await res.clone().text()).slice(0, ERROR_BODY_MAX);
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error.slice(0, REASON_MAX) : undefined;
  } catch {
    // A body that isn't the shape we log is not itself worth a line.
    return undefined;
  }
}

app.use('*', async (c, next) => {
  const startedAt = performance.now();
  let failed = false;
  try {
    await next();
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    const status = c.res.status;
    const reason = status >= 400 && status < 500 ? await refusalReason(c.res) : undefined;
    log.info('request', {
      method: c.req.method,
      path: redactSensitivePath(c.req.path),
      // On the thrown path this can still read 200 — the error response hasn't
      // been installed yet, which is what `failed` disambiguates.
      status,
      ms: Math.round(performance.now() - startedAt),
      ...(reason !== undefined && { error: reason }),
      ...(failed && { failed: true }),
    });
  }
});

// ── Origin lockdown ──────────────────────────────────────────────────────────
// When PROXY_SECRET is set, only requests carrying it in X-Proxy-Secret are
// honored. The Cloudflare Worker (the sole intended caller) injects the header,
// so direct hits to the public Railway origin — including /metrics — are
// refused with 403. /api/health is exempt because Railway's healthcheck probes
// the container directly, bypassing the Worker. Unset (Docker stack / local
// dev) disables the gate, so this stays backward-compatible.
app.use('*', async (c, next) => {
  const secret = (c.env as Env).PROXY_SECRET;
  if (secret && c.req.path !== '/api/health') {
    if (c.req.header('X-Proxy-Secret') !== secret) {
      return c.json({ error: 'forbidden' }, 403);
    }
  }
  await next();
});

app.use(
  '*',
  cors({
    // With credentials:true, reflecting an arbitrary origin lets any site
    // make credentialed calls. In production set CORS_ALLOWED_ORIGINS to the
    // real frontend origin(s); only those are then echoed back. When unset we
    // FAIL CLOSED — only loopback origins (the Vite SPA on a shifting
    // localhost port) are permitted, never an arbitrary remote site.
    origin: (origin, c) => {
      const configured = (c.env as Env).CORS_ALLOWED_ORIGINS ?? '';
      const allow = configured.split(',').map((s: string) => s.trim()).filter(Boolean);
      if (allow.length > 0) return allow.includes(origin) ? origin : null;
      if (!origin) return null;
      try {
        const host = new URL(origin).hostname;
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
          return origin;
        }
      } catch { /* malformed Origin header — deny */ }
      return null;
    },
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: [
      'Content-Type', 'Authorization', 'X-Requested-By',
      // Streamable HTTP transport headers, for browser-hosted MCP clients and
      // the MCP Inspector. claude.ai and chatgpt.com call server-to-server and
      // never preflight, so these matter only for the in-browser case.
      'MCP-Protocol-Version', 'Mcp-Session-Id', 'Last-Event-ID',
    ],
    // Without this an in-browser client can't read the WWW-Authenticate
    // challenge and so can't discover where to start the OAuth flow.
    exposeHeaders: ['WWW-Authenticate', 'X-Request-Id'],
    credentials: true,
  }),
);
app.use('*', metricsMiddleware);
app.get('/metrics', metricsHandler);
app.use('*', csrfGuard);

app.get('/', (c) =>
  c.json({
    service: 'recycle-erp-backend',
    docs: '/api/* — see README.md',
  }),
);

// Liveness/readiness probe for the edge proxy (Traefik) and Docker. Returns
// 200 only when the API can actually reach Postgres — unlike the SPA's
// catch-all, which 200s every path even when the backend is dead and so
// hides outages from the load balancer. Unauthenticated by design.
app.get('/api/health', async (c) => {
  // Build provenance — resolved through the same helpers every log line uses,
  // so the health payload and the logs can never disagree about which build is
  // running. They carry the APP_VERSION/GIT_SHA handling: those are
  // release-time Docker build args (scripts/release.sh), Railway never passes
  // them and the Dockerfile bakes them as EMPTY env strings, hence || not ??.
  const version = releaseVersion();
  const commit = releaseCommit();
  // ISO-8601 UTC or null; the frontend shows this instead of the sha, which
  // means nothing to the people reading the footer.
  const builtAt = process.env.BUILD_TIME || readBuildTime();
  // Which providers this deployment actually has credentials for. Every one of
  // these falls back silently, so a release that shipped without a secret looks
  // identical to a healthy one until someone notices packages never move. Modes
  // only — no key values, no more than set/unset.
  const ship = describeShipping(c.env as Env);
  const providers = { ...ship, ocr: describeOcr(c.env as Env) };
  try {
    await getDb(c.env)`SELECT 1`;
    return c.json({ status: 'ok', version, commit, builtAt, providers });
  } catch (e) {
    log.error('health check failed', e);
    return c.json({ status: 'error', error: 'database unreachable', version, commit, builtAt, providers }, 503);
  }
});

// ── Body caps ────────────────────────────────────────────────────────────────
// The multipart upload endpoints are allowed up to UPLOAD_HARD_CAP_BYTES
// (50 MiB). All other API routes get a tight 1 MiB JSON cap so a malformed or
// malicious request is rejected before auth, without buffering.
const JSON_BODY_LIMIT = 1_048_576; // 1 MiB
const uploadBodyLimit = bodyLimit({ maxSize: UPLOAD_HARD_CAP_BYTES });
// Only the actual multipart endpoints get the generous cap. A prefix-wide
// exemption (e.g. all of /api/sell-orders/*) would let every JSON endpoint
// under it buffer 50 MiB bodies.
const isUploadPath = (path: string): boolean =>
  path === '/api/scan/label' ||
  path === '/api/scan/payment' ||
  path === '/api/attachments' ||
  /^\/api\/(orders|sell-orders)\/[^/]+\/status-meta\/[^/]+\/attachments$/.test(path) ||
  // A line photo comes straight off a phone camera at several MB, uncompressed.
  // Left under the JSON cap it 413s before the handler that would have checked
  // it against the upload limits ever runs.
  /^\/api\/orders\/[^/]+\/lines\/[^/]+\/photos$/.test(path) ||
  // Vendor bid sheets round-trip our own template, which embeds item photos —
  // they routinely exceed the JSON cap. The route enforces its own 8 MB limit.
  /^\/api\/sell-orders\/[^/]+\/price-import\/preview$/.test(path);

// All other routes: apply the 1 MiB JSON cap.
const jsonBodyLimit = bodyLimit({
  maxSize: JSON_BODY_LIMIT,
  onError: (c) => c.json({ error: 'Payload too large' }, 413),
});
app.use('*', (c, next) => {
  if (isUploadPath(c.req.path)) return uploadBodyLimit(c, next);
  return jsonBodyLimit(c, next);
});

// ── Cache headers on reference-data endpoints ────────────────────────────────
// Read-only reference endpoints get a short private cache so browsers/CDN don't
// hammer the DB on every navigation. User-specific endpoints (/api/me,
// /api/dashboard) are excluded — and so is /api/warehouses: it is the one
// reference list that gets edited and re-read inside a single user action, and
// the browser serving its 60s-old copy back to Settings made a saved shipping
// address look like it had never persisted.
// Safe methods only: these prefixes also carry POST/PATCH endpoints, whose
// responses have no business advertising a cache lifetime.
const CACHEABLE_PREFIXES = ['/api/lookups', '/api/categories', '/api/workspace'];
app.use('*', async (c, next) => {
  await next();
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return;
  const path = c.req.path;
  if (CACHEABLE_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) {
    c.header('Cache-Control', 'private, max-age=60');
  }
});

// ── Public ──────────────────────────────────────────────────────────────────
app.route('/api/auth', authRoutes);
app.route('/api/public/vendor', vendorPublicRoutes);
app.route('/api/public/shipping', shippingPublicRoutes);
app.route('/api/public/shippo', shippoWebhookRoutes);
app.route('/.well-known', wellKnown);
app.route('/oauth', oauthRoutes);

// MCP JSON-RPC endpoint — Bearer-authenticated (no cookies, no CSRF). Sits
// outside the cookie-auth /api/* tree so authMiddleware doesn't run.
app.use('/api/mcp', bearerGuard({ scopes: [] }));
app.post('/api/mcp', (c) => handleMcp(c));
app.get('/api/mcp', (c) => {
  c.header('Allow', 'POST');
  return c.json({ error: 'use POST for JSON-RPC' }, 405);
});

app.use('/api/me/*', authMiddleware);
app.use('/api/dashboard/*', authMiddleware);
app.use('/api/orders/*', authMiddleware);
// /api/market/values is Bearer-only (scraper push surface); all other
// /api/market/* paths use the SPA cookie-auth flow.
app.use('/api/market/*', async (c, next) => {
  if (c.req.path === '/api/market/values') return next();
  // authMiddleware's generic is the cookie-auth subset of this app's context;
  // the cast is safe because authMiddleware only reads/sets `user`.
  return (authMiddleware as unknown as (c: unknown, next: unknown) => Promise<void>)(c, next);
});
app.use('/api/scan/*', authMiddleware);
app.use('/api/notifications/*', authMiddleware);
app.use('/api/warehouses/*', authMiddleware);
app.use('/api/customers/*', authMiddleware);
app.use('/api/sell-orders/*', authMiddleware);
app.use('/api/inventory/*', authMiddleware);
app.use('/api/members/*', authMiddleware);
app.use('/api/lookups/*', authMiddleware);
app.use('/api/categories/*', authMiddleware);
app.use('/api/item-types', authMiddleware);
app.use('/api/item-types/*', authMiddleware);
app.use('/api/attachments/*', authMiddleware);
app.use('/api/workspace/*', authMiddleware);
app.use('/api/vendor-bids/*', authMiddleware);
// The feed lives at the bare /api/activity, which `/*` alone doesn't cover.
app.use('/api/activity', authMiddleware);
app.use('/api/activity/*', authMiddleware);
// Same bare-path shape — the report POSTs to the prefix root, so a `/*`-only
// registration would leave it unauthenticated.
app.use('/api/client-errors', authMiddleware);
app.use('/api/client-errors/*', authMiddleware);
// Same bare-path-plus-wildcard pair, and for the same reason: the report POSTs
// to the prefix root, which `/*` alone does not match.
app.use('/api/client-timings', authMiddleware);
app.use('/api/client-timings/*', authMiddleware);
// Bare paths matter here too: the shipments list and packages list live at
// the prefix root. /api/public/shipping stays public — /api/shipping/* does
// not match it.
app.use('/api/shipments', authMiddleware);
app.use('/api/shipments/*', authMiddleware);
app.use('/api/shipping/*', authMiddleware);
app.use('/api/packages', authMiddleware);
app.use('/api/packages/*', authMiddleware);
// Both spellings: GET /api/suppliers has no trailing segment to match the
// wildcard, so registering only `/*` would leave the list route unauthenticated.
app.use('/api/suppliers', authMiddleware);
app.use('/api/suppliers/*', authMiddleware);

app.route('/api/me', meRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/orders', ordersRoutes);
// Second sub-app on the same prefix: /api/orders/:orderId/shipments/*.
app.route('/api/orders', shipmentsRoutes);
app.route('/api/shipments', shipmentsListRoutes);
app.route('/api/shipping', shippingContactsRoutes);
app.route('/api/packages', packagesRoutes);
app.route('/api/market', marketRoutes);
app.route('/api/scan', scanRoutes);
app.route('/api/notifications', notificationsRoutes);
app.route('/api/warehouses', warehousesRoutes);
app.route('/api/customers', customersRoutes);
app.route('/api/sell-orders', sellOrdersRoutes);
app.route('/api/inventory', inventoryRoutes);
app.route('/api/members', membersRoutes);
app.route('/api/lookups', lookupsRoutes);
app.route('/api/categories', categoriesRoutes);
app.route('/api/item-types', itemTypesRoutes);
app.route('/api/attachments', attachmentsRoutes);
app.route('/api/workspace', workspaceRoutes);
app.route('/api/workspace', fxRatesRoutes);
app.route('/api/vendor-bids', vendorBidsRoutes);
app.route('/api/activity', activityRoutes);
app.route('/api/client-errors', clientErrorRoutes);
app.route('/api/client-timings', clientTimingRoutes);
// /api/oauth/clients: cookie-authed, manager-only. The sub-app self-applies
// authMiddleware + a role check, so we don't add it to the broad /api/* auth
// list above. csrfGuard still runs from the global stack.
app.route('/api/oauth/clients', oauthAdmin);
// Self-applies authMiddleware + manager gate (oauthAdmin pattern).
app.route('/api/tracker', trackerRoutes);
// Same shape: self-applied authMiddleware + manager gate.
app.route('/api/coordinator', coordinatorRoutes);
// Same shape: self-applied authMiddleware + manager gate.
app.route('/api/bank-transactions', bankTxRoutes);
app.route('/api/internal-transactions', internalTxRoutes);
// Clients (buy-side counterparties). Deliberately NOT in CACHEABLE_PREFIXES:
// like /api/warehouses this list is edited and re-read inside one user action,
// and a 60s browser copy is what made a saved warehouse address look unsaved.
app.route('/api/suppliers', suppliersRoutes);

app.onError((err, c) => {
  // Log the full error server-side with the request ID for correlation, but
  // never return err.message to the client — postgres.js errors embed
  // table/column/constraint names and SQL fragments that aid schema
  // reconnaissance.
  const requestId = c.var.requestId ?? 'unknown';
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  log.error('Unhandled error', { error: message, stack });

  // Also persist to the dedicated error-log file (separate from Docker's
  // stdout stream). Mounted via ERROR_LOG_DIR so an operator can grep
  // weeks of 500s without paging through container logs.
  const dir = process.env.ERROR_LOG_DIR;
  if (dir) {
    const user = c.var.user;
    const url = new URL(c.req.url);
    void appendErrorRecord(dir, {
      ts: new Date().toISOString(),
      requestId,
      method: c.req.method,
      path: redactSensitivePath(url.pathname),
      query: redactSensitiveQuery(url.search),
      userId: user?.id,
      userEmail: user?.email,
      message,
      stack,
    });
  }

  return c.json({ error: 'Internal error' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
