import { Hono } from 'hono';
import { getDb } from '../db';
import { getWorkspaceSetting } from '../lib/settings';
import { formatRefPrice, type MarketValueRow } from '../lib/market';
import { applyMarketWrites, type WriteValue } from '../lib/marketWrite';
import { PART_PREFIX_RE } from '../lib/part-number';
import { bearerGuard } from '../oauth/guard';
import type { Env, User } from '../types';

const market = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// Reference prices for the Market Value screen. Search + category filter +
// computed maxBuy (avgSell × (1 - 30% margin target)).
market.get('/', async (c) => {
  const sql = getDb(c.env);
  const category = c.req.query('category');
  const search = c.req.query('q')?.toLowerCase().trim();

  // `internal_sales` aggregates the team's last-30d projected sell prices
  // from PO order_lines, keyed by canonical part_number (same rule as
  // lib/part-number.ts). Used by the "Internal sales (last 30d)" row in the
  // Market Value detail's Price sources panel.
  const rows = await sql<MarketValueRow[]>`
    WITH internal_sales AS (
      SELECT UPPER(REGEXP_REPLACE(
               REGEXP_REPLACE(COALESCE(l.part_number, ''), ${PART_PREFIX_RE}, '', 'i'),
               '[[:space:]]+', '', 'g'
             )) AS canon,
             AVG(l.sell_price)::float AS avg_price,
             COUNT(*)::int AS samples
      FROM order_lines l
      JOIN orders o ON o.id = l.order_id
      WHERE o.created_at >= NOW() - INTERVAL '30 days'
        AND l.sell_price IS NOT NULL
        AND l.part_number IS NOT NULL
        AND l.part_number <> ''
      GROUP BY canon
    )
    SELECT rp.id, rp.category, rp.brand, rp.capacity, rp.type, rp.classification,
           rp.rank, rp.speed, rp.interface, rp.form_factor, rp.description,
           rp.part_number, rp.label, rp.sub_label,
           rp.target::float AS target, rp.low_price::float AS low_price,
           rp.high_price::float AS high_price, rp.avg_sell::float AS avg_sell,
           rp.trend, rp.samples, rp.source, rp.stock, rp.demand, rp.history,
           rp.updated_at, rp.health::float AS health, rp.rpm,
           ils.avg_price AS internal_avg,
           ils.samples   AS internal_samples
    FROM ref_prices rp
    LEFT JOIN internal_sales ils
      ON ils.canon = UPPER(REGEXP_REPLACE(
                       REGEXP_REPLACE(COALESCE(rp.part_number, ''), ${PART_PREFIX_RE}, '', 'i'),
                       '[[:space:]]+', '', 'g'
                     ))
    WHERE (${category ?? null}::text IS NULL OR rp.category = ${category ?? null})
      AND (
        ${search ?? null}::text IS NULL
        OR LOWER(rp.label) LIKE '%' || ${search ?? ''} || '%'
        OR LOWER(COALESCE(rp.part_number,'')) LIKE '%' || ${search ?? ''} || '%'
      )
    ORDER BY rp.updated_at DESC
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
