import {createHmac} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {Hono} from 'hono';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {createApi} from '../src/api.ts';
import {SettingsStore} from '../src/settings.ts';
import {parseDelivery, verifySignature} from '../src/webhook.ts';
import {createTestDb, type TestDb} from './helpers/db.ts';

const SECRET = 'whsec_test';
const TOKEN = 'test-token';
const FIXTURE_TEXT = readFileSync(
  new URL('./fixtures/redditapis-delivery.json', import.meta.url), 'utf8');

function fixture(): {delivery_id: string; items: Array<Record<string, unknown>>} {
  return JSON.parse(FIXTURE_TEXT);
}

function sign(body: string, secret = SECRET, t = Math.floor(Date.now() / 1000)): string {
  const hex = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${hex}`;
}

/** The fixture with fresh timestamps and the given delivery id. */
function freshDelivery(deliveryId: string, ageSeconds = 60): Record<string, unknown> {
  const body = fixture();
  const now = Date.now() / 1000;
  body.delivery_id = deliveryId;
  body.items = body.items.map((item) => ({
    ...item,
    created_utc: now - ageSeconds,
    created: new Date((now - ageSeconds) * 1000).toISOString(),
  }));
  return body;
}

describe('verifySignature', () => {
  const body = '{"a":1}';
  const now = 1_800_000_000;

  it('accepts a correct signature', () => {
    expect(verifySignature(body, sign(body, SECRET, now), SECRET, now)).toBe(true);
  });

  it('rejects a wrong secret or a changed body', () => {
    expect(verifySignature(body, sign(body, 'other', now), SECRET, now)).toBe(false);
    expect(verifySignature('{"a":2}', sign(body, SECRET, now), SECRET, now)).toBe(false);
  });

  it('rejects a stale timestamp and one too far in the future', () => {
    expect(verifySignature(body, sign(body, SECRET, now - 301), SECRET, now)).toBe(false);
    expect(verifySignature(body, sign(body, SECRET, now + 301), SECRET, now)).toBe(false);
    expect(verifySignature(body, sign(body, SECRET, now - 300), SECRET, now)).toBe(true);
  });

  it('rejects missing or malformed headers', () => {
    expect(verifySignature(body, undefined, SECRET, now)).toBe(false);
    expect(verifySignature(body, '', SECRET, now)).toBe(false);
    expect(verifySignature(body, 'garbage', SECRET, now)).toBe(false);
    expect(verifySignature(body, `t=${now}`, SECRET, now)).toBe(false);
    expect(verifySignature(body, `t=abc,v1=00`, SECRET, now)).toBe(false);
    expect(verifySignature(body, `t=${now},v1=zz`, SECRET, now)).toBe(false);
    expect(verifySignature(body, `t=${now},v1=abcd`, SECRET, now)).toBe(false);
    expect(verifySignature(body, sign(body, SECRET, now), '', now)).toBe(false);
  });
});

describe('parseDelivery', () => {
  it('maps both fixture items, the unverified one with empty selftext', () => {
    const parsed = parseDelivery(fixture());

    expect(parsed?.deliveryId).toBe('dlv_test_1');
    expect(parsed?.monitorId).toBe('mon_test');
    expect(parsed?.posts).toHaveLength(2);
    const [first, second] = parsed!.posts;
    expect(first).toMatchObject({
      redditId: 't3_1xz1gox',
      subreddit: 'homelabsales',
      title: '[FS] [US-FL] 2x Dell OptiPlex Micro Plus 7020',
      author: 'seller_one',
      flair: 'US-E',
      url: 'https://www.reddit.com/r/homelabsales/comments/1xz1gox/fs_usfl_2x_dell_optiplex_micro_plus_7020/',
    });
    expect(first!.selftext).toContain('Dell OptiPlex Micro Plus 7020');
    expect(first!.postedAt.getTime()).toBe(1794962758393);
    expect(second).toMatchObject({redditId: 't3_1xz0894', selftext: '', flair: 'US-W'});
  });

  it('prefers the header delivery id', () => {
    expect(parseDelivery(fixture(), 'dlv_header')?.deliveryId).toBe('dlv_header');
  });

  it('builds ids, nulls deleted authors and falls back on url and created', () => {
    const parsed = parseDelivery({
      delivery_id: 'd',
      items: [{
        id: 'abc', title: ' T ', subreddit: 'HomeLabSales', author: '[deleted]',
        url: 'https://reddit.com/x', created: '2026-11-17T00:00:00Z', text: 'x'.repeat(9000),
      }],
    });
    expect(parsed?.posts[0]).toMatchObject({
      redditId: 't3_abc', title: 'T', subreddit: 'homelabsales', author: null,
      flair: null, url: 'https://reddit.com/x',
    });
    expect(parsed?.posts[0]?.selftext).toHaveLength(8000);
  });

  it('skips unusable items and rejects unusable envelopes without throwing', () => {
    const parsed = parseDelivery({
      delivery_id: 'd',
      items: [null, 7, 'x', {title: 'no id', subreddit: 's', created_utc: 1},
        {id: 'a', subreddit: 's', created_utc: 1, permalink: '/r/s/'},
        {id: 'b', title: 't', subreddit: 's', permalink: '/r/s/'}],
    });
    expect(parsed?.posts).toEqual([]);

    expect(parseDelivery(null)).toBeNull();
    expect(parseDelivery('nope')).toBeNull();
    expect(parseDelivery([])).toBeNull();
    expect(parseDelivery({items: []})).toBeNull();
    expect(parseDelivery({delivery_id: 'd', items: {}})).toBeNull();
  });
});

describe('POST /webhooks/redditapis', () => {
  let db: TestDb;
  let app: Hono;

  function build(webhookSecret?: string): Hono {
    return createApi({
      sql: db.sql,
      settings: new SettingsStore(db.sql, 0),
      botToken: 'bot-token',
      apiToken: TOKEN,
      workerId: 'test-worker',
      startedAt: Date.now(),
      webhookSecret,
    });
  }

  async function post(
    body: unknown,
    opts: {signature?: string; deliveryHeader?: string; target?: Hono} = {},
  ): Promise<Response> {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-redditapis-signature': opts.signature ?? sign(raw),
      'x-redditapis-timestamp': String(Math.floor(Date.now() / 1000)),
    };
    if (opts.deliveryHeader) headers['x-redditapis-delivery-id'] = opts.deliveryHeader;
    return (opts.target ?? app).request('/webhooks/redditapis', {method: 'POST', body: raw, headers});
  }

  beforeAll(async () => {
    db = await createTestDb('webhook');
    app = build(SECRET);
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.sql`DELETE FROM posts`;
    await db.sql`DELETE FROM subreddits`;
    await db.sql`DELETE FROM webhook_deliveries`;
    await db.sql`
      INSERT INTO subreddits (name, enabled, last_status, consecutive_errors)
      VALUES ('homelabsales', TRUE, 'error', 3), ('hardwareswap', FALSE, NULL, 0)`;
    await db.sql`UPDATE settings SET value = to_jsonb('webhook'::text) WHERE key = 'poll_source'`;
  });

  it('answers 503 when no secret is configured, so the vendor retries', async () => {
    const res = await post(freshDelivery('d0'), {target: build(undefined)});
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({error: 'webhook not configured'});
    expect(await post(freshDelivery('d0'), {target: build('')}).then((r) => r.status)).toBe(503);
  });

  it('acknowledges a vendor test delivery without storing it', async () => {
    const res = await post({...freshDelivery('test_abc'), type: 'test', monitor_id: null});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ok: true, test: true});
    expect(await db.sql`SELECT 1 FROM webhook_deliveries`).toHaveLength(0);
    expect(await db.sql`SELECT 1 FROM posts`).toHaveLength(0);
  });

  it('rejects an oversized body with 413', async () => {
    const huge = 'x'.repeat(6 * 1024 * 1024);
    const res = await post(huge);
    expect(res.status).toBe(413);
  });

  it('strips NUL characters that Postgres text cannot hold', async () => {
    const body = freshDelivery('d-nul');
    const items = body['items'] as Array<Record<string, unknown>>;
    items[0] = {...items[0], title: 'Bad\u0000title', text: 'a\u0000b'};
    const res = await post(body);
    expect(res.status).toBe(200);
    const [row] = await db.sql<Array<{title: string; selftext: string}>>`
      SELECT title, selftext FROM posts WHERE reddit_id = 't3_1xz1gox'`;
    expect(row).toEqual({title: 'Badtitle', selftext: 'ab'});
  });

  it('leaves subreddit health to the poll loop while poll_source is reddit', async () => {
    await db.sql`UPDATE settings SET value = to_jsonb('reddit'::text) WHERE key = 'poll_source'`;
    const res = await post(freshDelivery('d-reddit-mode'));
    expect(res.status).toBe(200);
    const [sub] = await db.sql`
      SELECT last_status, consecutive_errors FROM subreddits WHERE name = 'homelabsales'`;
    expect(sub).toMatchObject({last_status: 'error', consecutive_errors: 3});
  });

  it('rejects a bad signature without storing anything', async () => {
    const res = await post(freshDelivery('d1'), {signature: sign('other body')});
    expect(res.status).toBe(401);
    expect((await post(freshDelivery('d1'), {signature: 'junk'})).status).toBe(401);
    const body = freshDelivery('d1');
    const stale = sign(JSON.stringify(body), SECRET, Math.floor(Date.now() / 1000) - 600);
    expect((await post(body, {signature: stale})).status).toBe(401);
    expect(await db.sql`SELECT 1 FROM webhook_deliveries`).toHaveLength(0);
    expect(await db.sql`SELECT 1 FROM posts`).toHaveLength(0);
  });

  it('rejects a signed but malformed envelope with 400', async () => {
    expect((await post('{not json')).status).toBe(400);
    expect((await post({items: []})).status).toBe(400);
  });

  it('inserts posts for enabled subreddits only and marks them healthy', async () => {
    const body = freshDelivery('d2');
    const items = body['items'] as Array<Record<string, unknown>>;
    items.push({...items[0], id: 'other1', name: 't3_other1', subreddit: 'hardwareswap',
      permalink: '/r/hardwareswap/comments/other1/x/'});
    items.push({...items[0], id: 'other2', name: 't3_other2', subreddit: 'pics',
      permalink: '/r/pics/comments/other2/x/'});

    const res = await post(body);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ok: true, inserted: 2});
    const posts = await db.sql<Array<{reddit_id: string; selftext: string; status: string}>>`
      SELECT reddit_id, selftext, status FROM posts ORDER BY reddit_id`;
    expect(posts.map((p) => p.reddit_id)).toEqual(['t3_1xz0894', 't3_1xz1gox']);
    expect(posts[0]!.selftext).toBe('');
    expect(posts.every((p) => p.status === 'new')).toBe(true);

    const [delivery] = await db.sql`SELECT * FROM webhook_deliveries`;
    expect(delivery).toMatchObject({delivery_id: 'd2', monitor_id: 'mon_test', items: 4, inserted: 2});

    const subs = await db.sql`
      SELECT name, last_status, consecutive_errors, last_polled_at, claimed_by
        FROM subreddits ORDER BY name`;
    expect(subs[1]).toMatchObject({name: 'homelabsales', last_status: 'ok', consecutive_errors: 0});
    expect(subs[1]!['last_polled_at']).not.toBeNull();
    expect(subs[0]).toMatchObject({name: 'hardwareswap', last_status: null, last_polled_at: null});
  });

  it('treats a repeated delivery id as a duplicate and inserts nothing', async () => {
    expect(await (await post(freshDelivery('d3'))).json()).toEqual({ok: true, inserted: 2});
    await db.sql`DELETE FROM posts`;

    const res = await post(freshDelivery('d3'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ok: true, duplicate: true});
    expect(await db.sql`SELECT 1 FROM posts`).toHaveLength(0);
    expect(await db.sql`SELECT 1 FROM webhook_deliveries`).toHaveLength(1);
  });

  it('uses the delivery id header over the body', async () => {
    await post(freshDelivery('body-id'), {deliveryHeader: 'header-id'});
    const rows = await db.sql`SELECT delivery_id FROM webhook_deliveries`;
    expect(rows.map((r) => r['delivery_id'])).toEqual(['header-id']);
  });

  it('drops posts older than max_post_age_hours', async () => {
    const res = await post(freshDelivery('d4', 25 * 3600));

    expect(await res.json()).toEqual({ok: true, inserted: 0});
    expect(await db.sql`SELECT 1 FROM posts`).toHaveLength(0);
  });

  it('leaves /api/* behind the bearer token', async () => {
    expect((await app.request('/api/matches')).status).toBe(401);
    const ok = await app.request('/api/matches', {headers: {Authorization: `Bearer ${TOKEN}`}});
    expect(ok.status).toBe(200);
  });
});
