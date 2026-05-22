import { Hono } from 'hono';
import { getDb } from '../db';
import { getWorkspaceSetting } from '../lib/settings';
import { formatRefPrice, type MarketValueRow } from '../lib/market';
import { applyMarketWrites, type WriteValue } from '../lib/marketWrite';
import { bearerGuard } from '../oauth/guard';
import type { Env, User } from '../types';

const market = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// Reference prices for the Market Value screen. Search + category filter +
// computed maxBuy (avgSell × (1 - 30% margin target)).
market.get('/', async (c) => {
  const sql = getDb(c.env);
  const category = c.req.query('category');
  const search = c.req.query('q')?.toLowerCase().trim();

  const rows = await sql<MarketValueRow[]>`
    SELECT id, category, brand, capacity, type, classification, rank, speed,
           interface, form_factor, description, part_number, label, sub_label,
           target::float AS target, low_price::float AS low_price,
           high_price::float AS high_price, avg_sell::float AS avg_sell,
           trend, samples, source, stock, demand, history, updated_at,
           health::float AS health, rpm
    FROM ref_prices
    WHERE (${category ?? null}::text IS NULL OR category = ${category ?? null})
      AND (
        ${search ?? null}::text IS NULL
        OR LOWER(label) LIKE '%' || ${search ?? ''} || '%'
        OR LOWER(COALESCE(part_number,'')) LIKE '%' || ${search ?? ''} || '%'
      )
    ORDER BY updated_at DESC
    LIMIT 100
  `;

  const TARGET_MARGIN = await getWorkspaceSetting(sql, 'target_margin', 0.30);
  return c.json({
    targetMargin: TARGET_MARGIN,
    items: rows.map(r => formatRefPrice(r, TARGET_MARGIN)),
  });
});

// Scraper push surface. Bearer-only (no cookie/CSRF). Batch capped at 500 rows
// and rejected before the transaction so oversized payloads cost us nothing.
market.post('/values', bearerGuard({ scopes: ['market:write'] }), async (c) => {
  const body = (await c.req.json().catch(() => null)) as null | { values?: WriteValue[] };
  if (!body || !Array.isArray(body.values)) return c.json({ error: 'invalid_request' }, 400);
  if (body.values.length > 500) {
    return c.json({ error: 'payload_too_large', hint: 'paginate to <=500 rows' }, 413);
  }
  const sql = getDb(c.env);
  const result = await applyMarketWrites(sql, body.values);
  return c.json(result);
});

export default market;
