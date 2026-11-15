import {
  FB_CHAT_SEND_STALE_MS,
  type FbChatAccountRef,
  type FbChatBuyer,
  type FbChatBuyerPush,
  type FbChatCap,
  type FbChatClaimAnswer,
  type FbChatEventPush,
  type FbChatOutMedia,
  type FbChatRow,
  type FbChatSendResult,
  type FbChatSyncAnswer,
  type FbChatSyncPush,
} from '@recycle-erp/shared';
import type postgres from 'postgres';
import type { SqlLike } from '../db';

// The store behind the Facebook chat hub. Extensions push conversation
// windows; this aligns each one against what is stored, keeps the new
// messages, and hands out the replies typed in Telegram or in the ERP (the
// page's own reads and writes are fbChatPage.ts). Telegram itself is
// fbChatTelegram.ts, which only reads what this writes.

type Tx = postgres.TransactionSql;

// How much of a conversation's tail a window is aligned against.
const ALIGN_TAIL = 400;
// Enough of a reply to recognise it in a bubble Facebook may have rewrapped.
const PROBE_CHARS = 60;

const flat = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * A message as alignment compares it. `split`: a reply of ours with photos and
 * a caption, which Facebook may show as one bubble or as a photo bubble and a
 * caption bubble in either order. `photo`: a window row that shows a photo.
 */
type Msg = { direction: string; body: string; split?: boolean; photo?: boolean };
/** The extension reads a bubble line by line, trimmed and without blank lines; compare what both sides keep. */
const flatBody = (body: string) => body.replace(/\s+/g, ' ').trim();
const sameMsg = (a: Msg, b: Msg) => a.direction === b.direction && flatBody(a.body) === flatBody(b.body);
const barePhoto = (r: Msg) => r.direction === 'out' && r.photo === true && flatBody(r.body) === '';
const captionOf = (m: Msg, r: Msg) => r.direction === 'out' && !r.photo && sameMsg(m, r);

/** The window rows one stored message covers, as [first row, count]. */
export type AlignSpan = [number, number];

/**
 * Lays `stored[s..]` over `window[w..]`, each message on the rows it covers,
 * and answers the row after the last, or -1. A split reply may cover two rows;
 * as the first message laid it may also show only its second, the window
 * having begun between them.
 */
function lay(stored: Msg[], s: number, window: Msg[], w: number, spans: AlignSpan[]): number {
  if (s === stored.length) return w;
  const m = stored[s]!;
  const a = window[w];
  if (!a) return -1;
  const counts: number[] = [];
  const b = window[w + 1];
  if (m.split && b && ((barePhoto(a) && captionOf(m, b)) || (captionOf(m, a) && barePhoto(b)))) counts.push(2);
  if (sameMsg(m, a) || (m.split && spans.length === 0 && barePhoto(a))) counts.push(1);
  for (const n of counts) {
    spans.push([w, n]);
    const end = lay(stored, s + 1, window, w + n, spans);
    if (end >= 0) return end;
    spans.pop();
  }
  return -1;
}

/**
 * How many of the window's first rows are already the stored conversation's
 * last messages: the longest suffix of `stored` laid exactly over a prefix of
 * `window`. It matches whole runs, so two identical messages in a row stay
 * two. `spans` are the rows each message of that suffix covers.
 */
export function alignWindowSpans(stored: Msg[], window: Msg[]): { rows: number; spans: AlignSpan[] } {
  for (let k = Math.min(stored.length, window.length); k > 0; k--) {
    const spans: AlignSpan[] = [];
    const rows = lay(stored, stored.length - k, window, 0, spans);
    if (rows >= 0) return { rows, spans };
  }
  return { rows: 0, spans: [] };
}

export const alignWindow = (stored: Msg[], window: Msg[]): number => alignWindowSpans(stored, window).rows;

/** A reply of ours waiting to be found on the page. `media`: how many photos it carries. */
export type PendingReply = { id: number; body: string; send_state: string; media: number };

const probeOf = (body: string) => flat(body).slice(0, PROBE_CHARS);
const isPhotoRow = (r: FbChatRow) => r.images.length > 0 || (r.media?.length ?? 0) > 0;
const isBarePhotoRow = (r: FbChatRow) => isPhotoRow(r) && flat(r.text) === '';
// An empty probe is in every text, so it never says anything.
const shows = (r: FbChatRow, probe: string) => probe !== '' && flat(r.text).includes(probe);

/**
 * Which pending reply the outbound row `rows[i]` is, if any, and how many rows
 * it covers: two when Facebook put a photo reply's caption in its own bubble,
 * right before or after the photo. A reply with photos is found by a photo, a
 * text reply by its text; neither by text that is empty.
 */
export function findReply(pending: PendingReply[], rows: FbChatRow[], i: number): { index: number; rows: 1 | 2 } | null {
  const row = rows[i]!;
  const next = rows[i + 1]?.direction === 'out' ? rows[i + 1] : undefined;
  const photos = pending.flatMap((m, index) => (m.media > 0 ? [{ index, probe: probeOf(m.body) }] : []));
  if (isPhotoRow(row)) {
    for (const p of photos) {
      if (shows(row, p.probe)) return { index: p.index, rows: 1 };
      if (isBarePhotoRow(row) && next && !isPhotoRow(next) && shows(next, p.probe)) return { index: p.index, rows: 2 };
    }
    if (isBarePhotoRow(row)) {
      // A caption not seen here may still come in a later window, where
      // alignment takes it as this reply's.
      const p = photos.find((x) => x.probe === '') ?? photos[0];
      if (p) return { index: p.index, rows: 1 };
    }
  } else if (next && isBarePhotoRow(next)) {
    const p = photos.find((x) => shows(row, x.probe));
    if (p) return { index: p.index, rows: 2 };
  }
  const text = pending.findIndex((m) => m.media === 0 && shows(row, probeOf(m.body)));
  return text >= 0 ? { index: text, rows: 1 } : null;
}

/** The channel a held outbox claim sleeps on (lib/pgWake.ts). */
export const FB_CHAT_OUTBOX_CHANNEL = 'fb_chat_outbox';

/**
 * Wakes held claims: a reply was queued, or a send settled and the account's
 * next one may go. Sent through the writer's own handle so that, inside a
 * transaction, it is delivered at commit.
 */
export async function notifyOutbox(sql: SqlLike): Promise<void> {
  await sql`SELECT pg_notify(${FB_CHAT_OUTBOX_CHANNEL}, '')`;
}

async function addEvent(
  tx: SqlLike, accountId: number | null, threadId: number | null, kind: string,
  detail: Record<string, unknown> = {}, alert: string | null = null,
): Promise<void> {
  await tx`
    INSERT INTO fb_chat_events (account_id, thread_id, kind, detail, alert)
    VALUES (${accountId}, ${threadId}, ${kind}, ${tx.json(detail as postgres.JSONValue)}, ${alert})`;
}

type AccountRow = { id: number; label: string; restricted: string | null };

const DEVICE_CLIENT = 'device:';

/**
 * Thrown when a push names an account another approved Chrome relays. The
 * device bearer proves which Chrome is pushing, not which Facebook user: the
 * account moves only once its own device is revoked, or through approveDevice.
 */
export class FbChatAccountTaken extends Error {
  constructor() {
    super('account_relayed_by_another_device');
  }
}

/**
 * The account's row, created on first sight. Every push goes through here, so
 * the common path is a plain UPDATE: an upsert would burn an id on each one.
 * Needs a transaction: a new account takes its display number under a lock.
 */
export async function touchAccount(tx: Tx, ref: FbChatAccountRef, clientId: string): Promise<AccountRow> {
  const extVersion = ref.extVersion ?? null;
  const deviceId = clientId.startsWith(DEVICE_CLIENT) ? clientId.slice(DEVICE_CLIENT.length) : null;
  // A name a manager gave outlives the extension repeating its profile label.
  const [seen] = await tx<(AccountRow & { was_client: string | null })[]>`
    UPDATE fb_chat_accounts a SET
      label = CASE WHEN NOT a.label_locked AND ${ref.label} <> '' THEN ${ref.label} ELSE a.label END,
      client_id = ${clientId},
      ext_version = COALESCE(${extVersion}, a.ext_version),
      last_seen_at = NOW()
    FROM (SELECT id, client_id FROM fb_chat_accounts WHERE fb_uid = ${ref.fbUid} FOR UPDATE) o
    WHERE a.id = o.id
      AND (o.client_id IS NOT DISTINCT FROM ${clientId} OR NOT EXISTS (
        SELECT 1 FROM fb_chat_devices d
         WHERE ${DEVICE_CLIENT} || d.id = o.client_id AND d.status = 'approved'))
    RETURNING a.id::int AS id, a.label, a.restricted, o.client_id AS was_client`;
  if (seen) {
    // This Chrome takes over an account the hub already had, which keeps its
    // own name and pause, as when approveDevice finds the account at approval.
    if (deviceId !== null && seen.was_client !== clientId) {
      await tx`
        UPDATE fb_chat_devices SET account_label = NULL, start_paused = FALSE
         WHERE id = ${deviceId} AND (account_label IS NOT NULL OR start_paused)`;
    }
    return { id: seen.id, label: seen.label, restricted: seen.restricted };
  }
  const [held] = await tx`SELECT 1 FROM fb_chat_accounts WHERE fb_uid = ${ref.fbUid}`;
  if (held) throw new FbChatAccountTaken();

  // What the manager chose when approving this Chrome, kept until now because
  // the Facebook user was not necessarily known then.
  const [device] = deviceId === null ? [] : await tx<{ account_label: string | null; start_paused: boolean; decided_by: string | null }[]>`
    SELECT account_label, start_paused, decided_by FROM fb_chat_devices WHERE id = ${deviceId}`;
  const named = device?.account_label ?? null;
  // Two new accounts at once would otherwise read the same highest number.
  await tx`SELECT pg_advisory_xact_lock(hashtextextended('fb-chat-account-no', 0))`;
  const [row] = await tx<(AccountRow & { created: boolean })[]>`
    INSERT INTO fb_chat_accounts (fb_uid, label, label_locked, client_id, ext_version, no)
    VALUES (${ref.fbUid}, ${named ?? ref.label}, ${named !== null}, ${clientId}, ${extVersion},
            (SELECT COALESCE(MAX(no), 0) + 1 FROM fb_chat_accounts))
    ON CONFLICT (fb_uid) DO UPDATE SET
      label = CASE WHEN NOT fb_chat_accounts.label_locked AND ${ref.label} <> '' THEN ${ref.label} ELSE fb_chat_accounts.label END,
      client_id = EXCLUDED.client_id,
      ext_version = COALESCE(EXCLUDED.ext_version, fb_chat_accounts.ext_version),
      last_seen_at = NOW()
    RETURNING id::int AS id, label, restricted, (xmax = 0) AS created`;
  if (row!.created && device && (named !== null || device.start_paused)) {
    if (device.start_paused) {
      await tx`
        INSERT INTO fb_chat_config (account_id, key, value, updated_by)
        VALUES (${row!.id}, 'paused', ${tx.json(true)}, ${device.decided_by})`;
    }
    // Applied once: a later account from the same Chrome is not this one.
    await tx`UPDATE fb_chat_devices SET account_label = NULL, start_paused = FALSE WHERE id = ${deviceId}`;
  }
  return row!;
}

/** Stores what is known of a buyer; a changed rating is an event. */
async function upsertBuyer(tx: SqlLike, accountId: number, threadId: number, b: FbChatBuyer): Promise<number | null> {
  if (!b.profileId) return null;
  const [before] = await tx<{ rating: string | null; rating_count: number | null }[]>`
    SELECT rating, rating_count FROM fb_chat_buyers WHERE fb_profile_id = ${b.profileId}`;
  const [row] = await tx<{ id: number; rating: string | null; rating_count: number | null }[]>`
    INSERT INTO fb_chat_buyers (fb_profile_id, name, location, joined_year, rating, rating_count)
    VALUES (${b.profileId}, ${b.name}, ${b.location}, ${b.joinedYear}, ${b.rating}, ${b.ratingCount})
    ON CONFLICT (fb_profile_id) DO UPDATE SET
      name = COALESCE(EXCLUDED.name, fb_chat_buyers.name),
      location = COALESCE(EXCLUDED.location, fb_chat_buyers.location),
      joined_year = COALESCE(EXCLUDED.joined_year, fb_chat_buyers.joined_year),
      rating = COALESCE(EXCLUDED.rating, fb_chat_buyers.rating),
      rating_count = COALESCE(EXCLUDED.rating_count, fb_chat_buyers.rating_count),
      updated_at = NOW()
    RETURNING id::int AS id, rating, rating_count`;
  const was = { rating: before?.rating == null ? null : Number(before.rating), count: before?.rating_count ?? null };
  const now = { rating: row!.rating == null ? null : Number(row!.rating), count: row!.rating_count };
  if (now.rating !== was.rating || now.count !== was.count) {
    await addEvent(tx, accountId, threadId, 'buyer_rating', {
      buyer_id: row!.id, rating: now.rating, rating_count: now.count,
      previous_rating: was.rating, previous_rating_count: was.count,
    });
  }
  return row!.id;
}

async function applyBuyer(tx: SqlLike, accountId: number, threadId: number, b: FbChatBuyer): Promise<void> {
  const buyerId = await upsertBuyer(tx, accountId, threadId, b);
  // A topic is named after the buyer and their location. Clearing the stored
  // name is what tells the Telegram pass to rename it.
  await tx`
    UPDATE fb_chat_threads SET
      buyer_id = COALESCE(${buyerId}, buyer_id),
      buyer_name = COALESCE(${b.name}, buyer_name),
      buyer_location = COALESCE(${b.location}, buyer_location),
      telegram_topic_name = CASE
        WHEN COALESCE(${b.name}, buyer_name) IS DISTINCT FROM buyer_name
          OR COALESCE(${b.location}, buyer_location) IS DISTINCT FROM buyer_location
        THEN NULL ELSE telegram_topic_name END
    WHERE id = ${threadId}`;
}

/** A stored message whose photos the hub should fetch itself, from `urls`. */
export type FbChatMissingMedia = { messageId: number; urls: string[] };

export type FbChatSyncOutcome = {
  answer: FbChatSyncAnswer;
  /** New rows with links but no stored photo: an extension that predates media, or whose upload failed. */
  missingMedia: FbChatMissingMedia[];
};

/** The ids among `ids` that name a stored photo. */
async function storedMediaIds(tx: SqlLike, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await tx<{ id: string }[]>`
    SELECT id::text AS id FROM fb_chat_media WHERE id = ANY(${[...new Set(ids)]}::uuid[])`;
  return new Set(rows.map((r) => r.id));
}

/** One conversation window from an extension. */
export async function ingestSync(tx: Tx, push: FbChatSyncPush, clientId: string): Promise<FbChatSyncOutcome> {
  const acct = await touchAccount(tx, push.account, clientId);
  // A page that reads as a conversation again is an account that is back.
  if (acct.restricted) {
    await tx`UPDATE fb_chat_accounts SET restricted = NULL, restricted_at = NULL WHERE id = ${acct.id}`;
    await addEvent(tx, acct.id, null, 'recovered', {}, `✅ ${acct.label || push.account.fbUid}: Facebook is reachable again.`);
    await notifyOutbox(tx);
  }
  const t = push.thread;
  let [thread] = await tx<{ id: number; last_seq: number }[]>`
    SELECT id::int AS id, last_seq FROM fb_chat_threads
     WHERE account_id = ${acct.id} AND fb_thread_id = ${t.fbThreadId} FOR UPDATE`;
  const isNew = !thread;
  // A topic opens with the conversation so far, so a new thread is stored
  // only from a push that tried to read all of it.
  if (isNew && !t.full) return { answer: { needsFull: true, added: 0 }, missingMedia: [] };
  if (!thread) {
    [thread] = await tx<{ id: number; last_seq: number }[]>`
      INSERT INTO fb_chat_threads (account_id, fb_thread_id, listing_id, listing_title, history_complete)
      VALUES (${acct.id}, ${t.fbThreadId}, ${t.listing.id}, ${t.listing.title}, ${t.complete})
      ON CONFLICT (account_id, fb_thread_id) DO UPDATE SET fb_thread_id = EXCLUDED.fb_thread_id
      RETURNING id::int AS id, last_seq`;
    await addEvent(tx, acct.id, thread!.id, 'thread_seen', { rows: t.rows.length, complete: t.complete });
  } else {
    await tx`
      UPDATE fb_chat_threads SET
        listing_id = COALESCE(${t.listing.id}, listing_id),
        listing_title = COALESCE(${t.listing.title}, listing_title),
        history_complete = history_complete OR ${t.complete}
      WHERE id = ${thread.id}`;
  }
  const threadId = thread!.id;
  await applyBuyer(tx, acct.id, threadId, t.buyer);

  const stored = (await tx<{ id: number; direction: string; source: string; body: string; images: number; media: number }[]>`
    SELECT id::int AS id, direction, source, body, jsonb_array_length(images) AS images, jsonb_array_length(media) AS media
      FROM fb_chat_messages
     WHERE thread_id = ${threadId} AND seq IS NOT NULL
     ORDER BY seq DESC LIMIT ${ALIGN_TAIL}`).reverse();
  const window = t.rows.map((r) => ({ direction: r.direction, body: r.text, photo: isPhotoRow(r) }));
  const aligned = alignWindowSpans(stored.map((m) => ({
    direction: m.direction, body: m.body,
    split: m.direction === 'out' && m.source !== 'facebook' && m.media > 0 && flatBody(m.body) !== '',
  })), window);
  const known = aligned.rows;
  const fresh = t.rows.slice(known);

  // An id the extension sends is kept only once the photo is stored, so a
  // failed or forged upload leaves the bubble's placeholder.
  const present = await storedMediaIds(tx, t.rows.flatMap((r) => r.media ?? []));
  const mediaOf = (r: FbChatRow) => (r.media ?? []).filter((m) => present.has(m));
  // The window's first `known` rows are the stored tail's last messages, in
  // order. A photo bubble stored before its photos could be uploaded takes
  // them from this push.
  const tailStart = stored.length - aligned.spans.length;
  for (const [i, [first, count]] of aligned.spans.entries()) {
    if (count !== 1) continue;
    const old = stored[tailStart + i]!;
    const media = mediaOf(t.rows[first]!);
    if (old.images > 0 && old.media === 0 && media.length) {
      await tx`UPDATE fb_chat_messages SET media = ${tx.json(media)} WHERE id = ${old.id} AND media = '[]'::jsonb`;
    }
  }
  const missingMedia: FbChatMissingMedia[] = [];
  if (stored.length && !known && fresh.length) {
    await addEvent(tx, acct.id, threadId, 'sync_gap', { stored: stored.length, rows: t.rows.length });
  }

  // Replies of ours that have not been placed in the conversation yet. One
  // put back in the outbox after an attempt counts: that attempt may have
  // landed, and finding its bubble here is what stops it being typed again.
  const pending = await tx<PendingReply[]>`
    SELECT id::int AS id, body, send_state, jsonb_array_length(media) AS media FROM fb_chat_messages
     WHERE thread_id = ${threadId} AND seq IS NULL
       AND (send_state IN ('sending','sent','uncertain') OR (send_state = 'queued' AND attempts > 0))
     ORDER BY id`;
  let seq = thread!.last_seq;
  let added = 0;
  let inbound = false;
  let outbound = false;
  // The shared read mark: a buyer's message moves the unread position, and
  // anything of ours after it counts as having answered. History read on
  // first sight counts too, so a chat found ending with the buyer is unread.
  let inboundSeq: number | null = null;
  let answeredSeq = 0;
  for (let i = 0; i < fresh.length; i++) {
    const row = fresh[i]!;
    seq += 1;
    const ours = row.direction === 'out' ? findReply(pending, fresh, i) : null;
    if (ours) {
      // The bubble is on the page, whatever the extension went on to report.
      const [m] = pending.splice(ours.index, 1);
      if (m!.send_state === 'sending') await notifyOutbox(tx);
      await tx`
        UPDATE fb_chat_messages SET seq = ${seq}, send_state = 'sent', sent_at = COALESCE(sent_at, NOW()), error = NULL,
               acked_at = CASE WHEN send_state = 'sent' THEN acked_at ELSE NULL END
         WHERE id = ${m!.id}`;
      // A caption in its own bubble is part of the reply, not a message: it
      // keeps its place in the count, so the next one lines up.
      if (ours.rows === 2) {
        i += 1;
        seq += 1;
      }
      outbound = true;
      answeredSeq = seq;
      continue;
    }
    const media = mediaOf(row);
    const [inserted] = await tx<{ id: number }[]>`
      INSERT INTO fb_chat_messages (thread_id, seq, direction, source, body, images, media, backfill, fb_sent_label)
      VALUES (${threadId}, ${seq}, ${row.direction}, 'facebook', ${row.text},
              ${tx.json(row.images)}, ${tx.json(media)}, ${isNew}, ${row.at ?? null})
      RETURNING id::int AS id`;
    if (row.images.length && !media.length) missingMedia.push({ messageId: inserted!.id, urls: row.images });
    added += 1;
    if (row.direction === 'in') inboundSeq = seq;
    else answeredSeq = seq;
    if (!isNew) {
      if (row.direction === 'in') inbound = true;
      else outbound = true;
    }
  }
  await tx`
    UPDATE fb_chat_threads SET
      last_seq = ${seq}, last_synced_at = NOW(),
      last_inbound_seq = COALESCE(${inboundSeq}, last_inbound_seq),
      read_seq = GREATEST(read_seq, ${answeredSeq}),
      last_inbound_at = CASE WHEN ${inbound} THEN NOW() ELSE last_inbound_at END,
      last_outbound_at = CASE WHEN ${outbound} THEN NOW() ELSE last_outbound_at END
    WHERE id = ${threadId}`;
  if (added && !isNew) await addEvent(tx, acct.id, threadId, 'sync', { added, known, rows: t.rows.length });
  return { answer: { needsFull: false, added }, missingMedia };
}

/** What the buyer's own profile page showed. False when the thread is unknown. */
export async function ingestBuyer(tx: Tx, push: FbChatBuyerPush, clientId: string): Promise<boolean> {
  const acct = await touchAccount(tx, push.account, clientId);
  const [thread] = await tx<{ id: number }[]>`
    SELECT id::int AS id FROM fb_chat_threads WHERE account_id = ${acct.id} AND fb_thread_id = ${push.fbThreadId}`;
  if (!thread) return false;
  await applyBuyer(tx, acct.id, thread.id, push.buyer);
  return true;
}

/**
 * The account's oldest queued reply, now `sending`, or null. One at a time per
 * account: a second reply waits until the first is reported.
 *
 * A reply with photos goes only to an extension whose `caps` say it can attach
 * them; an older one would type the caption and report it sent. It waits in
 * the outbox for one that can, and so do the replies queued after it in the
 * same chat, so the buyer reads them in the order they were written. Other
 * chats are not held.
 */
export async function claimReply(
  tx: Tx, ref: FbChatAccountRef, clientId: string, caps: readonly FbChatCap[] = [],
): Promise<FbChatClaimAnswer | null> {
  const acct = await touchAccount(tx, ref, clientId);
  // A claim never reported is not handed out again: the text may be on the
  // page, and a duplicate to a buyer is worse than a reply the owner resends.
  const stale = await tx<{ id: number; thread_id: number }[]>`
    UPDATE fb_chat_messages m SET send_state = 'uncertain', error = 'The browser never reported back'
      FROM fb_chat_threads t
     WHERE t.id = m.thread_id AND t.account_id = ${acct.id} AND m.send_state = 'sending'
       AND m.claimed_at < NOW() - make_interval(secs => ${FB_CHAT_SEND_STALE_MS / 1000})
    RETURNING m.id::int AS id, m.thread_id::int AS thread_id`;
  for (const m of stale) await addEvent(tx, acct.id, m.thread_id, 'send_uncertain', { message_id: m.id, reason: 'stale claim' });
  // The account's next reply may go now; wake claims held on other instances.
  if (stale.length) await notifyOutbox(tx);
  // A login or checkpoint page has no composer: replies wait, as the alert says.
  if (acct.restricted) return null;
  const textOnly = caps.includes('media') ? tx`` : tx`
    AND NOT EXISTS (
      SELECT 1 FROM fb_chat_messages p
       WHERE p.thread_id = q.thread_id AND p.send_state = 'queued' AND p.id <= q.id AND p.media <> '[]'::jsonb)`;
  const [claimed] = await tx<(Omit<FbChatClaimAnswer, 'media'> & { media_ids: string[] })[]>`
    UPDATE fb_chat_messages m SET send_state = 'sending', claimed_at = NOW(), attempts = attempts + 1
      FROM fb_chat_threads t
     WHERE t.id = m.thread_id
       AND m.id = (
         SELECT q.id FROM fb_chat_messages q JOIN fb_chat_threads qt ON qt.id = q.thread_id
          WHERE qt.account_id = ${acct.id} AND q.send_state = 'queued' ${textOnly}
            AND NOT EXISTS (
              SELECT 1 FROM fb_chat_messages s JOIN fb_chat_threads st ON st.id = s.thread_id
               WHERE st.account_id = ${acct.id} AND s.send_state = 'sending')
          ORDER BY q.id LIMIT 1 FOR UPDATE OF q SKIP LOCKED)
    RETURNING m.id::int AS id, t.fb_thread_id AS "fbThreadId", m.body, m.attempts AS attempt, m.media AS media_ids`;
  if (!claimed) return null;
  const { media_ids: ids, ...answer } = claimed;
  if (!ids.length) return answer;
  const media = await tx<FbChatOutMedia[]>`
    SELECT f.id::text AS id, f.mime, f.bytes
      FROM unnest(${ids}::uuid[]) WITH ORDINALITY AS x(id, n) JOIN fb_chat_media f ON f.id = x.id
     ORDER BY x.n`;
  return { ...answer, media };
}

/**
 * Whether the extension `clientId` may download photo `mediaId`: it is on a
 * reply of ours still going out, on a chat of an account that extension
 * relays. The bearer names the Chrome, and an account belongs to the Chrome
 * that last pushed for it (touchAccount), which is the one that claims its
 * replies. Done or failed replies are not served: there is nothing to attach.
 */
export async function outboundMediaAllowed(sql: SqlLike, mediaId: string, clientId: string): Promise<boolean> {
  const [hit] = await sql`
    SELECT 1 FROM fb_chat_accounts a
      JOIN fb_chat_threads t ON t.account_id = a.id
      JOIN fb_chat_messages m ON m.thread_id = t.id
     WHERE a.client_id = ${clientId} AND m.direction = 'out' AND m.source IN ('telegram', 'erp')
       AND m.send_state IN ('queued', 'sending', 'uncertain')
       AND m.media @> ${sql.json([mediaId])}
     LIMIT 1`;
  return hit !== undefined;
}

export type ResultOutcome = 'ok' | 'not_found' | 'not_sending';

export async function recordSendResult(tx: Tx, id: number, r: FbChatSendResult, clientId: string): Promise<ResultOutcome> {
  const acct = await touchAccount(tx, r.account, clientId);
  const [m] = await tx<{ thread_id: number; send_state: string; seq: number | null; attempts: number }[]>`
    SELECT m.thread_id::int AS thread_id, m.send_state, m.seq, m.attempts
      FROM fb_chat_messages m JOIN fb_chat_threads t ON t.id = m.thread_id
     WHERE m.id = ${id} AND t.account_id = ${acct.id} AND m.source IN ('telegram', 'erp')
       FOR UPDATE OF m`;
  if (!m) return 'not_found';
  // A sync may already have found the bubble and settled it; that stands.
  if (m.send_state === 'sent' && m.seq !== null) return 'ok';
  // A retried reply is queued again, and the browser's late word that the
  // earlier attempt did land settles it before it is typed a second time.
  const requeued = m.send_state === 'queued' && m.attempts > 0 && r.outcome === 'sent';
  if (m.send_state !== 'sending' && !requeued) return 'not_sending';
  // An earlier attempt, given up on and retried, reporting late. Only its
  // word that the reply landed still says something about the message.
  if (r.attempt !== undefined && r.attempt !== m.attempts && r.outcome !== 'sent') {
    await addEvent(tx, acct.id, m.thread_id, 'send_stale_result', {
      message_id: id, attempt: r.attempt, attempts: m.attempts, outcome: r.outcome,
    });
    return 'ok';
  }
  if (r.outcome === 'sent') {
    const [t] = await tx<{ last_seq: number }[]>`
      UPDATE fb_chat_threads SET
        last_seq = last_seq + 1, last_outbound_at = NOW(), read_seq = GREATEST(read_seq, last_seq + 1)
       WHERE id = ${m.thread_id}
      RETURNING last_seq`;
    await tx`
      UPDATE fb_chat_messages SET send_state = 'sent', sent_at = NOW(), seq = ${t!.last_seq},
             typing_ms = ${r.typingMs ?? null}, error = NULL
       WHERE id = ${id}`;
  } else {
    await tx`
      UPDATE fb_chat_messages SET send_state = ${r.outcome}, typing_ms = ${r.typingMs ?? null},
             error = ${r.error ?? (r.outcome === 'failed' ? 'The reply was not sent' : 'The reply may not have been sent')}
       WHERE id = ${id}`;
  }
  await addEvent(tx, acct.id, m.thread_id, `send_${r.outcome}`, {
    message_id: id, attempts: m.attempts, typing_ms: r.typingMs ?? null, error: r.error ?? null,
  });
  await notifyOutbox(tx);
  return 'ok';
}

export async function recordEvent(tx: Tx, push: FbChatEventPush, clientId: string): Promise<void> {
  const acct = await touchAccount(tx, push.account, clientId);
  const name = acct.label || push.account.fbUid;
  const [thread] = push.fbThreadId
    ? await tx<{ id: number }[]>`SELECT id::int AS id FROM fb_chat_threads WHERE account_id = ${acct.id} AND fb_thread_id = ${push.fbThreadId}`
    : [];
  if (push.kind === 'restricted') {
    const what = push.detail?.restriction === 'checkpoint' ? 'checkpoint' : 'login';
    // The extension repeats this while the page stays up; alert once.
    if (acct.restricted === what) return;
    await tx`UPDATE fb_chat_accounts SET restricted = ${what}, restricted_at = NOW() WHERE id = ${acct.id}`;
    await addEvent(tx, acct.id, null, 'restricted', push.detail ?? {},
      `⚠️ ${name}: Facebook is showing a ${what} page. Replies for this account wait until it is cleared in the browser.`);
    return;
  }
  if (push.kind === 'recovered') {
    if (!acct.restricted) return;
    await tx`UPDATE fb_chat_accounts SET restricted = NULL, restricted_at = NULL WHERE id = ${acct.id}`;
    await addEvent(tx, acct.id, null, 'recovered', {}, `✅ ${name}: Facebook is reachable again.`);
    await notifyOutbox(tx);
    return;
  }
  await addEvent(tx, acct.id, thread?.id ?? null, 'error', push.detail ?? {});
}
