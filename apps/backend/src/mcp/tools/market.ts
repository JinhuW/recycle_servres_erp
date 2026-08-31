import type postgres from 'postgres';
import { formatRefPrice, marketValueSelect } from '../../lib/market';
import { getWorkspaceSetting } from '../../lib/settings';
import { appendPriceEvent } from '../../lib/refPriceEvents';
import { canonPartArg, canonPartCol } from '../../lib/part-number';

// Annotations are advisory, but ChatGPT applies the MCP defaults when they're
// absent — readOnlyHint false, destructiveHint true, openWorldHint true — so
// every tool showed up in its connector panel as a destructive open-world
// write and the read tools were gated behind elevated-risk confirmations.
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

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
    annotations: { title: 'List market values', ...READ_ONLY },
  },
  {
    name: 'get_market_value',
    description:
      'Read-only. Fetch a single reference-price record by id or by exact part number. Provide exactly one of ' +
      'id or partNumber (supplying neither is an error; partNumber matches on the canonical form, so case, spaces, hyphens and underscores do not matter). Returns the same ' +
      'record shape as list_market_values (lastPrice, avgSell, low/high/target, trend, maxBuy, samples, source, ' +
      'internalSales, recentPrices; money in USD), or null when nothing matches. Requires the market:read scope.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ref_prices row id; provide this OR partNumber, not both' },
        partNumber: { type: 'string', description: 'product part number; matched ignoring case, spaces, hyphens and underscores. Provide this OR id' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Get market value', ...READ_ONLY },
  },
  {
    name: 'set_market_price',
    description:
      'Write. Set the reference (last) price for the product whose part number matches partNumber. This is the ' +
      'authoritative price that drives buying decisions and the maxBuy recommendation, so prefer reading the ' +
      'current value with get_market_value first. The match is case-insensitive; if several rows share the part ' +
      'number the most recently updated one is used. Records a price event (attributed to the calling MCP client) ' +
      'and updates lastPrice/lastPriceAt/lastPriceSource. price is in the workspace base currency (USD) and must ' +
      'be >= 0. On success returns { id, lastPrice, lastPriceAt }. A failure comes back as a normal tool result ' +
      'with isError set and a message explaining it — "not_found" means no product carries that part number, so ' +
      'look the product up with list_market_values and retry with the exact part number rather than treating the ' +
      'tool as unavailable; "invalid_price" means the price was negative or non-numeric. Requires the ' +
      'market:write scope (a market:read-only token is rejected with insufficient_scope).',
    inputSchema: {
      type: 'object',
      properties: {
        partNumber: { type: 'string', description: 'part number of the product to price; matched ignoring case, spaces, hyphens and underscores' },
        price: { type: 'number', minimum: 0, description: 'new reference price in USD; must be >= 0' },
        note: { type: 'string', maxLength: 280, description: 'optional free-text note (<=280 chars) stored on the price event' },
      },
      required: ['partNumber', 'price'],
      additionalProperties: false,
    },
    // Re-pricing the same part twice with the same price is a no-op beyond the
    // event trail, and nothing is ever deleted — so idempotent, not destructive.
    annotations: {
      title: 'Set market price',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const;

export async function callListMarketValues(
  sql: postgres.Sql,
  args: { category?: string; q?: string; limit?: number },
) {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const q = args.q?.toLowerCase().trim();
  const where = sql`
    (${args.category ?? null}::text IS NULL OR rp.category = ${args.category ?? null})
    AND (
      ${q ?? null}::text IS NULL
      OR LOWER(rp.label) LIKE '%' || ${q ?? ''} || '%'
      OR LOWER(COALESCE(rp.part_number,'')) LIKE '%' || ${q ?? ''} || '%'
    )
  `;
  const [rows, margin] = await Promise.all([
    marketValueSelect(sql, where, sql`ORDER BY rp.updated_at DESC LIMIT ${limit}`),
    getWorkspaceSetting(sql, 'target_margin', 0.30),
  ]);
  return rows.map(r => formatRefPrice(r, margin));
}

export async function callGetMarketValue(
  sql: postgres.Sql,
  args: { id?: string; partNumber?: string },
) {
  if (!args.id && !args.partNumber) throw new Error('id or partNumber required');
  const where = sql`
    (${args.id ?? null}::text IS NOT NULL AND rp.id::text = ${args.id ?? null})
    OR (${args.partNumber ?? null}::text IS NOT NULL
        AND ${canonPartCol(sql, sql`rp.part_number`)} = ${canonPartArg(sql, args.partNumber ?? '')})
  `;
  const rows = await marketValueSelect(sql, where, sql`LIMIT 1`);
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
      WHERE ${canonPartCol(tx, tx`part_number`)} = ${canonPartArg(tx, partNumber)}
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
  // Naming the part back is what lets a client tell "I mistyped the part
  // number" apart from "the write endpoint is down".
  if (!ev) throw new Error(`not_found: no product carries part number "${partNumber}"`);
  return { id: ev.id, lastPrice: ev.price, lastPriceAt: ev.createdAt.toISOString() };
}
