import { Hono } from 'hono';
import { getDb } from '../db';
import { getWorkspaceSetting } from '../lib/settings';
import { formatRefPrice, marketValueSelect, maxBuyFor } from '../lib/market';
import { applyMarketWrites } from '../lib/marketWrite';
import { appendPriceEvent, appendPriceEvents } from '../lib/refPriceEvents';
import { escapeLike } from '../lib/pagination';
import { canonPartCol, canonPartNumberJs } from '../lib/part-number';
import { bearerGuard } from '../oauth/guard';
import {
  readPriceSheetRows, PriceColumnsNotFoundError, type SheetPriceRow,
} from '../services/sellOrderPriceImport';
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

// Part numbers already on record, for the typeahead on the capture screens.
//
// POST /lookup answers "what is this part worth" for an EXACT canonical match,
// which is no help to someone half-way through typing: a spacing variant or a
// transposed character reads as a part nobody has ever seen, and autoTrackParts
// then writes that variant into ref_prices on submit. Offering the existing
// spellings while the field is still open is what stops the drift.
//
// Both catalogues count as "existing". ref_prices is very nearly a superset
// (autoTrackParts adds every purchased part), but order_lines still carries the
// rows that pre-date auto-tracking.
const SUGGEST_LIMIT = 12;
const SUGGEST_MIN = 2;
// Above a PO line's 120 so a longer ref_prices entry can still be asked for,
// but a ceiling: each asked string is canonicalised here and compared against
// every row's REGEXP_REPLACE in SQL.
const PART_NUMBER_ASK_MAX = 256;

market.get('/parts', async (c) => {
  const sql = getDb(c.env);
  // Gated on the canonical form, then escaped — never the other way round.
  // escapeLike doubles the length of a lone metacharacter, so escaping first
  // would let '?q=_' pass a check that exists to require two typed characters,
  // and the client's own gate (suggestQuery) measures the unescaped form.
  const typed = c.req.query('q') ?? '';
  if (typed.length > PART_NUMBER_ASK_MAX) return c.json({ items: [] });
  const canon = canonPartNumberJs(typed);
  if (canon.length < SUGGEST_MIN) return c.json({ items: [] });
  // The canonical form leaves LIKE metacharacters alone, so a typed '%' would
  // otherwise match the whole table.
  const q = escapeLike(canon);

  const canonRef = canonPartCol(sql, sql`rp.part_number`);
  const canonLine = canonPartCol(sql, sql`l.part_number`);

  // Three levels, because DISTINCT ON must lead its own ORDER BY: the union
  // gathers, the middle picks one row per part (ref_prices first — it is the
  // side with a real label, and two of its rows can share a canonical key), and
  // only the outer SELECT is free to rank.
  const rows = await sql<{ pn: string; label: string | null; category: string | null }[]>`
    SELECT pn, label, category
      FROM (
        SELECT DISTINCT ON (canon) canon, pn, label, category
          FROM (
            SELECT ${canonRef} AS canon, rp.part_number AS pn,
                   NULLIF(rp.label, '') AS label, rp.category AS category, 0 AS src
              FROM ref_prices rp
             WHERE rp.part_number IS NOT NULL
               AND ${canonRef} LIKE '%' || ${q} || '%'
            UNION ALL
            SELECT ${canonLine}, l.part_number,
                   COALESCE(
                     NULLIF(CONCAT_WS(' ', l.brand, l.capacity, l.generation), ''),
                     NULLIF(l.description, '')
                   ),
                   l.category, 1
              FROM order_lines l
             WHERE l.part_number IS NOT NULL
               AND ${canonLine} LIKE '%' || ${q} || '%'
          ) u
         WHERE canon <> ''
         ORDER BY canon, src, pn
      ) d
     ORDER BY (canon LIKE ${q} || '%') DESC, LENGTH(pn), pn
     LIMIT ${SUGGEST_LIMIT}
  `;

  return c.json({
    items: rows.map(r => ({ partNumber: r.pn, label: r.label, category: r.category })),
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

  // Answers are keyed by the exact strings the caller asked with, not by this
  // server's canon: the Worker and Railway deploy independently and this is a
  // PWA whose tabs live for days, so a client bundled with an older rule asks
  // under a key a newer rule would never emit. Echoing what was asked survives
  // any rule change; keying by the server's canon blanked every price on an
  // open tab the day the rule widened.
  const asked = new Map<string, string[]>();
  for (const p of raw) {
    if (typeof p !== 'string' || p.length > PART_NUMBER_ASK_MAX) continue;
    const key = canonPartNumberJs(p);
    if (!key) continue;
    const under = asked.get(key);
    if (under) under.push(p); else asked.set(key, [p]);
  }
  const canon = [...asked.keys()];
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
    const under = asked.get(key);
    if (!under) continue;
    const at = r.last_price_at ? new Date(r.last_price_at).getTime() : 0;
    if (at <= (freshness.get(key) ?? -1)) continue;
    freshness.set(key, at);
    const value = formatRefPrice(r, TARGET_MARGIN);
    for (const spelling of under) items[spelling] = value;
  }
  return c.json({ targetMargin: TARGET_MARGIN, items });
});

// Part number → chip #, learnt from past PO lines, so the capture screens can
// fill a blank chip # instead of it being retyped on every line. Workspace-wide
// on purpose: a chip marking is a fact about the part, not about anyone's order.
// Votes are per PO — one lot split across many rows would otherwise outvote
// every other PO — and a tie goes to the most recent line. Keyed by the asked
// spelling for the same deploy-skew reason as /lookup.
market.post('/chips', async (c) => {
  const sql = getDb(c.env);
  const body = (await c.req.json().catch(() => null)) as
    | { partNumbers?: unknown }
    | null;
  const raw = Array.isArray(body?.partNumbers) ? body!.partNumbers : null;
  if (!raw) return c.json({ error: 'partNumbers must be an array' }, 400);
  if (raw.length > LOOKUP_MAX) {
    return c.json({ error: `at most ${LOOKUP_MAX} part numbers per lookup` }, 413);
  }

  const asked = new Map<string, string[]>();
  for (const p of raw) {
    if (typeof p !== 'string' || p.length > PART_NUMBER_ASK_MAX) continue;
    const key = canonPartNumberJs(p);
    if (!key) continue;
    const under = asked.get(key);
    if (under) under.push(p); else asked.set(key, [p]);
  }
  const canon = [...asked.keys()];
  if (canon.length === 0) return c.json({ items: {} });

  const canonCol = canonPartCol(sql, sql`l.part_number`);
  const rows = await sql<{ canon: string; chip: string }[]>`
    SELECT DISTINCT ON (canon) canon, chip FROM (
      SELECT ${canonCol} AS canon, BTRIM(l.chip_number) AS chip,
             COUNT(DISTINCT l.order_id) AS n, MAX(l.created_at) AS last
        FROM order_lines l
        JOIN orders o ON o.id = l.order_id
       WHERE ${canonCol} = ANY(${canon})
         AND BTRIM(COALESCE(l.chip_number, '')) <> ''
         AND o.archived_at IS NULL
       GROUP BY 1, 2
    ) t
    ORDER BY canon, n DESC, last DESC
  `;

  const items: Record<string, string> = {};
  for (const r of rows) {
    const under = asked.get(canonPartNumberJs(r.canon));
    if (!under) continue;
    for (const spelling of under) items[spelling] = r.chip;
  }
  return c.json({ items });
});

// Price-list import from the Market page, step 1 of 2: read a sheet's Part
// Number and Unit Price columns — every other column is ignored — and report
// what each row would do to the board. Writes nothing. The file is parsed and
// dropped, never stored, so its cap is its own rather than the attachment
// limits in getUploadLimits.
const PRICE_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
// Prices one import writes, and so how many matches a preview may offer: a
// preview the apply would refuse is one the manager can do nothing with.
const PRICE_IMPORT_MAX_ROWS = 5000;
const PRICE_IMPORT_MAX_PRICE = 10_000_000;

type ImportRowStatus =
  | 'matched' | 'not-on-market' | 'no-price' | 'invalid-price' | 'not-usd' | 'duplicate';

type ImportRow = {
  sheet: string;
  rowNumber: number;
  rawPart: string;
  rawPrice: string;
  price: number | null;
  status: ImportRowStatus;
  refPriceId?: string;
  partNumber?: string | null;
  label?: string;
  oldPrice?: number | null;
  oldMaxBuy?: number | null;
  newMaxBuy?: number | null;
};

type ImportRef = {
  canon: string;
  id: string;
  part_number: string | null;
  label: string;
  last_price: number | null;
  avg_sell: number | null;
};

market.post('/price-import/preview', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);

  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'multipart/form-data required' }, 400);
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: 'file is required' }, 400);
  if (file.size > PRICE_IMPORT_MAX_BYTES) {
    return c.json({ error: `file too large (max ${PRICE_IMPORT_MAX_BYTES} bytes)` }, 413);
  }

  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(await file.arrayBuffer());
  } catch {
    return c.json({ error: 'not a valid .xlsx file' }, 400);
  }
  let sheetRows: SheetPriceRow[];
  try {
    sheetRows = readPriceSheetRows(wb);
  } catch (e) {
    if (e instanceof PriceColumnsNotFoundError) {
      return c.json({ error: e.message, code: 'columns-not-found' }, 400);
    }
    throw e;
  }

  const sql = getDb(c.env);
  // Junk like '-' canonicalises to '', and part_number is nullable — an empty
  // key would match every row that has none.
  const canons = [...new Set(sheetRows.map(r => r.canonPart).filter(Boolean))];
  const canonCol = canonPartCol(sql, sql`part_number`);
  // Two rows can share a canonical part number; the most recently maintained
  // one is the one written, as for the scraper push.
  const [refs, targetMargin] = await Promise.all([
    canons.length === 0 ? Promise.resolve([] as ImportRef[]) : sql<ImportRef[]>`
      SELECT DISTINCT ON (canon) ${canonCol} AS canon, id, part_number, label,
             last_price::float AS last_price, avg_sell::float AS avg_sell
        FROM ref_prices
       WHERE ${canonCol} = ANY(${canons}::text[])
       ORDER BY canon, updated_at DESC, id
    `,
    getWorkspaceSetting(sql, 'target_margin', 0.30),
  ]);
  const refByCanon = new Map(refs.map(r => [r.canon, r]));

  const rows: ImportRow[] = [];
  // A later valid price for the same part demotes the earlier row, across tabs
  // too — price lists get corrected by re-listing the part further down.
  const winnerByRef = new Map<string, ImportRow>();
  for (const s of sheetRows) {
    const row: ImportRow = {
      sheet: s.sheet, rowNumber: s.rowNumber, rawPart: s.rawPart,
      rawPrice: s.rawPrice, price: s.price, status: 'not-on-market',
    };
    const ref = refByCanon.get(s.canonPart);
    if (!ref) {
      row.status = 'not-on-market';
    } else if (s.priceKind === 'empty' || s.price === 0) {
      // A 0 on a price list means "not buying", and as a price it would zero
      // the part's max buy.
      row.status = 'no-price';
    } else if (s.priceKind === 'invalid') {
      row.status = 'invalid-price';
    } else if (s.currency !== null) {
      row.status = 'not-usd';
    } else {
      row.status = 'matched';
      row.refPriceId = ref.id;
      row.partNumber = ref.part_number;
      row.label = ref.label;
      row.oldPrice = ref.last_price;
      row.oldMaxBuy = maxBuyFor(ref.last_price ?? ref.avg_sell, targetMargin);
      row.newMaxBuy = maxBuyFor(s.price, targetMargin);
      const prior = winnerByRef.get(ref.id);
      if (prior) prior.status = 'duplicate';
      winnerByRef.set(ref.id, row);
    }
    rows.push(row);
  }

  const summary = { matched: 0, notOnMarket: 0, noPrice: 0, invalid: 0, notUsd: 0, duplicate: 0 };
  for (const r of rows) {
    if (r.status === 'matched') summary.matched++;
    else if (r.status === 'not-on-market') summary.notOnMarket++;
    else if (r.status === 'no-price') summary.noPrice++;
    else if (r.status === 'invalid-price') summary.invalid++;
    else if (r.status === 'not-usd') summary.notUsd++;
    else summary.duplicate++;
  }
  if (summary.matched > PRICE_IMPORT_MAX_ROWS) {
    return c.json({
      error: `at most ${PRICE_IMPORT_MAX_ROWS} prices per import`, code: 'too-many-prices', max: PRICE_IMPORT_MAX_ROWS,
    }, 413);
  }
  return c.json({ targetMargin, rows, summary });
});

// Step 2: write the prices the manager saw in the preview, each as a market
// data point. A price that didn't change is written too — the list confirms it
// is current, which is what clears the stale flag.
market.post('/price-import/apply', async (c) => {
  const user = c.var.user;
  if (user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);

  const body = (await c.req.json().catch(() => null)) as null | { fileName?: unknown; prices?: unknown };
  const raw = Array.isArray(body?.prices) ? body!.prices : null;
  if (!raw || raw.length === 0) return c.json({ error: 'prices must be a non-empty array' }, 400);
  if (raw.length > PRICE_IMPORT_MAX_ROWS) {
    return c.json({ error: `at most ${PRICE_IMPORT_MAX_ROWS} prices per import` }, 413);
  }
  const priceById = new Map<string, number>();
  for (const item of raw) {
    const { id, price } = (item ?? {}) as { id?: unknown; price?: unknown };
    if (typeof id !== 'string' || id === '') return c.json({ error: 'each price needs an id' }, 400);
    if (typeof price !== 'number' || !Number.isFinite(price)
        || price <= 0 || price > PRICE_IMPORT_MAX_PRICE) {
      return c.json({ error: 'invalid_price' }, 400);
    }
    if (priceById.has(id)) return c.json({ error: 'duplicate id' }, 400);
    priceById.set(id, price);
  }
  const fileName = typeof body?.fileName === 'string'
    ? body.fileName.trim().slice(0, 280) || null
    : null;

  const ids = [...priceById.keys()];
  const sql = getDb(c.env);
  const updated = await sql.begin(async (tx) => {
    // Every row locked up front, in one order, before the write.
    const found = await tx<{ id: string }[]>`
      SELECT id FROM ref_prices WHERE id = ANY(${ids}::text[]) ORDER BY id FOR NO KEY UPDATE
    `;
    return appendPriceEvents(tx, new Map(found.map(({ id }) => [id, priceById.get(id)!])), {
      source: `import:${user.email}`, note: fileName, actorUserId: user.id,
    });
  });
  return c.json({ updated, notFound: ids.length - updated });
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
  // Elements stay unknown: applyMarketWrites shape-checks each one.
  const body = (await c.req.json().catch(() => null)) as null | { values?: unknown };
  if (!body || !Array.isArray(body.values)) return c.json({ error: 'invalid_request' }, 400);
  if (body.values.length > 500) {
    return c.json({ error: 'payload_too_large', hint: 'paginate to <=500 rows' }, 413);
  }
  const sql = getDb(c.env);
  const result = await applyMarketWrites(sql, body.values);
  return c.json(result);
});

export default market;
