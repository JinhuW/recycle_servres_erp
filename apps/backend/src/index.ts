// Recycle Servers ERP — Hono backend entrypoint (served by src/server.ts on Node).
// Routes are mounted under /api/*. CORS is open in dev so the Vite SPA on
// :5173 can call us; set CORS_ALLOWED_ORIGINS in prod to lock it down.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { authMiddleware } from './auth';
import { dbScope } from './db';
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
import type { Env, User } from './types';

const app = new Hono<{ Bindings: Env; Variables: { user: User } }>();

app.use('*', logger());
app.use(
  '*',
  cors({
    // With credentials:true, reflecting an arbitrary origin lets any site
    // make credentialed calls. In production set CORS_ALLOWED_ORIGINS to the
    // real frontend origin(s); only those are then echoed back. Unset keeps
    // the permissive dev behavior (Vite SPA on a shifting localhost port).
    origin: (origin, c) => {
      const configured = (c.env as Env).CORS_ALLOWED_ORIGINS ?? '';
      const allow = configured.split(',').map((s: string) => s.trim()).filter(Boolean);
      if (allow.length === 0) return origin ?? '*';
      return allow.includes(origin) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }),
);
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

// ── Public ──────────────────────────────────────────────────────────────────
app.route('/api/auth', authRoutes);

// ── Authed ──────────────────────────────────────────────────────────────────
app.use('/api/me/*', authMiddleware);
app.use('/api/dashboard/*', authMiddleware);
app.use('/api/orders/*', authMiddleware);
app.use('/api/market/*', authMiddleware);
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

app.onError((err, c) => {
  console.error('Unhandled', err);
  return c.json({ error: err.message ?? 'Internal error' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
