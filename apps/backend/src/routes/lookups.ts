// Single endpoint that returns every dropdown / status / source list the
// frontend used to hardcode. The SPA fetches /api/lookups once at boot and
// caches the result; individual pages then read from that cache instead of
// importing static arrays.

import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const lookups = new Hono<{ Bindings: Env; Variables: { user: User } }>();

lookups.get('/', async (c) => {
  const sql = getDb(c.env);

  const [catalogRows, sourceRows, statusRows] = await Promise.all([
    sql`
      SELECT "group", value
      FROM catalog_options
      WHERE active = TRUE
      ORDER BY "group", position, value
    `,
    sql`
      SELECT id, label
      FROM price_sources
      WHERE active = TRUE
      ORDER BY position, label
    `,
    sql`
      SELECT id, label, short_label, tone, needs_meta, position
      FROM sell_order_statuses
      ORDER BY position
    `,
  ]);

  const catalog: Record<string, string[]> = {};
  for (const row of catalogRows) {
    (catalog[row.group as string] ??= []).push(row.value as string);
  }

  return c.json({
    catalog,
    priceSources: sourceRows.map(r => ({ id: r.id as string, label: r.label as string })),
    sellOrderStatuses: statusRows.map(r => ({
      id: r.id as string,
      label: r.label as string,
      short: r.short_label as string,
      tone: r.tone as string,
      needsMeta: r.needs_meta as boolean,
      position: r.position as number,
    })),
  });
});

export default lookups;
