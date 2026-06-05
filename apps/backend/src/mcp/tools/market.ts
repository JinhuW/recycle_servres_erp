import type postgres from 'postgres';
import { formatRefPrice, type MarketValueRow } from '../../lib/market';
import { getWorkspaceSetting } from '../../lib/settings';
import { PART_PREFIX_RE } from '../../lib/part-number';
import { appendPriceEvent } from '../../lib/refPriceEvents';

export const TOOL_DEFS = [
  {
    name: 'list_market_values',
    description:
      'Read-only. List reference-price ("market value") records for products the workspace buys and resells, ' +
      'newest-updated first. Use this to browse or search prices; call get_market_value when you already know ' +
      'a specific product. Each record includes: partNumber and a human label; lastPrice (the current reference ' +
      'price, the basis for buying decisions) with lastPriceAt and lastPriceSource; avgSell / low / high / target ' +
      '(historical sell statistics); trend (recent change in avgSell); maxBuy (recommended maximum purchase price = ' +
      'basis x (1 - target margin), where basis is lastPrice or, if unset, avgSell); samples and source (how the ' +
      'stats were derived); internalSales (the team\'s own last-30-day average sell price and sample count); and ' +
      'recentPrices (up to 12 recent price events). All money values are in the workspace base currency (USD). ' +
      'Requires the market:read scope.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'optional exact category filter (e.g. "SSD", "RAM")' },
        q: { type: 'string', description: 'optional case-insensitive substring match against label and part_number' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'max records to return (1-200, default 50)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_market_value',
    description:
      'Read-only. Fetch a single reference-price record by id or by exact part number. Provide exactly one of ' +
      'id or partNumber (supplying neither is an error; partNumber match is case-insensitive). Returns the same ' +
      'record shape as list_market_values (lastPrice, avgSell, low/high/target, trend, maxBuy, samples, source, ' +
      'internalSales, recentPrices; money in USD), or null when nothing matches. Requires the market:read scope.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ref_prices row id; provide this OR partNumber, not both' },
        partNumber: { type: 'string', description: 'exact product part number (case-insensitive); provide this OR id' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'set_market_price',
    description:
      'Write. Set the reference (last) price for the product whose part number matches partNumber. This is the ' +
      'authoritative price that drives buying decisions and the maxBuy recommendation, so prefer reading the ' +
      'current value with get_market_value first. The match is case-insensitive; if several rows share the part ' +
      'number the most recently updated one is used. Records a price event (attributed to the calling MCP client) ' +
      'and updates lastPrice/lastPriceAt/lastPriceSource. price is in the workspace base currency (USD) and must ' +
      'be >= 0. On success returns { id, lastPrice, lastPriceAt }. Errors: "not_found" when no product matches the ' +
      'part number, "invalid_price" for a negative or non-numeric price. Requires the market:write scope (a ' +
      'market:read-only token is rejected with insufficient_scope).',
    inputSchema: {
      type: 'object',
      properties: {
        partNumber: { type: 'string', description: 'exact part number of the product to price (case-insensitive)' },
        price: { type: 'number', minimum: 0, description: 'new reference price in USD; must be >= 0' },
        note: { type: 'string', maxLength: 280, description: 'optional free-text note (<=280 chars) stored on the price event' },
      },
      required: ['partNumber', 'price'],
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

// Write path for the market:write-scoped MCP tool. Resolves the ref price by
// part number (same LIMIT 1 selector idiom as the scraper push), then routes
// through appendPriceEvent so last_price* + the event row stay consistent —
// the single write path shared with the Market page's manual entry.
export async function callSetMarketPrice(
  sql: postgres.Sql,
  args: { partNumber?: string; price?: number; note?: string },
  ctx: { source: string; actorUserId: string | null },
) {
  const partNumber = (args.partNumber ?? '').trim();
  if (!partNumber) throw new Error('partNumber required');
  const price = typeof args.price === 'number' ? args.price : NaN;
  if (!Number.isFinite(price) || price < 0) throw new Error('invalid_price');
  const note = typeof args.note === 'string' ? args.note : null;
  if (note !== null && note.length > 280) throw new Error('note_too_long');

  const ev = await sql.begin(async (tx) => {
    const row = (await tx<{ id: string }[]>`
      SELECT id FROM ref_prices
      WHERE LOWER(COALESCE(part_number, '')) = LOWER(${partNumber})
      LIMIT 1
    `)[0];
    if (!row) return null;
    return appendPriceEvent(tx, {
      refPriceId: row.id,
      price,
      source: ctx.source,
      note,
      actorUserId: ctx.actorUserId,
    });
  });
  if (!ev) throw new Error('not_found');
  return { id: ev.id, lastPrice: ev.price, lastPriceAt: ev.createdAt.toISOString() };
}
