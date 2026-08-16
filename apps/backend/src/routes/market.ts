import { Hono } from 'hono';
import { getDb } from '../db';
import { getWorkspaceSetting } from '../lib/settings';
import { formatRefPrice, marketValueSelect } from '../lib/market';
import { applyMarketWrites, type WriteValue } from '../lib/marketWrite';
import { appendPriceEvent } from '../lib/refPriceEvents';
import { canonPartCol, canonPartNumberJs } from '../lib/part-number';
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
  // The -asc/-desc / -high/-low pairs back the clickable column headers on the
  // desktop table; the un-suffixed values are the curated dropdown sorts.
  const sortParam = c.req.query('sort');
  const orderBy =
    sortParam === 'sell-high' ? sql`rp.avg_sell DESC NULLS LAST`
    : sortParam === 'rising'  ? sql`rp.trend DESC NULLS LAST`
    : sortParam === 'falling' ? sql`rp.trend ASC NULLS LAST`
    : sortParam === 'samples' ? sql`rp.samples DESC NULLS LAST`
    : sortParam === 'label-asc'  ? sql`LOWER(rp.label) ASC`
    : sortParam === 'label-desc' ? sql`LOWER(rp.label) DESC`
    : sortParam === 'part-asc'  ? sql`LOWER(rp.part_number) ASC NULLS LAST`
    : sortParam === 'part-desc' ? sql`LOWER(rp.part_number) DESC NULLS LAST`
    : sortParam === 'lastsell-high' ? sql`rp.last_price DESC NULLS LAST`
    : sortParam === 'lastsell-low'  ? sql`rp.last_price ASC NULLS LAST`
    // maxBuy = COALESCE(last_price, avg_sell) × (1 - margin); the constant
    // factor doesn't change the order, so sort on the basis directly.
    : sortParam === 'maxbuy-high' ? sql`COALESCE(rp.last_price, rp.avg_sell) DESC NULLS LAST`
    : sortParam === 'maxbuy-low'  ? sql`COALESCE(rp.last_price, rp.avg_sell) ASC NULLS LAST`
    : sortParam === 'paid-high' ? sql`rp.target DESC NULLS LAST`
    : sortParam === 'paid-low'  ? sql`rp.target ASC NULLS LAST`
    : sortParam === 'oldest' ? sql`rp.updated_at ASC`
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

// Recorded value for a known set of part numbers, in one round trip.
//
// The PO screens need this: a purchaser typing a part number at intake wants to
// see what it sells for and what the recorded max buy is BEFORE committing to
// the cost. Doing that through GET / would mean one substring search per line
// and a client-side exact match (which is what DesktopInventoryEdit does today,
// and which returns the wrong row whenever the PN is a prefix of another).
//
// POST, not GET: a 50-line PO's part numbers overflow a sane query string, and
// they would land in every access log along the way.
const LOOKUP_MAX = 100;

market.post('/lookup', async (c) => {
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as
    | { partNumbers?: unknown }
    | null;
  const raw = Array.isArray(body?.partNumbers) ? body!.partNumbers : null;
  if (!raw) return c.json({ error: 'partNumbers must be an array' }, 400);
  if (raw.length > LOOKUP_MAX) {
    return c.json({ error: `at most ${LOOKUP_MAX} part numbers per lookup` }, 413);
  }

  // Canonicalised here so the caller can key its own map and get a hit: the
  // rule is @recycle-erp/shared's canonicalPartNumber, which is the same
  // function the frontend canonicalised the request with.
  const canon = [...new Set(
    raw.filter((p): p is string => typeof p === 'string')
      .map(p => canonPartNumberJs(p))
      .filter(Boolean),
  )];
  const TARGET_MARGIN = await getWorkspaceSetting(sql, 'target_margin', 0.30);
  if (canon.length === 0) return c.json({ targetMargin: TARGET_MARGIN, items: {} });

  const rows = await marketValueSelect(
    sql,
    sql`${canonPartCol(sql, sql`rp.part_number`)} = ANY(${canon})`,
    sql``,
    sql`${canonPartCol(sql, sql`l.part_number`)} = ANY(${canon})`,
  );

  // Two ref_prices rows can canonicalise to the same key (the column has no
  // unique constraint). Keep the freshest reading rather than an arbitrary one.
  const items: Record<string, ReturnType<typeof formatRefPrice>> = {};
  const freshness = new Map<string, number>();
  for (const r of rows) {
    const key = canonPartNumberJs(r.part_number ?? '');
    if (!key) continue;
    const at = r.last_price_at ? new Date(r.last_price_at).getTime() : 0;
    if (!(key in items) || at > (freshness.get(key) ?? -1)) {
      items[key] = formatRefPrice(r, TARGET_MARGIN);
      freshness.set(key, at);
    }
  }
  return c.json({ targetMargin: TARGET_MARGIN, items });
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
