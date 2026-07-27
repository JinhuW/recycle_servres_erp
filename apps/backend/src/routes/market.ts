import { Hono } from 'hono';
import { getDb } from '../db';
import { getWorkspaceSetting } from '../lib/settings';
import { formatRefPrice, marketValueSelect } from '../lib/market';
import { applyMarketWrites, type WriteValue } from '../lib/marketWrite';
import { appendPriceEvent } from '../lib/refPriceEvents';
import { bearerGuard } from '../oauth/guard';
import type { Env, User } from '../types';

const market = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// Reference prices for the Market Value screen. Search + category filter +
// stale filter + server-side sort, paginated 100 rows at a time so the desktop
// list can scroll past the first page. maxBuy = avgSell × (1 - 30% margin).
const PAGE_SIZE = 100;
// Mirrors the frontend staleness rule (marketStaleness.ts): a recorded price
// older than STALE_DAYS full days — or never recorded — counts as stale.
const STALE_DAYS = 5;

market.get('/', async (c) => {
  const sql = getDb(c.env);
  const category = c.req.query('category');
  const search = c.req.query('q')?.toLowerCase().trim();
  const staleOnly = c.req.query('staleOnly') === '1';
  const offset = Math.max(0, Number.parseInt(c.req.query('offset') ?? '0', 10) || 0);

  // Whitelisted sort → fragment; the default mirrors the old updated_at order.
  // rp.id is appended as a stable tiebreaker so OFFSET paging is deterministic.
  const sortParam = c.req.query('sort');
  const orderBy =
    sortParam === 'sell-high' ? sql`rp.avg_sell DESC NULLS LAST`
    : sortParam === 'rising'  ? sql`rp.trend DESC NULLS LAST`
    : sortParam === 'falling' ? sql`rp.trend ASC NULLS LAST`
    : sortParam === 'samples' ? sql`rp.samples DESC NULLS LAST`
    : sql`rp.updated_at DESC`;

  // Filters shared by the page query and the count, so `total` always reflects
  // the full filtered set even on a page that returns no rows (offset past end).
  const where = sql`
    (${category ?? null}::text IS NULL OR rp.category = ${category ?? null})
    AND (
      ${search ?? null}::text IS NULL
      OR LOWER(rp.label) LIKE '%' || ${search ?? ''} || '%'
      OR LOWER(COALESCE(rp.part_number,'')) LIKE '%' || ${search ?? ''} || '%'
    )
    AND (
      ${!staleOnly}
      OR rp.last_price_at IS NULL
      OR rp.last_price_at < NOW() - ${STALE_DAYS + 1} * INTERVAL '1 day'
    )
  `;

  // `internal_sales` (inside marketValueSelect) aggregates the team's last-30d
  // projected sell prices from PO order_lines, keyed by canonical part_number.
  // The page query, the `total` count, and the target-margin lookup are
  // independent, so fire them together.
  const [rows, [{ total }], TARGET_MARGIN] = await Promise.all([
    marketValueSelect(sql, where, sql`ORDER BY ${orderBy}, rp.id DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`),
    sql<{ total: number }[]>`SELECT COUNT(*)::int AS total FROM ref_prices rp WHERE ${where}`,
    getWorkspaceSetting(sql, 'target_margin', 0.30),
  ]);

  return c.json({
    targetMargin: TARGET_MARGIN,
    total,
    items: rows.map(r => formatRefPrice(r, TARGET_MARGIN)),
  });
});

// Manual price entry from the Market page. Manager-only; auth + CSRF are
// handled by the mounted middleware chain. Records one row in
// ref_price_events and bumps ref_prices.last_price* via appendPriceEvent.
market.post('/:id/manual-price', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);

  const body = (await c.req.json().catch(() => null)) as null | { price?: unknown; note?: unknown };
  const price = typeof body?.price === 'number' ? body.price : NaN;
  if (!Number.isFinite(price) || price < 0) {
    return c.json({ error: 'invalid_price' }, 400);
  }
  const note = typeof body?.note === 'string' ? body.note : null;
  if (note !== null && note.length > 280) {
    return c.json({ error: 'note_too_long' }, 400);
  }

  const id = c.req.param('id');
  const sql = getDb(c.env);
  const ev = await sql.begin(async (tx) => {
    const exists = (await tx`SELECT 1 FROM ref_prices WHERE id = ${id}`)[0];
    if (!exists) return null;
    return appendPriceEvent(tx, {
      refPriceId: id,
      price,
      source: `manual:${c.var.user.email}`,
      note,
      actorUserId: c.var.user.id,
    });
  });
  if (!ev) return c.json({ error: 'not_found' }, 404);
  return c.json({ lastPrice: ev.price, lastPriceAt: ev.createdAt.toISOString() });
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
