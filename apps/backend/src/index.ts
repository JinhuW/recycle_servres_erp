// Recycle Servers ERP — Cloudflare Worker entrypoint.
// Routes are mounted under /api/*. CORS is open in dev so the Vite SPA on
// :5173 can call us; in prod tighten the allowlist.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import { authMiddleware } from './auth';
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
import workflowRoutes from './routes/workflow';
import categoriesRoutes from './routes/categories';
import type { Env, User } from './types';

const app = new Hono<{ Bindings: Env; Variables: { user: User } }>();

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: (origin) => origin ?? '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }),
);

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
app.use('/api/workflow/*', authMiddleware);
app.use('/api/categories/*', authMiddleware);

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
app.route('/api/workflow', workflowRoutes);
app.route('/api/categories', categoriesRoutes);

app.onError((err, c) => {
  console.error('Unhandled', err);
  return c.json({ error: err.message ?? 'Internal error' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
