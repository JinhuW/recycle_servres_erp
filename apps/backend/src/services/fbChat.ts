import {
  FB_CHAT_SEND_STALE_MS,
  type FbChatAccountRef,
  type FbChatBuyer,
  type FbChatBuyerPush,
  type FbChatClaimAnswer,
  type FbChatEventPush,
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

type Msg = { direction: string; body: string };
/** The extension reads a bubble line by line, trimmed and without blank lines; compare what both sides keep. */
const flatBody = (body: string) => body.replace(/\s+/g, ' ').trim();
const sameMsg = (a: Msg, b: Msg) => a.direction === b.direction && flatBody(a.body) === flatBody(b.body);

/**
 * How many of the window's first messages are already the stored
 * conversation's last ones: the longest suffix of `stored` that is a prefix of
 * `window`. It matches whole runs, so two identical messages in a row stay two.
 */
export function alignWindow(stored: Msg[], window: Msg[]): number {
  for (let k = Math.min(stored.length, window.length); k > 0; k--) {
    let ok = true;
    for (let i = 0; i < k && ok; i++) ok = sameMsg(stored[stored.length - k + i]!, window[i]!);
    if (ok) return k;
  }
  return 0;
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

/** One conversation window from an extension. */
export async function ingestSync(tx: Tx, push: FbChatSyncPush, clientId: string): Promise<FbChatSyncAnswer> {
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
  if (isNew && !t.full) return { needsFull: true, added: 0 };
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

  const stored = (await tx<{ direction: string; body: string }[]>`
    SELECT direction, body FROM fb_chat_messages
     WHERE thread_id = ${threadId} AND seq IS NOT NULL
     ORDER BY seq DESC LIMIT ${ALIGN_TAIL}`).reverse();
  const window = t.rows.map((r) => ({ direction: r.direction, body: r.text }));
  const known = alignWindow(stored, window);
  const fresh = t.rows.slice(known);
  if (stored.length && !known && fresh.length) {
    await addEvent(tx, acct.id, threadId, 'sync_gap', { stored: stored.length, rows: t.rows.length });
  }

  // Replies of ours that have not been placed in the conversation yet. One
  // put back in the outbox after an attempt counts: that attempt may have
  // landed, and finding its bubble here is what stops it being typed again.
  const pending = await tx<{ id: number; body: string; send_state: string }[]>`
    SELECT id::int AS id, body, send_state FROM fb_chat_messages
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
  for (const row of fresh) {
    seq += 1;
    const ours = row.direction === 'out'
      ? pending.findIndex((m) => flat(row.text).includes(flat(m.body).slice(0, PROBE_CHARS)))
      : -1;
    if (ours >= 0) {
      // The bubble is on the page, whatever the extension went on to report.
      const [m] = pending.splice(ours, 1);
      if (m!.send_state === 'sending') await notifyOutbox(tx);
      await tx`
        UPDATE fb_chat_messages SET seq = ${seq}, send_state = 'sent', sent_at = COALESCE(sent_at, NOW()), error = NULL,
               acked_at = CASE WHEN send_state = 'sent' THEN acked_at ELSE NULL END
         WHERE id = ${m!.id}`;
      outbound = true;
      answeredSeq = seq;
      continue;
    }
    await tx`
      INSERT INTO fb_chat_messages (thread_id, seq, direction, source, body, images, backfill, fb_sent_label)
      VALUES (${threadId}, ${seq}, ${row.direction}, 'facebook', ${row.text},
              ${tx.json(row.images)}, ${isNew}, ${row.at ?? null})`;
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
  return { needsFull: false, added };
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
 */
export async function claimReply(tx: Tx, ref: FbChatAccountRef, clientId: string): Promise<FbChatClaimAnswer | null> {
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
  const [claimed] = await tx<FbChatClaimAnswer[]>`
    UPDATE fb_chat_messages m SET send_state = 'sending', claimed_at = NOW(), attempts = attempts + 1
      FROM fb_chat_threads t
     WHERE t.id = m.thread_id
       AND m.id = (
         SELECT q.id FROM fb_chat_messages q JOIN fb_chat_threads qt ON qt.id = q.thread_id
          WHERE qt.account_id = ${acct.id} AND q.send_state = 'queued'
            AND NOT EXISTS (
              SELECT 1 FROM fb_chat_messages s JOIN fb_chat_threads st ON st.id = s.thread_id
               WHERE st.account_id = ${acct.id} AND s.send_state = 'sending')
          ORDER BY q.id LIMIT 1 FOR UPDATE OF q SKIP LOCKED)
    RETURNING m.id::int AS id, t.fb_thread_id AS "fbThreadId", m.body, m.attempts AS attempt`;
  return claimed ?? null;
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
