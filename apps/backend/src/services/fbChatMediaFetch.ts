import { FB_CHAT_MEDIA_MAX_UPLOAD_BYTES } from '@recycle-erp/shared';

import type { SqlLike } from '../db';
import { storeFbChatMedia } from '../lib/fbChatMedia';
import { log } from '../lib/log';
import type { Env } from '../types';
import type { FbChatMissingMedia } from './fbChat';

// The hub's own copy of a chat photo, for extensions that only send the
// bubble's links. Facebook signs those links for a short while, so they are
// fetched right after the sync that brought them, a couple at a time, and a
// photo that cannot be had leaves the page's placeholder. The links come from
// whatever the extension read off a page, so only Facebook's image CDN is
// ever asked.

const flog = log.child({ module: 'fbChatMedia' });

const CONCURRENCY = 2;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
// Beyond this the backlog is not worth keeping: its links will have expired
// before it is reached.
const MAX_QUEUED = 500;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

let fetcher: Fetcher = (url, init) => fetch(url, init);

/** Replaces the network in tests; null restores `fetch`. */
export function setFbChatMediaFetchForTests(f: Fetcher | null): void {
  fetcher = f ?? ((url, init) => fetch(url, init));
}

/** A link the hub may fetch: https on a Facebook CDN host, on the default port. */
export function isFbcdnUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.port === '' && !u.username && !u.password && u.hostname.endsWith('.fbcdn.net');
}

/** The link without its signature, for the log. */
const bare = (raw: string) => {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(not a url)';
  }
};

class FetchRefused extends Error {}

/** The photo's bytes and declared type, within the upload limit. */
async function download(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let at = url;
  for (let hop = 0; ; hop++) {
    if (!isFbcdnUrl(at)) throw new FetchRefused('not a Facebook CDN link');
    const res = await fetcher(at, { redirect: 'manual', signal, headers: { accept: 'image/*' } });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      const location = res.headers.get('location');
      if (!location || hop >= MAX_REDIRECTS) throw new FetchRefused(`redirect ${res.status}`);
      at = new URL(location, at).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new FetchRefused(`status ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (declared > FB_CHAT_MEDIA_MAX_UPLOAD_BYTES) {
      await res.body?.cancel();
      throw new FetchRefused('too large');
    }
    return { bytes: await readCapped(res), mime: res.headers.get('content-type') ?? '' };
  }
}

/** The body, refused once it passes the upload limit, whatever the headers said. */
async function readCapped(res: Response): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > FB_CHAT_MEDIA_MAX_UPLOAD_BYTES) {
      await reader.cancel();
      throw new FetchRefused('too large');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** Stores what it can of one message's photos and records them, in bubble order. */
async function fillMessage(sql: SqlLike, env: Env, job: FbChatMissingMedia): Promise<boolean> {
  const ids: string[] = [];
  for (const url of job.urls) {
    try {
      const { bytes, mime } = await download(url);
      ids.push((await storeFbChatMedia(sql, env, bytes, mime, 'facebook')).id);
    } catch (e) {
      flog.warn('fb chat photo fetch failed', {
        messageId: job.messageId, url: bare(url), error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (!ids.length) return false;
  // An extension that uploaded the photos in the meantime has the last word.
  const updated = await sql`
    UPDATE fb_chat_messages SET media = ${sql.json(ids)} WHERE id = ${job.messageId} AND media = '[]'::jsonb`;
  return updated.count > 0;
}

type Job = { sql: SqlLike; env: Env; job: FbChatMissingMedia; onFilled: () => void };

const queue: Job[] = [];
let running = 0;
let idle: (() => void)[] = [];

function pump(): void {
  while (running < CONCURRENCY && queue.length) {
    const next = queue.shift()!;
    running += 1;
    void fillMessage(next.sql, next.env, next.job)
      .then((filled) => { if (filled) next.onFilled(); })
      .catch((e) => flog.error('fb chat photo store failed', { messageId: next.job.messageId, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        running -= 1;
        pump();
        if (!running && !queue.length) {
          const waiting = idle;
          idle = [];
          for (const resolve of waiting) resolve();
        }
      });
  }
}

/**
 * Fetches the photos of messages stored without them, in the background.
 * Call it after the sync's transaction commits; `onFilled` runs for each
 * message that got at least one photo.
 */
export function queueFbChatMediaFetch(sql: SqlLike, env: Env, jobs: FbChatMissingMedia[], onFilled: () => void = () => {}): void {
  for (const job of jobs) {
    const urls = job.urls.filter(isFbcdnUrl);
    if (!urls.length) continue;
    if (queue.length >= MAX_QUEUED) {
      flog.warn('fb chat photo fetch backlog full; dropping', { messageId: job.messageId });
      continue;
    }
    queue.push({ sql, env, job: { messageId: job.messageId, urls }, onFilled });
  }
  pump();
}

/** Resolves once every queued fetch has settled. For tests. */
export function fbChatMediaFetchesSettled(): Promise<void> {
  if (!running && !queue.length) return Promise.resolve();
  return new Promise((resolve) => idle.push(resolve));
}

// -- sweep ---------------------------------------------------------------------
//
// A sync fetches only the rows it adds. A message stored while its photos
// could not be had (the hub refused WebP before 1.462.1, an upload failed)
// would otherwise keep its placeholder until the extension reads the chat again,
// which it does only when something new arrives there. The sweep retries them
// while Facebook's links still work.

const SWEEP_EVERY_MS = 10 * 60_000;
const SWEEP_BATCH = 40;
const SWEEP_RETRY_MS = 6 * 60 * 60_000;
/** Facebook's signed links last about two weeks. */
const SWEEP_MAX_AGE_DAYS = 14;
const swept = new Map<number, number>();

/**
 * Queues the photos of recent messages stored without them and answers how
 * many messages were queued. A link that appears in more than one message of
 * the chat is the sender's avatar, which older extensions took for a photo,
 * and is left out.
 */
export async function sweepFbChatPhotos(sql: SqlLike, env: Env, onFilled: () => void = () => {}, now = Date.now()): Promise<number> {
  const rows = await sql<{ id: number; urls: string[] }[]>`
    WITH links AS (
      SELECT m.id, m.thread_id, l.url, l.n, split_part(l.url, '?', 1) AS path
        FROM fb_chat_messages m, jsonb_array_elements_text(m.images) WITH ORDINALITY AS l(url, n)
       WHERE m.direction = 'in' AND m.images <> '[]'::jsonb
         AND m.created_at > NOW() - make_interval(days => ${SWEEP_MAX_AGE_DAYS})
    ), shared AS (
      SELECT thread_id, path FROM links GROUP BY thread_id, path HAVING COUNT(DISTINCT id) > 1
    )
    SELECT l.id::int AS id, array_agg(l.url ORDER BY l.n) AS urls
      FROM links l JOIN fb_chat_messages m ON m.id = l.id
     WHERE m.media = '[]'::jsonb
       AND NOT EXISTS (SELECT 1 FROM shared s WHERE s.thread_id = l.thread_id AND s.path = l.path)
     GROUP BY l.id
     ORDER BY l.id DESC`;
  const due = rows.filter((r) => now - (swept.get(r.id) ?? 0) >= SWEEP_RETRY_MS).slice(0, SWEEP_BATCH);
  for (const r of due) swept.set(r.id, now);
  queueFbChatMediaFetch(sql, env, due.map((r) => ({ messageId: r.id, urls: r.urls })), onFilled);
  return due.length;
}

/** Forgets which messages the sweep tried. For tests. */
export function resetFbChatPhotoSweepForTests(): void {
  swept.clear();
}

export function startFbChatPhotoSweepLoop(sql: SqlLike, env: Env, onFilled: () => void): { stop(): void } {
  const run = () => {
    sweepFbChatPhotos(sql, env, onFilled)
      .then((n) => { if (n) flog.info('fb chat photo sweep queued', { messages: n }); })
      .catch((e) => flog.error('fb chat photo sweep failed', e));
  };
  const first = setTimeout(run, 30_000);
  const handle = setInterval(run, SWEEP_EVERY_MS);
  first.unref?.();
  handle.unref?.();
  return { stop() { clearTimeout(first); clearInterval(handle); } };
}
