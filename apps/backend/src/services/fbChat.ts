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
import { alignWindow } from './fbSellerReports';

// The store behind the Facebook chat hub. Extensions push conversation
// windows; this aligns each one against what is stored, keeps the new
// messages, and hands out the replies typed in Telegram. Telegram itself is
// fbChatTelegram.ts, which only reads what this writes.

type Tx = postgres.TransactionSql;

// How much of a conversation's tail a window is aligned against.
const ALIGN_TAIL = 400;
// Enough of a reply to recognise it in a bubble Facebook may have rewrapped.
const PROBE_CHARS = 60;

const flat = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

async function addEvent(
  tx: SqlLike, accountId: number | null, threadId: number | null, kind: string,
  detail: Record<string, unknown> = {}, alert: string | null = null,
): Promise<void> {
  await tx`
    INSERT INTO fb_chat_events (account_id, thread_id, kind, detail, alert)
    VALUES (${accountId}, ${threadId}, ${kind}, ${tx.json(detail as postgres.JSONValue)}, ${alert})`;
}

type AccountRow = { id: number; label: string; restricted: string | null };

/** The account's row, created on first sight. Every push goes through here. */
export async function touchAccount(tx: SqlLike, ref: FbChatAccountRef, clientId: string): Promise<AccountRow> {
  const [row] = await tx<AccountRow[]>`
    INSERT INTO fb_chat_accounts (fb_uid, label, client_id, ext_version)
    VALUES (${ref.fbUid}, ${ref.label}, ${clientId}, ${ref.extVersion ?? null})
    ON CONFLICT (fb_uid) DO UPDATE SET
      label = CASE WHEN EXCLUDED.label <> '' THEN EXCLUDED.label ELSE fb_chat_accounts.label END,
      client_id = EXCLUDED.client_id,
      ext_version = COALESCE(EXCLUDED.ext_version, fb_chat_accounts.ext_version),
      last_seen_at = NOW()
    RETURNING id::int AS id, label, restricted`;
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

  // Replies from Telegram that have not been placed in the conversation yet.
  const pending = await tx<{ id: number; body: string; send_state: string }[]>`
    SELECT id::int AS id, body, send_state FROM fb_chat_messages
     WHERE thread_id = ${threadId} AND seq IS NULL AND send_state IN ('sending','sent','uncertain')
     ORDER BY id`;
  let seq = thread!.last_seq;
  let added = 0;
  let inbound = false;
  let outbound = false;
  for (const row of fresh) {
    seq += 1;
    const ours = row.direction === 'out'
      ? pending.findIndex((m) => flat(row.text).includes(flat(m.body).slice(0, PROBE_CHARS)))
      : -1;
    if (ours >= 0) {
      // The bubble is on the page, whatever the extension went on to report.
      const [m] = pending.splice(ours, 1);
      await tx`
        UPDATE fb_chat_messages SET seq = ${seq}, send_state = 'sent', sent_at = COALESCE(sent_at, NOW()), error = NULL,
               acked_at = CASE WHEN send_state = 'sent' THEN acked_at ELSE NULL END
         WHERE id = ${m!.id}`;
      outbound = true;
      continue;
    }
    await tx`
      INSERT INTO fb_chat_messages (thread_id, seq, direction, source, body, images, backfill)
      VALUES (${threadId}, ${seq}, ${row.direction}, 'facebook', ${row.text},
              ${tx.json(row.images)}, ${isNew})`;
    added += 1;
    if (!isNew) {
      if (row.direction === 'in') inbound = true;
      else outbound = true;
    }
  }
  await tx`
    UPDATE fb_chat_threads SET
      last_seq = ${seq}, last_synced_at = NOW(),
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
    RETURNING m.id::int AS id, t.fb_thread_id AS "fbThreadId", m.body`;
  return claimed ?? null;
}

export type ResultOutcome = 'ok' | 'not_found' | 'not_sending';

export async function recordSendResult(tx: Tx, id: number, r: FbChatSendResult, clientId: string): Promise<ResultOutcome> {
  const acct = await touchAccount(tx, r.account, clientId);
  const [m] = await tx<{ thread_id: number; send_state: string; seq: number | null; attempts: number }[]>`
    SELECT m.thread_id::int AS thread_id, m.send_state, m.seq, m.attempts
      FROM fb_chat_messages m JOIN fb_chat_threads t ON t.id = m.thread_id
     WHERE m.id = ${id} AND t.account_id = ${acct.id} AND m.source = 'telegram'
       FOR UPDATE OF m`;
  if (!m) return 'not_found';
  // A sync may already have found the bubble and settled it; that stands.
  if (m.send_state === 'sent' && m.seq !== null) return 'ok';
  if (m.send_state !== 'sending') return 'not_sending';
  if (r.outcome === 'sent') {
    const [t] = await tx<{ last_seq: number }[]>`
      UPDATE fb_chat_threads SET last_seq = last_seq + 1, last_outbound_at = NOW() WHERE id = ${m.thread_id}
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
    return;
  }
  await addEvent(tx, acct.id, thread?.id ?? null, 'error', push.detail ?? {});
}
