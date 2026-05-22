import type postgres from 'postgres';
import { formatRefPrice, type MarketValueRow } from '../../lib/market';
import { getWorkspaceSetting } from '../../lib/settings';

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
    description: 'Fetch one market-value record by id or partNumber.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        partNumber: { type: 'string' },
      },
      oneOf: [{ required: ['id'] }, { required: ['partNumber'] }],
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
    SELECT id, category, brand, capacity, type, classification, rank, speed,
           interface, form_factor, description, part_number, label, sub_label,
           target::float AS target, low_price::float AS low_price,
           high_price::float AS high_price, avg_sell::float AS avg_sell,
           trend, samples, source, stock, demand, history, updated_at,
           health::float AS health, rpm
    FROM ref_prices
    WHERE (${args.category ?? null}::text IS NULL OR category = ${args.category ?? null})
      AND (
        ${q ?? null}::text IS NULL
        OR LOWER(label) LIKE '%' || ${q ?? ''} || '%'
        OR LOWER(COALESCE(part_number,'')) LIKE '%' || ${q ?? ''} || '%'
      )
    ORDER BY updated_at DESC
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
    SELECT id, category, brand, capacity, type, classification, rank, speed,
           interface, form_factor, description, part_number, label, sub_label,
           target::float AS target, low_price::float AS low_price,
           high_price::float AS high_price, avg_sell::float AS avg_sell,
           trend, samples, source, stock, demand, history, updated_at,
           health::float AS health, rpm
    FROM ref_prices
    WHERE (${args.id ?? null}::text IS NOT NULL AND id::text = ${args.id ?? null})
       OR (${args.partNumber ?? null}::text IS NOT NULL
           AND LOWER(COALESCE(part_number, '')) = LOWER(${args.partNumber ?? ''}))
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const margin = await getWorkspaceSetting(sql, 'target_margin', 0.30);
  return formatRefPrice(rows[0], margin);
}
