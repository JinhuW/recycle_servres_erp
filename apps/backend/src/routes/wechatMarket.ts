import { Hono, type MiddlewareHandler } from 'hono';
import {
  isWechatRowKind,
  type WechatDay,
  type WechatDayPush,
  type WechatDaySummary,
  type WechatEvidence,
  type WechatHistoryDay,
  type WechatPoint,
  type WechatPrice,
  type WechatRow,
  type WechatRowKind,
} from '@recycle-erp/shared';
import { authMiddleware } from '../auth';
import { getDb } from '../db';
import { log } from '../lib/log';
import { requireManager } from '../lib/role';
import { isReportDate, parseDayPush, parsePointsPush, PushError } from '../lib/wechatMarket';
import { bearerGuard } from '../oauth/guard';
import type { Env, OAuthCtx, User } from '../types';

// ─── WeChat market ────────────────────────────────────────────────────────────
// memtrade (an outside tool on the office Mac) reads the team's WeChat trading
// groups and builds a daily memory-module report. It pushes each day here with
// a wechat:write service token: the day first, which replaces whatever was
// stored for it, then the evidence points in batches. Managers read it on
// Monitors ▸ WeChat. Self-applies its auth (oauthAdmin pattern): Bearer on
// /push/*, the session cookie and a manager gate on everything else.

type Vars = { user: User; oauthCtx: OAuthCtx };

const PUSH_PREFIX = '/api/wechat-market/push/';
const isPush = (path: string) => path.startsWith(PUSH_PREFIX);

const HISTORY_DAYS_MAX = 120;
const EVIDENCE_LIMIT = 100;

// The sub-app's context is a superset of each guard's; they only read and set
// their own variable.
const asVars = (mw: unknown) => mw as MiddlewareHandler<{ Bindings: Env; Variables: Vars }>;
const pushGuard = asVars(bearerGuard({ scopes: ['wechat:write'] }));

const wechat = new Hono<{ Bindings: Env; Variables: Vars }>()
  .use('*', (c, next) => (isPush(c.req.path) ? pushGuard(c, next) : asVars(authMiddleware)(c, next)))
  .use('*', (c, next) => (isPush(c.req.path) ? next() : asVars(requireManager)(c, next)));

function badDate(date: string) {
  return isReportDate(date) ? null : { error: 'invalid_date', detail: 'expected YYYY-MM-DD' };
}

// ── Push ──────────────────────────────────────────────────────────────────────

wechat.put('/push/days/:date', async (c) => {
  const date = c.req.param('date');
  const bad = badDate(date);
  if (bad) return c.json(bad, 400);
  let day: WechatDayPush;
  try {
    day = parseDayPush(await c.req.json().catch(() => null));
  } catch (err) {
    if (err instanceof PushError) return c.json({ error: 'invalid_request', detail: err.message }, 400);
    throw err;
  }
  const sql = getDb(c.env);
  const t = day.totals;
  await sql.begin(async (tx) => {
    // The cascade takes the old rows, groups and points with it: a redone day
    // can drop a line the first run had.
    await tx`DELETE FROM wechat_market_days WHERE report_date = ${date}`;
    await tx`
      INSERT INTO wechat_market_days (
        report_date, window_start, window_end, degraded, summary, warnings,
        messages, groups_total, groups_active, candidates, posts,
        buy_posts, sell_posts, buyers, sellers, point_count
      ) VALUES (
        ${date}, ${day.windowStart}, ${day.windowEnd}, ${day.degraded}, ${day.summary}, ${day.warnings},
        ${t.messages}, ${t.groupsTotal}, ${t.groupsActive}, ${t.candidates}, ${t.posts},
        ${t.buyPosts}, ${t.sellPosts}, ${t.buyers}, ${t.sellers}, ${day.pointCount}
      )
    `;
    if (day.rows.length) {
      // One JSON parameter, not one per value: a day runs to a thousand rows
      // of 25 columns, past Postgres's 65535 bind parameters.
      await tx`
        INSERT INTO wechat_market_rows (
          report_date, kind, row_key, brand, capacity_gb, speed, code, ddr, form_factor,
          ranks, part_numbers, signal,
          buy_posts, buy_senders, buy_groups, buy_exposures, buy_qty, buy_prices,
          sell_posts, sell_senders, sell_groups, sell_exposures, sell_qty, sell_prices
        )
        SELECT ${date}, r.kind, r.row_key, r.brand, r.capacity_gb, r.speed, r.code, r.ddr, r.form_factor,
               r.ranks, r.part_numbers, r.signal,
               (r.buy->>'posts')::int, (r.buy->>'senders')::int, (r.buy->>'groups')::int,
               (r.buy->>'exposures')::int, (r.buy->>'qty')::int, r.buy->'prices',
               (r.sell->>'posts')::int, (r.sell->>'senders')::int, (r.sell->>'groups')::int,
               (r.sell->>'exposures')::int, (r.sell->>'qty')::int, r.sell->'prices'
          FROM jsonb_to_recordset(${tx.json(day.rows.map((r) => ({
            kind: r.kind, row_key: r.key, brand: r.brand, capacity_gb: r.capacityGb, speed: r.speed,
            code: r.code, ddr: r.ddr, form_factor: r.formFactor, ranks: r.ranks,
            part_numbers: r.partNumbers, signal: r.signal, buy: r.buy, sell: r.sell,
          })) as never)}::jsonb)
            AS r(kind text, row_key text, brand text, capacity_gb int, speed int, code text, ddr text,
                 form_factor text, ranks text[], part_numbers text[], signal text, buy jsonb, sell jsonb)
      `;
    }
    if (day.groups.length) {
      await tx`
        INSERT INTO wechat_market_groups (report_date, group_id, name, messages, candidates, first_seen)
        SELECT ${date}, g.id, g.name, g.messages, g.candidates, g.first_seen
          FROM jsonb_to_recordset(${tx.json(day.groups.map((g) => ({
            id: g.id, name: g.name, messages: g.messages, candidates: g.candidates, first_seen: g.firstSeen,
          })) as never)}::jsonb)
            AS g(id text, name text, messages int, candidates int, first_seen timestamptz)
      `;
    }
  });
  log.info('wechat market day pushed', {
    module: 'wechatMarket', date, rows: day.rows.length, groups: day.groups.length,
    pointCount: day.pointCount, degraded: day.degraded, clientId: c.var.oauthCtx.clientId,
  });
  return c.json({ date, rows: day.rows.length, groups: day.groups.length });
});

wechat.post('/push/days/:date/points', async (c) => {
  const date = c.req.param('date');
  const bad = badDate(date);
  if (bad) return c.json(bad, 400);
  let points: WechatPoint[];
  try {
    points = parsePointsPush(await c.req.json().catch(() => null));
  } catch (err) {
    if (err instanceof PushError) return c.json({ error: 'invalid_request', detail: err.message }, 400);
    throw err;
  }
  const sql = getDb(c.env);
  const stored = await sql.begin(async (tx) => {
    // FOR SHARE: a re-push of the day deleting it under this batch would
    // otherwise surface as an FK violation instead of the 404 below.
    const [day] = await tx`SELECT 1 FROM wechat_market_days WHERE report_date = ${date} FOR SHARE`;
    if (!day) return null;
    if (points.length) {
      // A retried batch carries the same points; the first copy stands.
      await tx`
        INSERT INTO wechat_market_points (
          report_date, post_key, item_index, sender_id, sender_name, group_ids, first_at, last_at,
          messages, source, direction, brands, capacity_gb, speed, ddr, rank, form_factor,
          part_codes, date_code, condition, price, price_approx, currency, tax, qty, location,
          raw_line, row_keys
        )
        SELECT ${date}, p.post_key, p.item_index, p.sender_id, p.sender_name, p.group_ids, p.first_at, p.last_at,
               p.messages, p.source, p.direction, p.brands, p.capacity_gb, p.speed, p.ddr, p.rank, p.form_factor,
               p.part_codes, p.date_code, p.condition, p.price, p.price_approx, p.currency, p.tax, p.qty, p.location,
               p.raw_line, p.row_keys
          FROM jsonb_to_recordset(${tx.json(points.map((p) => ({
            post_key: p.postKey, item_index: p.itemIndex, sender_id: p.senderId, sender_name: p.senderName,
            group_ids: p.groupIds, first_at: p.firstAt, last_at: p.lastAt, messages: p.messages,
            source: p.source, direction: p.direction, brands: p.brands, capacity_gb: p.capacityGb,
            speed: p.speed, ddr: p.ddr, rank: p.rank, form_factor: p.formFactor, part_codes: p.partCodes,
            date_code: p.dateCode, condition: p.condition, price: p.price, price_approx: p.priceApprox,
            currency: p.currency, tax: p.tax, qty: p.qty, location: p.location, raw_line: p.rawLine,
            row_keys: p.rowKeys,
          })) as never)}::jsonb)
            AS p(post_key text, item_index int, sender_id text, sender_name text, group_ids text[],
                 first_at timestamptz, last_at timestamptz, messages int, source text, direction text,
                 brands text[], capacity_gb int, speed int, ddr text, rank text, form_factor text,
                 part_codes text[], date_code text, condition text, price numeric, price_approx boolean,
                 currency text, tax text, qty int, location text, raw_line text, row_keys text[])
        ON CONFLICT (report_date, post_key, item_index) DO NOTHING
      `;
    }
    const [{ n }] = await tx<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM wechat_market_points WHERE report_date = ${date}
    `;
    return n;
  });
  if (stored === null) return c.json({ error: 'day_not_found', detail: 'push the day before its points' }, 404);
  return c.json({ date, stored });
});

// ── Read ──────────────────────────────────────────────────────────────────────

type DayRow = {
  date: string;
  window_start: Date;
  window_end: Date;
  degraded: boolean;
  pushed_at: Date;
  summary: string | null;
  warnings: string[];
  messages: number;
  groups_total: number;
  groups_active: number;
  candidates: number;
  posts: number;
  buy_posts: number;
  sell_posts: number;
  buyers: number;
  sellers: number;
  point_count: number;
  stored_points: number;
};

const DAY_COLUMNS = (sql: ReturnType<typeof getDb>) => sql`
  to_char(d.report_date, 'YYYY-MM-DD') AS date, d.window_start, d.window_end, d.degraded, d.pushed_at,
  d.summary, d.warnings, d.messages, d.groups_total, d.groups_active, d.candidates, d.posts,
  d.buy_posts, d.sell_posts, d.buyers, d.sellers, d.point_count,
  (SELECT COUNT(*) FROM wechat_market_points p WHERE p.report_date = d.report_date)::int AS stored_points
`;

function daySummary(d: DayRow): WechatDaySummary {
  return {
    date: d.date,
    windowStart: d.window_start.toISOString(),
    windowEnd: d.window_end.toISOString(),
    degraded: d.degraded,
    pushedAt: d.pushed_at.toISOString(),
    totals: {
      messages: d.messages, groupsTotal: d.groups_total, groupsActive: d.groups_active,
      candidates: d.candidates, posts: d.posts, buyPosts: d.buy_posts, sellPosts: d.sell_posts,
      buyers: d.buyers, sellers: d.sellers,
    },
    pointCount: d.point_count,
    storedPoints: d.stored_points,
  };
}

wechat.get('/days', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql<DayRow[]>`
    SELECT ${DAY_COLUMNS(sql)} FROM wechat_market_days d ORDER BY d.report_date DESC
  `;
  return c.json({ days: rows.map(daySummary) });
});

type LineRow = {
  kind: WechatRowKind;
  row_key: string;
  brand: string | null;
  capacity_gb: number | null;
  speed: number | null;
  code: string | null;
  ddr: string | null;
  form_factor: 'server' | 'pc' | null;
  ranks: string[];
  part_numbers: string[];
  signal: string | null;
  buy_posts: number; buy_senders: number; buy_groups: number; buy_exposures: number; buy_qty: number;
  buy_prices: WechatPrice[];
  sell_posts: number; sell_senders: number; sell_groups: number; sell_exposures: number; sell_qty: number;
  sell_prices: WechatPrice[];
  prev_buy: WechatPrice | null;
  prev_sell: WechatPrice | null;
  has_prev: boolean;
};

wechat.get('/days/:date', async (c) => {
  const date = c.req.param('date');
  const bad = badDate(date);
  if (bad) return c.json(bad, 400);
  const kind = c.req.query('kind') ?? 'quote';
  if (!isWechatRowKind(kind)) return c.json({ error: 'invalid_kind' }, 400);
  const sql = getDb(c.env);
  const [day] = await sql<(DayRow & { prev_date: string | null; next_date: string | null })[]>`
    SELECT ${DAY_COLUMNS(sql)},
           (SELECT to_char(MAX(report_date), 'YYYY-MM-DD') FROM wechat_market_days WHERE report_date < d.report_date) AS prev_date,
           (SELECT to_char(MIN(report_date), 'YYYY-MM-DD') FROM wechat_market_days WHERE report_date > d.report_date) AS next_date
      FROM wechat_market_days d WHERE d.report_date = ${date}
  `;
  if (!day) return c.json({ error: 'not_found' }, 404);
  const [groups, lines] = await Promise.all([
    sql<{ id: string; name: string; messages: number; candidates: number; first_seen: Date | null }[]>`
      SELECT group_id AS id, name, messages, candidates, first_seen
        FROM wechat_market_groups WHERE report_date = ${date}
       ORDER BY messages DESC, name
    `,
    sql<LineRow[]>`
      SELECT r.*, p.buy_prices->0 AS prev_buy, p.sell_prices->0 AS prev_sell, (p.row_key IS NOT NULL) AS has_prev
        FROM wechat_market_rows r
        LEFT JOIN wechat_market_rows p
          ON p.report_date = ${day.prev_date}::date AND p.kind = r.kind AND p.row_key = r.row_key
       WHERE r.report_date = ${date} AND r.kind = ${kind}
       ORDER BY r.buy_senders + r.sell_senders DESC, r.row_key
    `,
  ]);
  const out: WechatDay = {
    ...daySummary(day),
    summary: day.summary,
    warnings: day.warnings,
    groups: groups.map((g) => ({
      id: g.id, name: g.name, messages: g.messages, candidates: g.candidates,
      firstSeen: g.first_seen?.toISOString() ?? null,
    })),
    prevDate: day.prev_date,
    nextDate: day.next_date,
  };
  const rows: WechatRow[] = lines.map((r) => ({
    kind: r.kind,
    key: r.row_key,
    brand: r.brand,
    capacityGb: r.capacity_gb,
    speed: r.speed,
    code: r.code,
    ddr: r.ddr,
    formFactor: r.form_factor,
    ranks: r.ranks,
    partNumbers: r.part_numbers,
    signal: r.signal,
    buy: {
      posts: r.buy_posts, senders: r.buy_senders, groups: r.buy_groups,
      exposures: r.buy_exposures, qty: r.buy_qty, prices: r.buy_prices,
    },
    sell: {
      posts: r.sell_posts, senders: r.sell_senders, groups: r.sell_groups,
      exposures: r.sell_exposures, qty: r.sell_qty, prices: r.sell_prices,
    },
    prev: r.has_prev ? { buy: r.prev_buy, sell: r.prev_sell } : null,
  }));
  return c.json({ day: out, rows });
});

// The posts behind one line of one day, newest first.
wechat.get('/days/:date/points', async (c) => {
  const date = c.req.param('date');
  const bad = badDate(date);
  if (bad) return c.json(bad, 400);
  const kind = c.req.query('kind');
  const key = c.req.query('key');
  const side = c.req.query('side');
  if (!isWechatRowKind(kind) || !key) return c.json({ error: 'kind and key are required' }, 400);
  if (side !== undefined && side !== 'buy' && side !== 'sell') return c.json({ error: 'invalid_side' }, 400);
  const sql = getDb(c.env);
  const rows = await sql<(Omit<WechatEvidence, 'firstAt' | 'lastAt' | 'price'> & {
    firstAt: Date; lastAt: Date; price: string | null;
  })[]>`
    SELECT p.post_key AS "postKey", p.item_index AS "itemIndex", p.sender_id AS "senderId",
           p.sender_name AS "senderName", p.first_at AS "firstAt", p.last_at AS "lastAt",
           p.messages, p.source, p.direction, p.brands, p.capacity_gb AS "capacityGb", p.speed,
           p.ddr, p.rank, p.form_factor AS "formFactor", p.part_codes AS "partCodes",
           p.date_code AS "dateCode", p.condition, p.price, p.price_approx AS "priceApprox",
           p.currency, p.tax, p.qty, p.location, p.raw_line AS "rawLine",
           ARRAY(
             SELECT COALESCE(g.name, gid)
               FROM unnest(p.group_ids) WITH ORDINALITY AS u(gid, ord)
               LEFT JOIN wechat_market_groups g ON g.report_date = p.report_date AND g.group_id = u.gid
              ORDER BY u.ord
           ) AS groups
      FROM wechat_market_points p
     WHERE p.report_date = ${date}
       AND ${`${kind}:${key}`} = ANY(p.row_keys)
       AND (${side ?? null}::text IS NULL OR p.direction = ${side ?? null})
     ORDER BY p.last_at DESC, p.post_key, p.item_index
     LIMIT ${EVIDENCE_LIMIT}
  `;
  const points: WechatEvidence[] = rows.map((r) => ({
    ...r,
    firstAt: r.firstAt.toISOString(),
    lastAt: r.lastAt.toISOString(),
    price: r.price === null ? null : Number(r.price),
  }));
  return c.json({ points, limit: EVIDENCE_LIMIT });
});

// One line's headline prices and trader counts on each report day up to `until`.
wechat.get('/history', async (c) => {
  const kind = c.req.query('kind');
  const key = c.req.query('key');
  const until = c.req.query('until');
  if (!isWechatRowKind(kind) || !key) return c.json({ error: 'kind and key are required' }, 400);
  if (until !== undefined && !isReportDate(until)) return c.json({ error: 'invalid_date' }, 400);
  const days = Math.min(HISTORY_DAYS_MAX, Math.max(2, Number.parseInt(c.req.query('days') ?? '30', 10) || 30));
  const sql = getDb(c.env);
  const rows = await sql<{
    date: string; buy_senders: number | null; sell_senders: number | null;
    buy: WechatPrice | null; sell: WechatPrice | null;
  }[]>`
    SELECT to_char(d.report_date, 'YYYY-MM-DD') AS date, r.buy_senders, r.sell_senders,
           r.buy_prices->0 AS buy, r.sell_prices->0 AS sell
      FROM (
        SELECT report_date FROM wechat_market_days
         WHERE ${until ?? null}::date IS NULL OR report_date <= ${until ?? null}::date
         ORDER BY report_date DESC LIMIT ${days}
      ) d
      LEFT JOIN wechat_market_rows r
        ON r.report_date = d.report_date AND r.kind = ${kind} AND r.row_key = ${key}
     ORDER BY d.report_date
  `;
  // A report day without the line is a day nobody quoted it: zero traders, no price.
  const history: WechatHistoryDay[] = rows.map((r) => ({
    date: r.date,
    buy: { senders: r.buy_senders ?? 0, price: r.buy },
    sell: { senders: r.sell_senders ?? 0, price: r.sell },
  }));
  return c.json({ history });
});

export default wechat;
