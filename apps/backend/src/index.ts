// Recycle Servers ERP — Hono backend entrypoint (served by src/server.ts on Node).
// Routes are mounted under /api/*. CORS is open in dev so the Vite SPA on
// :5173 can call us; set CORS_ALLOWED_ORIGINS in prod to lock it down.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';

import { UPLOAD_HARD_CAP_BYTES } from './lib/settings';

import { authMiddleware } from './auth';
import { csrfGuard } from './csrf';
import { dbScope, getDb } from './db';
import { metricsMiddleware, metricsHandler } from './metrics';
import authRoutes from './routes/auth';
import meRoutes from './routes/me';
import dashboardRoutes from './routes/dashboard';
import ordersRoutes from './routes/orders';
import marketRoutes from './routes/market';
import scanRoutes from './routes/scan';
import notificationsRoutes from './routes/notifications';
import warehousesRoutes from './routes/warehouses';
import customersRoutes from './routes/customers';
import sellOrdersRoutes from './routes/sellOrders';
import inventoryRoutes from './routes/inventory';
import membersRoutes from './routes/members';
import lookupsRoutes from './routes/lookups';
import categoriesRoutes from './routes/categories';
import attachmentsRoutes from './routes/attachments';
import workspaceRoutes from './routes/workspace';
import vendorPublicRoutes from './routes/vendorPublic';
import vendorBidsRoutes from './routes/vendorBids';
import wellKnown, { oauth as oauthRoutes } from './oauth/server';
import { handleMcp } from './mcp/server';
import { bearerGuard } from './oauth/guard';
import type { Env, User } from './types';

const app = new Hono<{ Bindings: Env; Variables: { user: User; requestId: string } }>();

// ── Request ID ───────────────────────────────────────────────────────────────
// Attach a per-request UUID so every log line and error can be correlated.
// Returned in X-Request-Id so clients can surface it in bug reports.
app.use('*', async (c, next) => {
  const id = crypto.randomUUID();
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  await next();
});

app.use('*', logger());
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
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-By'],
    credentials: true,
  }),
);
app.use('*', metricsMiddleware);
app.get('/metrics', metricsHandler);
app.use('*', csrfGuard);
// Bind one pooled Postgres client per request and close it when the request
// ends — prevents the connection-pool leak that exhausts Postgres and takes
// the whole service down under load.
app.use('*', (c, next) => dbScope(c, next));

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
  try {
    await getDb(c.env)`SELECT 1`;
    return c.json({ status: 'ok' });
  } catch (e) {
    console.error('health check failed', e);
    return c.json({ status: 'error', error: 'database unreachable' }, 503);
  }
});

// ── Body caps ────────────────────────────────────────────────────────────────
// Upload routes (scan / attachments / sell-orders) are allowed up to
// UPLOAD_HARD_CAP_BYTES (50 MiB) because they carry multipart file payloads.
// All other API routes get a tight 1 MiB JSON cap so a malformed or malicious
// request is rejected before auth, without buffering.
//
// Order matters: upload routes register their cap FIRST. Hono matches
// middleware in registration order; a path-specific handler runs only once, so
// when a request matches /api/scan/* it will hit the upload limit and not the
// global 1 MiB limit (because the global limit is applied only to paths that
// did NOT match an upload prefix below).
const JSON_BODY_LIMIT = 1_048_576; // 1 MiB
const uploadBodyLimit = bodyLimit({ maxSize: UPLOAD_HARD_CAP_BYTES });
// Upload-bearing routes: apply the generous cap first.
app.use('/api/scan/*', uploadBodyLimit);
app.use('/api/attachments/*', uploadBodyLimit);
app.use('/api/sell-orders/*', uploadBodyLimit);

// All other routes: apply the 1 MiB JSON cap.  We skip the three upload
// prefixes with an explicit guard so the middleware doesn't double-trigger on
// them (Hono runs '*' after path-specific handlers in this version).
const jsonBodyLimit = bodyLimit({
  maxSize: JSON_BODY_LIMIT,
  onError: (c) => c.json({ error: 'Payload too large' }, 413),
});
app.use('*', (c, next) => {
  const path = c.req.path;
  if (
    path.startsWith('/api/scan/') ||
    path.startsWith('/api/attachments/') ||
    path.startsWith('/api/sell-orders/')
  ) {
    return next();
  }
  return jsonBodyLimit(c, next);
});

// ── Cache headers on reference-data endpoints ────────────────────────────────
// Read-only reference endpoints (lookups, categories, workspace, warehouses)
// get a short private cache so browsers/CDN don't hammer the DB on every
// navigation. User-specific endpoints (/api/me, /api/dashboard) are excluded.
const CACHEABLE_PREFIXES = ['/api/lookups', '/api/categories', '/api/workspace', '/api/warehouses'];
app.use('*', async (c, next) => {
  await next();
  const path = c.req.path;
  if (CACHEABLE_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) {
    c.header('Cache-Control', 'private, max-age=60');
  }
});

// ── Public ──────────────────────────────────────────────────────────────────
app.route('/api/auth', authRoutes);
app.route('/api/public/vendor', vendorPublicRoutes);
app.route('/.well-known', wellKnown);
app.route('/oauth', oauthRoutes);

// MCP JSON-RPC endpoint — Bearer-authenticated (no cookies, no CSRF). Sits
// outside the cookie-auth /api/* tree so authMiddleware doesn't run.
app.use('/api/mcp', bearerGuard({ scopes: ['market:read'] }));
app.post('/api/mcp', (c) => handleMcp(c));
app.get('/api/mcp', (c) => c.json({ error: 'use POST for JSON-RPC' }, 405));

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
app.use('/api/attachments/*', authMiddleware);
app.use('/api/workspace/*', authMiddleware);
app.use('/api/vendor-bids/*', authMiddleware);

app.route('/api/me', meRoutes);
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/orders', ordersRoutes);
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
app.route('/api/attachments', attachmentsRoutes);
app.route('/api/workspace', workspaceRoutes);
app.route('/api/vendor-bids', vendorBidsRoutes);

app.onError((err, c) => {
  // Log the full error server-side with the request ID for correlation, but
  // never return err.message to the client — postgres.js errors embed
  // table/column/constraint names and SQL fragments that aid schema
  // reconnaissance.
  const requestId = c.var.requestId ?? 'unknown';
  console.error(JSON.stringify({
    level: 'error',
    requestId,
    message: 'Unhandled error',
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  }));
  return c.json({ error: 'Internal error' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
