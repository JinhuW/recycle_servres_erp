import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const warehouses = new Hono<{ Bindings: Env; Variables: { user: User } }>();

warehouses.get('/', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`SELECT id, name, short, region FROM warehouses ORDER BY region, short`;
  return c.json({ items: rows });
});

export default warehouses;
