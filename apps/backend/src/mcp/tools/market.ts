import type postgres from 'postgres';
import { formatRefPrice, type MarketValueRow } from '../../lib/market';
import { getWorkspaceSetting } from '../../lib/settings';
import { PART_PREFIX_RE } from '../../lib/part-number';

export const TOOL_DEFS = [
  {
    name: 'list_market_values',
    description: 'List current market-value records from ref_prices with optional category + substring filter.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        q: { type: 'string', description: 'substring match on label and part_number' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_market_value',
    description: 'Fetch one market-value record. Exactly one of id or partNumber must be provided.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        partNumber: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
] as const;

export async function callListMarketValues(
  sql: postgres.Sql,
  args: { category?: string; q?: string; limit?: number },
) {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const q = args.q?.toLowerCase().trim();
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
           ils.samples   AS internal_samples,
           rp.last_price::float AS last_price,
           rp.last_price_at AS last_price_at,
           rp.last_price_source AS last_price_source,
           rec.recent AS recent_prices
    FROM ref_prices rp
    LEFT JOIN internal_sales ils
      ON ils.canon = UPPER(REGEXP_REPLACE(
                       REGEXP_REPLACE(COALESCE(rp.part_number, ''), ${PART_PREFIX_RE}, '', 'i'),
                       '[[:space:]]+', '', 'g'
                     ))
    LEFT JOIN LATERAL (
      SELECT JSONB_AGG(
               JSONB_BUILD_OBJECT('ts', e.created_at, 'price', e.price::float)
               ORDER BY e.created_at
             ) AS recent
      FROM (
        SELECT created_at, price FROM ref_price_events
        WHERE ref_price_id = rp.id
        ORDER BY created_at DESC LIMIT 12
      ) e
    ) rec ON TRUE
    WHERE (${args.category ?? null}::text IS NULL OR rp.category = ${args.category ?? null})
      AND (
        ${q ?? null}::text IS NULL
        OR LOWER(rp.label) LIKE '%' || ${q ?? ''} || '%'
        OR LOWER(COALESCE(rp.part_number,'')) LIKE '%' || ${q ?? ''} || '%'
      )
    ORDER BY rp.updated_at DESC
    LIMIT ${limit}
  `;
  const margin = await getWorkspaceSetting(sql, 'target_margin', 0.30);
  return rows.map(r => formatRefPrice(r, margin));
}

export async function callGetMarketValue(
  sql: postgres.Sql,
  args: { id?: string; partNumber?: string },
) {
  if (!args.id && !args.partNumber) throw new Error('id or partNumber required');
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
           ils.samples   AS internal_samples,
           rp.last_price::float AS last_price,
           rp.last_price_at AS last_price_at,
           rp.last_price_source AS last_price_source,
           rec.recent AS recent_prices
    FROM ref_prices rp
    LEFT JOIN internal_sales ils
      ON ils.canon = UPPER(REGEXP_REPLACE(
                       REGEXP_REPLACE(COALESCE(rp.part_number, ''), ${PART_PREFIX_RE}, '', 'i'),
                       '[[:space:]]+', '', 'g'
                     ))
    LEFT JOIN LATERAL (
      SELECT JSONB_AGG(
               JSONB_BUILD_OBJECT('ts', e.created_at, 'price', e.price::float)
               ORDER BY e.created_at
             ) AS recent
      FROM (
        SELECT created_at, price FROM ref_price_events
        WHERE ref_price_id = rp.id
        ORDER BY created_at DESC LIMIT 12
      ) e
    ) rec ON TRUE
    WHERE (${args.id ?? null}::text IS NOT NULL AND rp.id::text = ${args.id ?? null})
       OR (${args.partNumber ?? null}::text IS NOT NULL
           AND LOWER(COALESCE(rp.part_number, '')) = LOWER(${args.partNumber ?? ''}))
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const margin = await getWorkspaceSetting(sql, 'target_margin', 0.30);
  return formatRefPrice(rows[0], margin);
}
