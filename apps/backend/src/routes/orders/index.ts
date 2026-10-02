// /api/orders: one module per concern, mounted on one router. No two routes
// share a method and a pattern, so the mount order changes nothing; it
// follows the order the single file used to register them in.
import { Hono } from 'hono';
import type { OrdersEnv } from './shared';
import listRoutes from './list';
import detailRoutes from './detail';
import lifecycleRoutes from './lifecycle';
import spreadsheetRoutes from './spreadsheet';
import createRoutes from './create';
import patchRoutes from './patch';
import evidenceRoutes from './evidence';
import checksRoutes from './checks';

const orders = new Hono<OrdersEnv>();
orders.route('/', listRoutes);
orders.route('/', detailRoutes);
orders.route('/', lifecycleRoutes);
orders.route('/', spreadsheetRoutes);
orders.route('/', createRoutes);
orders.route('/', patchRoutes);
orders.route('/', evidenceRoutes);
orders.route('/', checksRoutes);

export default orders;
