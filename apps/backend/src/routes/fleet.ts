import { Hono } from 'hono';
import { FLEET_TABLES, fleetTablesPresent } from '../fleet/sql';
import { managerOnly, type ManagerEnv } from '../fleet/auth';
import { getDb } from '../db';

// ─── Fleet ────────────────────────────────────────────────────────────────────
// The city task queue and the worker slots (src/fleet/). Each sub-module mounts
// its own routes here under its own scope: manager routes carry the session
// cookie, host and worker routes a bearer (fleet/auth.ts). Nothing here is
// behaviour yet; health says whether the schema reached this database.

const fleet = new Hono<ManagerEnv>();

fleet.get('/health', managerOnly, async (c) => {
  const tables = await fleetTablesPresent(getDb(c.env));
  const ok = FLEET_TABLES.every((t) => tables.includes(t));
  return c.json({ ok, tables });
});

export default fleet;
