import { Hono, type Context } from 'hono';
import {
  REDDIT_LEAD_DM_FOLLOW_UP_DAYS,
  REDDIT_LEAD_IMPORT_MAX,
  REDDIT_LEAD_NOSTOCK_DAYS,
  REDDIT_LEAD_REPLY_MAX,
  REDDIT_LEAD_STAGES,
  REPORTING_TZ,
  addDays,
  isRedditLeadClosing,
  isRedditLeadStage,
  isRedditName,
  redditKey,
  todayIn,
  type RedditBuyer,
  type RedditBuyerTree,
  type RedditLead,
  type RedditLeadClosing,
  type RedditLeadEvent,
  type RedditLeadEventKind,
  type RedditLeadImport,
  type RedditLeadStage,
} from '@recycle-erp/shared';
import { authMiddleware } from '../auth';
import { getDb, type SqlLike } from '../db';
import { effectiveRole, requireManager } from '../lib/role';
import type { Env, User } from '../types';

// ─── Reddit leads ─────────────────────────────────────────────────────────────
// Sellers from the swap subreddits' trade-bot records. Purchasers claim one
// and work it from a first DM to a deal; managers import the list and see the
// whole team. A purchaser learns only that someone else holds a seller: who,
// how far along and what the seller said stay with the holder and managers.
// Every write returns the one lead it changed; the page patches its list.

type Vars = { user: User };
type Tx = SqlLike;

type Row = {
  username: string;
  display_name: string;
  sales: number;
  buys: number;
  record_source: string;
  subreddits: string[];
  last_deal: string | null;
  items_sold: string[];
  latest_post_title: string;
  latest_post_url: string;
  tracker_alerts: number;
  claimed_by: string | null;
  claimed_name: string | null;
  claimed_at: Date | null;
  stage: RedditLeadStage;
  closed: RedditLeadClosing | '';
  follow_up: string | null;
  dm_at: Date | null;
  reply_text: string | null;
  reply_at: Date | null;
  reply_by: string | null;
};

const ms = (d: Date | null) => (d === null ? null : d.getTime());
const today = () => todayIn(REPORTING_TZ);

// last_deal and follow_up come back as text so a DATE never shifts a day
// through the driver's time zone.
const SELECT = (sql: Tx) => sql`
  SELECT l.username, l.display_name, l.sales, l.buys, l.record_source, l.subreddits,
         l.last_deal::text AS last_deal, l.items_sold, l.latest_post_title, l.latest_post_url,
         l.tracker_alerts, l.claimed_by, l.claimed_name, l.claimed_at, l.stage, l.closed,
         l.follow_up::text AS follow_up, l.dm_at,
         r.detail AS reply_text, r.created_at AS reply_at, r.actor_name AS reply_by
  FROM reddit_leads l
  LEFT JOIN LATERAL (
    SELECT detail, created_at, actor_name FROM reddit_lead_events e
    WHERE e.username = l.username AND e.kind = 'reply'
    ORDER BY created_at DESC LIMIT 1
  ) r ON l.claimed_by IS NOT NULL`;

/** Whether `user` may see this lead's conversation. A manager previewing as
 *  a purchaser reads the purchaser's shape; writes go by the real role. */
const sees = (row: Pick<Row, 'claimed_by'>, user: User) =>
  row.claimed_by !== null && (row.claimed_by === user.id || effectiveRole(user) === 'manager');

function toLead(r: Row, user: User): RedditLead {
  const open = sees(r, user);
  return {
    username: r.username,
    name: r.display_name,
    sales: r.sales,
    buys: r.buys,
    recordSource: r.record_source,
    subreddits: r.subreddits,
    lastDeal: r.last_deal,
    itemsSold: r.items_sold,
    latestPostTitle: r.latest_post_title,
    latestPostUrl: r.latest_post_url,
    trackerAlerts: r.tracker_alerts,
    claimed: r.claimed_by !== null,
    mine: r.claimed_by === user.id,
    holderId: open ? r.claimed_by : null,
    holderName: open ? r.claimed_name : null,
    claimedAt: open ? ms(r.claimed_at) : null,
    stage: open ? r.stage : 'claimed',
    closed: open ? r.closed : '',
    followUp: open ? r.follow_up : null,
    dmAt: open ? ms(r.dm_at) : null,
    lastReply: open && r.reply_text !== null ? { text: r.reply_text, at: r.reply_at!.getTime(), by: r.reply_by! } : null,
  };
}

async function readLead(sql: Tx, username: string, user: User): Promise<RedditLead | null> {
  const [row] = await sql<Row[]>`${SELECT(sql)} WHERE l.username = ${username}`;
  return row ? toLead(row, user) : null;
}

async function writeEvent(tx: Tx, user: User, username: string | null, kind: RedditLeadEventKind, detail = '') {
  await tx`
    INSERT INTO reddit_lead_events (username, actor_id, actor_name, kind, detail)
    VALUES (${username}, ${user.id}, ${user.name}, ${kind}, ${detail})`;
}

const leads = new Hono<{ Bindings: Env; Variables: Vars }>().use('*', authMiddleware);

leads.get('/', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql<Row[]>`${SELECT(sql)} ORDER BY l.sales DESC, l.username`;
  return c.json({ leads: rows.map((r) => toLead(r, c.var.user)), today: today() });
});

// The sidebar badge: the caller's leads waiting on them, a first DM or a
// follow-up that has come due. The same rule as redditLeadNeedsAction.
leads.get('/attention', async (c) => {
  const sql = getDb(c.env);
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM reddit_leads
    WHERE claimed_by = ${c.var.user.id} AND closed = '' AND stage <> 'won'
      AND (stage = 'claimed' OR follow_up <= ${today()})`;
  return c.json({ n });
});

leads.get('/buyers', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql<(Omit<RedditBuyer, 'name'> & { display_name: string })[]>`
    SELECT b.username, b.display_name, b.buys, b.sales,
           (SELECT COUNT(DISTINCT t.seller)::int FROM reddit_lead_trades t WHERE t.buyer = b.username) AS sellers
    FROM reddit_lead_buyers b ORDER BY b.buys DESC, b.username`;
  return c.json({ buyers: rows.map(({ display_name, ...b }) => ({ ...b, name: display_name })) });
});

leads.get('/buyers/:username', async (c) => {
  const key = redditKey(c.req.param('username'));
  const sql = getDb(c.env);
  const [b] = await sql<{ username: string; display_name: string; buys: number; sales: number }[]>`
    SELECT username, display_name, buys, sales FROM reddit_lead_buyers WHERE username = ${key}`;
  if (!b) return c.json({ error: 'Not found' }, 404);
  const trades = await sql<{ seller: string; name: string | null; item: string; date: string | null; url: string; subreddit: string }[]>`
    SELECT t.seller, l.display_name AS name, t.item, t.traded_on::text AS date, t.url, t.subreddit
    FROM reddit_lead_trades t LEFT JOIN reddit_leads l ON l.username = t.seller
    WHERE t.buyer = ${key}
    ORDER BY t.traded_on DESC NULLS LAST, t.id`;
  const bySeller = new Map<string, RedditBuyerTree['sellers'][number]>();
  for (const t of trades) {
    let s = bySeller.get(t.seller);
    if (!s) bySeller.set(t.seller, (s = { username: t.seller, name: t.name ?? t.seller, trades: [] }));
    s.trades.push({ item: t.item, date: t.date, url: t.url, subreddit: t.subreddit });
  }
  const tree: RedditBuyerTree = {
    buyer: { username: b.username, name: b.display_name, buys: b.buys, sales: b.sales, sellers: bySeller.size },
    sellers: [...bySeller.values()],
  };
  return c.json(tree);
});

leads.get('/:username', async (c) => {
  const key = redditKey(c.req.param('username'));
  const sql = getDb(c.env);
  const lead = await readLead(sql, key, c.var.user);
  if (!lead) return c.json({ error: 'Not found' }, 404);
  // History is the conversation, so it follows the same rule as the stage.
  const visible = lead.holderId !== null || (!lead.claimed && effectiveRole(c.var.user) === 'manager');
  const events = visible
    ? await sql<{ at: Date; actor: string; kind: RedditLeadEventKind; detail: string }[]>`
        SELECT created_at AS at, actor_name AS actor, kind, detail FROM reddit_lead_events
        WHERE username = ${key} ORDER BY created_at DESC LIMIT 200`
    : [];
  const history: RedditLeadEvent[] = events.map((e) => ({ ...e, at: e.at.getTime() }));
  // The top buyers this seller sold to: public trade records, open to all.
  const buyers = await sql<{ username: string; name: string }[]>`
    SELECT DISTINCT b.username, b.display_name AS name, b.buys
    FROM reddit_lead_trades t JOIN reddit_lead_buyers b ON b.username = t.buyer
    WHERE t.seller = ${key} ORDER BY b.buys DESC`;
  return c.json({ lead, history, buyers: buyers.map(({ username, name }) => ({ username, name })) });
});

leads.post('/:username/claim', async (c) => {
  const key = redditKey(c.req.param('username'));
  const sql = getDb(c.env);
  const user = c.var.user;
  const verdict = await sql.begin(async (tx) => {
    const [row] = await tx<{ claimed_by: string | null }[]>`
      SELECT claimed_by FROM reddit_leads WHERE username = ${key} FOR NO KEY UPDATE`;
    if (!row) return 'missing';
    if (row.claimed_by !== null) return row.claimed_by === user.id ? 'ok' : 'taken';
    // A new claim starts the pipeline over; the old holder's history stays.
    await tx`
      UPDATE reddit_leads
      SET claimed_by = ${user.id}, claimed_name = ${user.name}, claimed_at = NOW(),
          stage = 'claimed', closed = '', follow_up = NULL, dm_at = NULL, updated_at = NOW()
      WHERE username = ${key}`;
    await writeEvent(tx, user, key, 'claimed');
    return 'ok';
  });
  if (verdict === 'missing') return c.json({ error: 'Not found' }, 404);
  if (verdict === 'taken') return c.json({ error: 'Another purchaser claimed this seller', code: 'rlTakenElsewhere' }, 409);
  return c.json(await readLead(sql, key, user));
});

type HeldVerdict = 'missing' | 'forbidden' | 'not_claimed' | 'ok';

/** Locks a claimed lead the caller may work: its holder, or any manager. */
async function lockHeld(tx: Tx, key: string, user: User): Promise<HeldVerdict> {
  const [row] = await tx<{ claimed_by: string | null }[]>`
    SELECT claimed_by FROM reddit_leads WHERE username = ${key} FOR NO KEY UPDATE`;
  if (!row) return 'missing';
  if (row.claimed_by === null) return 'not_claimed';
  if (row.claimed_by !== user.id && user.role !== 'manager') return 'forbidden';
  return 'ok';
}

function heldRefusal(c: Context, verdict: HeldVerdict) {
  if (verdict === 'missing') return c.json({ error: 'Not found' }, 404);
  if (verdict === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
  return c.json({ error: 'Claim this seller first', code: 'rlNotClaimed' }, 409);
}

/**
 * Runs `work` on a lead the caller holds (or manages) inside one transaction,
 * then answers with the lead. `work` may return a 400 message to refuse.
 */
async function held(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  work: (tx: Tx, key: string, user: User) => Promise<string | void>,
) {
  const key = redditKey(c.req.param('username') ?? '');
  const sql = getDb(c.env);
  const user = c.var.user;
  let bad: string | void = undefined;
  const verdict = await sql.begin(async (tx) => {
    const v = await lockHeld(tx, key, user);
    if (v !== 'ok') return v;
    bad = await work(tx, key, user);
    if (bad) throw new Refused();
    return v;
  }).catch((e) => { if (e instanceof Refused) return 'refused' as const; throw e; });
  if (verdict === 'refused') return c.json({ error: bad }, 400);
  if (verdict !== 'ok') return heldRefusal(c, verdict);
  return c.json(await readLead(sql, key, user));
}
class Refused extends Error {}

leads.post('/:username/release', (c) => held(c, async (tx, key, user) => {
  await tx`
    UPDATE reddit_leads
    SET claimed_by = NULL, claimed_name = NULL, claimed_at = NULL, stage = 'claimed',
        closed = '', follow_up = NULL, dm_at = NULL, updated_at = NOW()
    WHERE username = ${key}`;
  await writeEvent(tx, user, key, 'released');
}));

leads.post('/:username/dm', async (c) => {
  const body = await c.req.json().catch(() => null) as { template?: unknown } | null;
  const template = typeof body?.template === 'string' ? body.template.slice(0, 60) : '';
  return held(c, async (tx, key, user) => {
    const follow = addDays(today(), REDDIT_LEAD_DM_FOLLOW_UP_DAYS);
    // A DM moves a fresh claim to "DM sent"; later stages stay where they are.
    await tx`
      UPDATE reddit_leads
      SET stage = CASE WHEN stage = 'claimed' THEN 'dm' ELSE stage END,
          dm_at = NOW(), follow_up = ${follow}, closed = '', updated_at = NOW()
      WHERE username = ${key}`;
    await writeEvent(tx, user, key, 'dm', template);
  });
});

leads.post('/:username/reply', async (c) => {
  const body = await c.req.json().catch(() => null) as { text?: unknown } | null;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  return held(c, async (tx, key, user) => {
    if (!text) return 'Write what the seller said';
    if (text.length > REDDIT_LEAD_REPLY_MAX) return `Keep a reply under ${REDDIT_LEAD_REPLY_MAX} characters`;
    // A reply answers the follow-up that was waiting for it.
    await tx`
      UPDATE reddit_leads
      SET stage = CASE WHEN stage IN ('claimed','dm') THEN 'replied' ELSE stage END,
          follow_up = NULL, updated_at = NOW()
      WHERE username = ${key}`;
    await writeEvent(tx, user, key, 'reply', text);
  });
});

leads.put('/:username/stage', async (c) => {
  const body = await c.req.json().catch(() => null) as { stage?: unknown } | null;
  const stage = body?.stage;
  return held(c, async (tx, key, user) => {
    if (!isRedditLeadStage(stage)) return `Stage must be one of ${REDDIT_LEAD_STAGES.join(', ')}`;
    const [row] = await tx<{ stage: string }[]>`SELECT stage FROM reddit_leads WHERE username = ${key}`;
    if (row.stage === stage) return;
    await tx`
      UPDATE reddit_leads
      SET stage = ${stage}, closed = '', updated_at = NOW(),
          follow_up = CASE WHEN ${stage} = 'won' THEN NULL ELSE follow_up END
      WHERE username = ${key}`;
    await writeEvent(tx, user, key, 'stage', stage);
  });
});

leads.put('/:username/follow-up', async (c) => {
  const body = await c.req.json().catch(() => null) as { date?: unknown } | null;
  const date = body?.date ?? null;
  return held(c, async (tx, key, user) => {
    if (date !== null && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))) {
      return 'Follow-up must be a date (YYYY-MM-DD) or null';
    }
    await tx`UPDATE reddit_leads SET follow_up = ${date}, updated_at = NOW() WHERE username = ${key}`;
    await writeEvent(tx, user, key, 'follow_up', date ?? '');
  });
});

leads.put('/:username/close', async (c) => {
  const body = await c.req.json().catch(() => null) as { closed?: unknown } | null;
  const closed = body?.closed;
  return held(c, async (tx, key, user) => {
    if (!isRedditLeadClosing(closed)) return 'Close as nostock or lost';
    // "No stock now" is worth asking again later; "Not interested" is not.
    const follow = closed === 'nostock' ? addDays(today(), REDDIT_LEAD_NOSTOCK_DAYS) : null;
    await tx`UPDATE reddit_leads SET closed = ${closed}, follow_up = ${follow}, updated_at = NOW() WHERE username = ${key}`;
    await writeEvent(tx, user, key, 'closed', closed);
  });
});

leads.post('/:username/reopen', (c) => held(c, async (tx, key, user) => {
  await tx`
    UPDATE reddit_leads
    SET closed = '', stage = CASE WHEN stage = 'won' THEN 'talks' ELSE stage END, updated_at = NOW()
    WHERE username = ${key}`;
  await writeEvent(tx, user, key, 'reopened');
}));

// ─── Manager-only ─────────────────────────────────────────────────────────────

leads.use('/import', requireManager);

const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const strs = (v: unknown, n: number, max: number) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, n).map((x) => x.trim().slice(0, max)) : [];

/**
 * Loads a harvest. Sellers are upserted by name: counts, items and the latest
 * post change, the claim and its conversation never do. Buyers and trades are
 * replaced whole, because they are only ever the latest harvest's picture.
 */
leads.post('/import', async (c) => {
  const body = await c.req.json().catch(() => null) as RedditLeadImport | null;
  if (!body || !Array.isArray(body.sellers) || body.sellers.length === 0) {
    return c.json({ error: 'Send { sellers: [...] } with at least one seller' }, 400);
  }
  if (body.sellers.length > REDDIT_LEAD_IMPORT_MAX) {
    return c.json({ error: `Import at most ${REDDIT_LEAD_IMPORT_MAX} sellers at a time` }, 400);
  }
  const errors: { index: number; error: string }[] = [];
  const sellers = new Map<string, Record<string, unknown>>();
  body.sellers.forEach((s, index) => {
    const key = redditKey(typeof s?.name === 'string' ? s.name : '');
    const sales = int(s?.sales), buys = int(s?.buys);
    if (!isRedditName(key)) return errors.push({ index, error: 'name is not a Reddit username' });
    if (sales === null || buys === null) return errors.push({ index, error: 'sales and buys must be whole numbers' });
    sellers.set(key, {
      username: key,
      display_name: s.name.trim().replace(/^\/?u\//i, ''),
      sales, buys,
      record_source: str(s.recordSource, 60),
      subreddits: strs(s.subreddits, 10, 40),
      last_deal: day(s.lastDeal),
      items_sold: strs(s.itemsSold, 8, 160),
      latest_post_title: str(s.latestPostTitle, 300),
      latest_post_url: /^https:\/\/(www\.)?reddit\.com\//.test(str(s.latestPostUrl, 500)) ? str(s.latestPostUrl, 500) : '',
      tracker_alerts: int(s.trackerAlerts) ?? 0,
    });
  });
  if (errors.length) return c.json({ error: 'Some sellers are not valid', errors: errors.slice(0, 20) }, 400);

  const buyers = new Map<string, { username: string; display_name: string; buys: number; sales: number }>();
  for (const b of body.buyers ?? []) {
    const key = redditKey(typeof b?.name === 'string' ? b.name : '');
    if (isRedditName(key)) buyers.set(key, { username: key, display_name: b.name.trim(), buys: int(b.buys) ?? 0, sales: int(b.sales) ?? 0 });
  }
  const trades = (body.trades ?? []).flatMap((t) => {
    const buyer = redditKey(typeof t?.buyer === 'string' ? t.buyer : ''), seller = redditKey(typeof t?.seller === 'string' ? t.seller : '');
    if (!buyers.has(buyer) || !isRedditName(seller)) return [];
    const url = str(t.url, 500);
    return [{ buyer, seller, item: str(t.item, 200), traded_on: day(t.date), url: /^https:\/\/(www\.)?reddit\.com\//.test(url) ? url : '', subreddit: str(t.subreddit, 40) }];
  });

  const sql = getDb(c.env);
  const user = c.var.user;
  const result = await sql.begin(async (tx) => {
    const rows = [...sellers.values()];
    const [{ existing }] = await tx<{ existing: number }[]>`
      SELECT COUNT(*)::int AS existing FROM reddit_leads WHERE username IN ${tx(rows.map((r) => r.username as string))}`;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await tx`
        INSERT INTO reddit_leads ${tx(chunk, 'username', 'display_name', 'sales', 'buys', 'record_source', 'subreddits',
          'last_deal', 'items_sold', 'latest_post_title', 'latest_post_url', 'tracker_alerts')}
        ON CONFLICT (username) DO UPDATE SET
          display_name = EXCLUDED.display_name, sales = EXCLUDED.sales, buys = EXCLUDED.buys,
          record_source = EXCLUDED.record_source, subreddits = EXCLUDED.subreddits,
          last_deal = EXCLUDED.last_deal, items_sold = EXCLUDED.items_sold,
          latest_post_title = EXCLUDED.latest_post_title, latest_post_url = EXCLUDED.latest_post_url,
          tracker_alerts = EXCLUDED.tracker_alerts, imported_at = NOW(), updated_at = NOW()`;
    }
    if (body.buyers) {
      await tx`DELETE FROM reddit_lead_buyers`;
      const bs = [...buyers.values()];
      if (bs.length) await tx`INSERT INTO reddit_lead_buyers ${tx(bs, 'username', 'display_name', 'buys', 'sales')}`;
      for (let i = 0; i < trades.length; i += 1000) {
        await tx`INSERT INTO reddit_lead_trades ${tx(trades.slice(i, i + 1000), 'buyer', 'seller', 'item', 'traded_on', 'url', 'subreddit')}`;
      }
    }
    const summary = { sellers: rows.length, added: rows.length - existing, updated: existing, buyers: buyers.size, trades: trades.length };
    await writeEvent(tx, user, null, 'imported',
      `${summary.sellers} sellers (${summary.added} new) · ${summary.buyers} buyers · ${summary.trades} trades`);
    return summary;
  });
  return c.json(result, 201);
});

export default leads;
