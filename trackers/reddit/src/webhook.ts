// Inbound posts from the redditapis.com monitor. Reddit withdrew anonymous
// RSS, so the fleet can no longer discover posts itself; the vendor polls
// Reddit and POSTs each batch here. This file only verifies and stores them —
// the evaluate and notify loops pick the rows up exactly as they did polled
// ones.

import {createHmac, timingSafeEqual} from 'node:crypto';
import type {Context} from 'hono';
import {insertNewPosts, type NewPost} from './claims.ts';
import type {Sql} from './db.ts';
import type {Logger} from './logger.ts';
import type {SettingsStore} from './settings.ts';

/** How far a signature's timestamp may sit from our clock, either way. */
export const SIGNATURE_TOLERANCE_S = 300;

const SELFTEXT_MAX = 8000;

/** The largest delivery we read. A grouped delivery of 100 long posts is ~1 MB. */
export const WEBHOOK_BODY_LIMIT_BYTES = 5 * 1024 * 1024;

export interface ParsedDelivery {
  deliveryId: string;
  monitorId: string | null;
  /** Items in the envelope, whether or not they became posts. */
  itemCount: number;
  posts: NewPost[];
}

export interface WebhookDeps {
  sql: Sql;
  settings: SettingsStore;
  webhookSecret?: string;
}

/**
 * Checks an `x-redditapis-signature` header (`t=<unix s>,v1=<hex>`): an
 * HMAC-SHA256 of `${t}.${rawBody}` keyed with the webhook secret. A timestamp
 * more than SIGNATURE_TOLERANCE_S away from `nowSeconds` is a replay. Several
 * `v1` entries (a secret rotation) pass if any one matches.
 */
function parseSignatureHeader(
  header: string | undefined,
): {timestamp: string; signatures: string[]} | null {
  if (!header) return null;
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (timestamp === null || !/^\d+$/.test(timestamp) || signatures.length === 0) return null;
  return {timestamp, signatures};
}

/**
 * Whether a signature header is well-formed and fresh. Checked before the
 * body is read, so a junk request on this public route costs nothing.
 */
export function signatureLooksFresh(header: string | undefined, nowSeconds: number): boolean {
  const parsed = parseSignatureHeader(header);
  return parsed !== null
    && Math.abs(nowSeconds - Number(parsed.timestamp)) <= SIGNATURE_TOLERANCE_S;
}

export function verifySignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  nowSeconds: number,
): boolean {
  if (!secret) return false;
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed || !signatureLooksFresh(signatureHeader, nowSeconds)) return false;
  const {timestamp, signatures} = parsed;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest();
  return signatures.some((sig) => {
    if (!/^[0-9a-fA-F]+$/.test(sig) || sig.length !== expected.length * 2) return false;
    return timingSafeEqual(Buffer.from(sig, 'hex'), expected);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Postgres text cannot hold U+0000; one NUL would fail the whole delivery's
// transaction on every retry and redrive (heartbeat.ts strips it the same way).
function withoutNul(value: string): string {
  return value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = withoutNul(value).trim();
  return clean !== '' ? clean : null;
}

function parsePostedAt(item: Record<string, unknown>): Date | null {
  const utc = item['created_utc'];
  if (typeof utc === 'number' && Number.isFinite(utc) && utc > 0) {
    return new Date(utc * 1000);
  }
  if (typeof item['created'] === 'string') {
    const date = new Date(item['created']);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function parseItem(item: unknown): NewPost | null {
  if (!isRecord(item)) return null;

  const name = nonEmptyString(item['name']);
  const id = nonEmptyString(item['id']);
  const redditId = name?.startsWith('t3_') ? name : id ? `t3_${id}` : null;
  const title = nonEmptyString(item['title']);
  const subreddit = nonEmptyString(item['subreddit'])?.toLowerCase().replace(/^\/?r\//, '');
  const postedAt = parsePostedAt(item);
  if (!redditId || !title || !subreddit || !postedAt) return null;

  const permalink = nonEmptyString(item['permalink']);
  const url = permalink?.startsWith('/')
    ? `https://www.reddit.com${permalink}`
    : nonEmptyString(item['url']);
  if (!url) return null;

  const author = nonEmptyString(item['author']);
  const text = item['text'];
  return {
    redditId,
    subreddit,
    title,
    // Absent when the vendor could not verify the body (body_verified: false).
    // The post is still worth judging on its title.
    selftext: typeof text === 'string' ? withoutNul(text).slice(0, SELFTEXT_MAX) : '',
    author: author && author !== '[deleted]' ? author : null,
    flair: nonEmptyString(item['link_flair_text']),
    url,
    postedAt,
  };
}

/**
 * Maps a delivery envelope to posts. Returns null when the envelope has no
 * delivery id or no items array; items that cannot become a post are skipped.
 * `headerDeliveryId` (x-redditapis-delivery-id) wins over the body's.
 */
export function parseDelivery(json: unknown, headerDeliveryId?: string): ParsedDelivery | null {
  if (!isRecord(json)) return null;
  const deliveryId = nonEmptyString(headerDeliveryId) ?? nonEmptyString(json['delivery_id']);
  const items = json['items'];
  if (!deliveryId || !Array.isArray(items)) return null;

  const posts: NewPost[] = [];
  for (const item of items) {
    const post = parseItem(item);
    if (post) posts.push(post);
  }
  return {deliveryId, monitorId: nonEmptyString(json['monitor_id']), itemCount: items.length, posts};
}

/** Builds the `POST /webhooks/redditapis` handler. */
export function webhookHandler(deps: WebhookDeps, logger: Logger) {
  return async (c: Context): Promise<Response> => {
    // 503, not 404: the vendor retries 5xx for ~21 minutes but dead-letters a
    // 4xx at once, so a deploy that briefly lacks the secret loses nothing.
    const secret = deps.webhookSecret ?? '';
    if (!secret) return c.json({error: 'webhook not configured'}, 503);

    // Rejections log at info: this route is public, and a warn per junk
    // request would let anyone flood the ops digest and bury real errors.
    const signature = c.req.header('x-redditapis-signature');
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (!signatureLooksFresh(signature, nowSeconds)) {
      logger.info('webhook rejected: missing or stale signature');
      return c.json({error: 'invalid signature'}, 401);
    }
    // Verify the exact bytes the vendor signed, before any JSON parsing. The
    // body size is capped by the route's bodyLimit (api.ts).
    const rawBody = await c.req.text();
    if (!verifySignature(rawBody, signature, secret, nowSeconds)) {
      logger.info('webhook rejected: signature mismatch', {
        deliveryId: c.req.header('x-redditapis-delivery-id') ?? null,
      });
      return c.json({error: 'invalid signature'}, 401);
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      json = null;
    }
    // The vendor's docs: skip anything with type "test" in production logic.
    // Stored, it would insert its sample post and reset the quiet alert.
    if (isRecord(json) && json['type'] === 'test') {
      logger.info('webhook test delivery acknowledged');
      return c.json({ok: true, test: true});
    }

    const delivery = parseDelivery(json, c.req.header('x-redditapis-delivery-id'));
    if (!delivery) {
      // Signed by the vendor yet unusable: their format changed. A 400 is not
      // retried, so this is the only trace of the lost delivery.
      logger.warn('webhook delivery malformed', {bytes: rawBody.length});
      return c.json({error: 'malformed delivery'}, 400);
    }

    try {
      const {maxPostAgeHours, pollSource} = await deps.settings.get();
      const cutoff = Date.now() - maxPostAgeHours * 3600_000;
      const {itemCount} = delivery;

      const result = await deps.sql.begin(async (tx) => {
        const [fresh] = await tx`
          INSERT INTO webhook_deliveries (delivery_id, monitor_id, items, inserted)
          VALUES (${delivery.deliveryId}, ${delivery.monitorId}, ${itemCount}, 0)
          ON CONFLICT (delivery_id) DO NOTHING
          RETURNING delivery_id`;
        if (!fresh) return null;

        // Only subreddits we watch: a misconfigured monitor must not be able
        // to fill the table (and the LLM bill) with someone else's feed.
        const enabledRows = await tx<Array<{name: string}>>`
          SELECT name FROM subreddits WHERE enabled`;
        const enabled = new Set(enabledRows.map((r) => r.name));
        const watched = delivery.posts.filter((p) => enabled.has(p.subreddit));
        const posts = watched.filter((p) => p.postedAt.getTime() >= cutoff);

        // `tx` is a TransactionSql; insertNewPosts only runs one tagged query.
        const inserted = await insertNewPosts(tx as unknown as Sql, posts);
        await tx`
          UPDATE webhook_deliveries SET inserted = ${inserted.length}
           WHERE delivery_id = ${delivery.deliveryId}`;

        // Subreddit health belongs to whichever source is live: in reddit mode
        // the poll loop owns it, and resetting consecutive_errors here would
        // hide its failures and restart its backoff.
        const seen = [...new Set(watched.map((p) => p.subreddit))];
        if (seen.length > 0 && pollSource === 'webhook') {
          await tx`
            UPDATE subreddits
               SET last_polled_at = NOW(), last_status = 'ok', consecutive_errors = 0
             WHERE name = ANY(${seen})`;
        }
        return {inserted: inserted.length, watched: watched.length, subreddits: seen};
      });

      if (!result) {
        logger.info('webhook redelivery ignored', {deliveryId: delivery.deliveryId});
        return c.json({ok: true, duplicate: true});
      }
      if (itemCount > 0 && result.watched === 0) {
        // Every item was dropped before the age filter: a vendor field we parse
        // changed, or the monitor watches subreddits we don't.
        logger.warn('webhook delivery had no usable posts', {
          deliveryId: delivery.deliveryId,
          items: itemCount,
          parsed: delivery.posts.length,
        });
      }
      logger.info('webhook delivery stored', {
        deliveryId: delivery.deliveryId,
        monitorId: delivery.monitorId,
        items: itemCount,
        parsed: delivery.posts.length,
        watched: result.watched,
        inserted: result.inserted,
        subreddits: result.subreddits,
      });
      return c.json({ok: true, inserted: result.inserted});
    } catch (e) {
      // 5xx makes the vendor retry, and the delivery row rolled back with the
      // posts, so the retry is not mistaken for a duplicate.
      logger.error('webhook delivery failed', {
        deliveryId: delivery.deliveryId,
        error: e instanceof Error ? e.message : String(e),
      });
      return c.json({error: 'internal error'}, 500);
    }
  };
}
