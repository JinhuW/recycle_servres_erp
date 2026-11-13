import type {
  FbChatAccountDevice,
  FbChatAccountRow,
  FbChatAccountsAnswer,
  FbChatAlsoMessaged,
  FbChatLastMessage,
  FbChatMessageRow,
  FbChatSummary,
  FbChatThreadFilter,
  FbChatThreadRow,
} from '@recycle-erp/shared';
import type postgres from 'postgres';
import type { SqlLike } from '../db';
import { notifyOutbox } from './fbChat';
import { configsFor, latestExtVersion } from './fbChatConfig';

// What the Leads ▸ Facebook page reads and writes. The extensions never come
// here: their side is fbChat.ts, and a reply typed on the page joins the same
// outbox theirs claim from.

type Tx = postgres.TransactionSql;

const THREADS_MAX = 500;
// The extensions ask for their settings this often unless told otherwise.
const DEFAULT_CONFIG_POLL_SEC = 60;
const STALE_FLOOR_SEC = 300;

/** A t.me link to a topic. Only a supergroup (-100…) has topics and links. */
function topicUrl(chatId: string | undefined, topicId: number | null): string | null {
  const group = /^-100(\d+)$/.exec(chatId?.trim() ?? '');
  return group && topicId !== null ? `https://t.me/c/${group[1]}/${topicId}` : null;
}

// Who typed an outbound message, as far as the hub knows.
const authorSql = (sql: SqlLike, m: postgres.Fragment, u: postgres.Fragment) =>
  sql`CASE ${m}.source WHEN 'erp' THEN ${u}.name WHEN 'telegram' THEN ${m}.tg_user_name END`;

type ThreadDbRow = Omit<FbChatThreadRow, 'telegram_topic_url' | 'last_message'> & {
  lm_direction: FbChatLastMessage['direction'] | null;
  lm_source: FbChatLastMessage['source'];
  lm_author_name: string | null;
  lm_body: string;
  lm_images: number;
  lm_send_state: FbChatLastMessage['send_state'];
  lm_created_at: string;
};

export type ThreadQuery = { id?: number; account?: number; q?: string; filter?: FbChatThreadFilter };

/** Chats, newest activity first. With `id`, that one chat. */
export async function listThreads(sql: SqlLike, chatId: string | undefined, query: ThreadQuery): Promise<FbChatThreadRow[]> {
  // LIKE's own wildcards in what the manager typed are text to find.
  const pattern = query.q ? `%${query.q.replace(/[\\%_]/g, '\\$&')}%` : null;
  const rows = await sql<ThreadDbRow[]>`
    SELECT t.id::int AS id, t.fb_thread_id, t.account_id::int AS account_id, a.no AS account_no,
           a.label AS account_label, a.label AS account, t.buyer_name, t.buyer_location,
           b.rating::float8 AS rating, b.rating_count, b.joined_year,
           t.listing_id, t.listing_title, t.telegram_topic_id::float8 AS telegram_topic_id, t.last_seq,
           t.last_inbound_at, t.last_outbound_at, t.created_at,
           t.last_inbound_seq > t.read_seq AS unread,
           COALESCE(lo.send_state IN ('failed','uncertain'), FALSE) AS failed,
           GREATEST(t.last_inbound_at, t.last_outbound_at, t.created_at, lm.created_at) AS last_activity_at,
           lm.direction AS lm_direction, lm.source AS lm_source, lm.author_name AS lm_author_name, lm.body AS lm_body,
           lm.images AS lm_images, lm.send_state AS lm_send_state, lm.created_at AS lm_created_at
      FROM fb_chat_threads t JOIN fb_chat_accounts a ON a.id = t.account_id
      LEFT JOIN fb_chat_buyers b ON b.id = t.buyer_id
      LEFT JOIN LATERAL (
        SELECT m.direction, m.source, m.body, jsonb_array_length(m.images) AS images, m.send_state, m.created_at,
               ${authorSql(sql, sql`m`, sql`u`)} AS author_name
          FROM fb_chat_messages m LEFT JOIN users u ON u.id = m.erp_user_id
         WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) lm ON TRUE
      LEFT JOIN LATERAL (
        SELECT o.send_state FROM fb_chat_messages o
         WHERE o.thread_id = t.id AND o.direction = 'out' ORDER BY o.id DESC LIMIT 1) lo ON TRUE
     WHERE TRUE
       ${query.id === undefined ? sql`` : sql`AND t.id = ${query.id}`}
       ${query.account === undefined ? sql`` : sql`AND t.account_id = ${query.account}`}
       ${query.filter === 'unread' ? sql`AND t.last_inbound_seq > t.read_seq` : sql``}
       ${query.filter === 'failed' ? sql`AND lo.send_state IN ('failed','uncertain')` : sql``}
       ${pattern === null ? sql`` : sql`
         AND (t.buyer_name ILIKE ${pattern} OR t.listing_title ILIKE ${pattern}
              OR EXISTS (SELECT 1 FROM fb_chat_messages s WHERE s.thread_id = t.id AND s.body ILIKE ${pattern}))`}
     ORDER BY last_activity_at DESC, t.id DESC LIMIT ${THREADS_MAX}`;
  return rows.map(({ lm_direction, lm_source, lm_author_name, lm_body, lm_images, lm_send_state, lm_created_at, ...t }) => ({
    ...t,
    telegram_topic_url: topicUrl(chatId, t.telegram_topic_id),
    last_message: lm_direction === null ? null : {
      direction: lm_direction, source: lm_source, author_name: lm_author_name, body: lm_body,
      images: lm_images, send_state: lm_send_state, created_at: lm_created_at,
    },
  }));
}

/** A conversation's messages in page order; with `messageId`, that one message. */
export async function listMessages(sql: SqlLike, by: { threadId: number } | { messageId: number }): Promise<FbChatMessageRow[]> {
  return sql<FbChatMessageRow[]>`
    SELECT m.id::int AS id, m.seq, m.direction, m.source, m.body, m.images, m.backfill, m.fb_sent_label,
           m.send_state, m.error, m.typing_ms, m.tg_user_name, m.erp_user_id,
           ${authorSql(sql, sql`m`, sql`u`)} AS author_name, m.created_at, m.sent_at
      FROM fb_chat_messages m LEFT JOIN users u ON u.id = m.erp_user_id
     WHERE ${'threadId' in by ? sql`m.thread_id = ${by.threadId}` : sql`m.id = ${by.messageId}`}
     ORDER BY m.seq NULLS LAST, m.id`;
}

/** The same buyer's chats on our other accounts, newest activity first. */
export async function alsoMessaged(sql: SqlLike, threadId: number): Promise<FbChatAlsoMessaged[]> {
  return sql<FbChatAlsoMessaged[]>`
    SELECT o.id::int AS thread_id, o.account_id::int AS account_id, a.no AS account_no, a.label AS account_label,
           lm.body AS last_body,
           GREATEST(o.last_inbound_at, o.last_outbound_at, o.created_at, lm.created_at) AS last_activity_at
      FROM fb_chat_threads t
      JOIN fb_chat_threads o ON o.buyer_id = t.buyer_id AND o.account_id <> t.account_id
      JOIN fb_chat_accounts a ON a.id = o.account_id
      LEFT JOIN LATERAL (
        SELECT m.body, m.created_at FROM fb_chat_messages m
         WHERE m.thread_id = o.id ORDER BY m.id DESC LIMIT 1) lm ON TRUE
     WHERE t.id = ${threadId}
     ORDER BY last_activity_at DESC, o.id DESC`;
}

/**
 * Queues a reply typed on the page. It is born unmirrored, so the Telegram
 * pass posts it into the chat's topic like any other message of ours. Null
 * when the chat is unknown.
 */
export async function queueErpReply(tx: Tx, threadId: number, body: string, userId: string): Promise<number | null> {
  // Answering is reading, as it is from Telegram.
  const [thread] = await tx`UPDATE fb_chat_threads SET read_seq = last_seq WHERE id = ${threadId} RETURNING id`;
  if (!thread) return null;
  const [m] = await tx<{ id: number }[]>`
    INSERT INTO fb_chat_messages (thread_id, direction, source, body, send_state, erp_user_id)
    VALUES (${threadId}, 'out', 'erp', ${body}, 'queued', ${userId})
    RETURNING id::int AS id`;
  await notifyOutbox(tx);
  return m!.id;
}

export type RetryOutcome = 'ok' | 'not_found' | 'not_waiting' | 'needs_force';

/**
 * Puts a reply that did not go out back in the outbox, as the same row. One
 * marked uncertain may already be on Facebook, so sending it again takes an
 * explicit `force`: the caller has been told the buyer may get it twice.
 */
export async function retryReply(tx: Tx, messageId: number, force: boolean): Promise<RetryOutcome> {
  const [m] = await tx<{ direction: string; seq: number | null; send_state: string | null }[]>`
    SELECT direction, seq, send_state FROM fb_chat_messages WHERE id = ${messageId} FOR UPDATE`;
  if (!m) return 'not_found';
  if (m.direction !== 'out' || m.seq !== null || (m.send_state !== 'failed' && m.send_state !== 'uncertain')) return 'not_waiting';
  if (m.send_state === 'uncertain' && !force) return 'needs_force';
  // acked_at cleared: Telegram hears how this attempt ends too.
  await tx`
    UPDATE fb_chat_messages SET send_state = 'queued', error = NULL, claimed_at = NULL, acked_at = NULL
     WHERE id = ${messageId}`;
  await notifyOutbox(tx);
  return 'ok';
}

/** Moves the team's one read mark. False when the chat is unknown. */
export async function markThread(sql: SqlLike, threadId: number, read: boolean): Promise<boolean> {
  // Unread steps back to just before the buyer's newest message; a chat the
  // buyer never wrote in has nothing to be unread.
  const rows = read
    ? await sql`UPDATE fb_chat_threads SET read_seq = last_seq WHERE id = ${threadId} RETURNING id`
    : await sql`
        UPDATE fb_chat_threads SET
          read_seq = CASE WHEN last_inbound_seq > 0 THEN LEAST(read_seq, last_inbound_seq - 1) ELSE read_seq END
         WHERE id = ${threadId} RETURNING id`;
  return rows.length > 0;
}

export async function summary(sql: SqlLike): Promise<FbChatSummary> {
  const [row] = await sql<FbChatSummary[]>`
    SELECT (SELECT COUNT(*)::int FROM fb_chat_threads WHERE last_inbound_seq > read_seq) AS unread,
           (SELECT COUNT(*)::int FROM fb_chat_devices WHERE status = 'pending') AS pending_devices`;
  return row!;
}

type AccountDbRow = Omit<FbChatAccountRow, 'paused' | 'stale_after_sec' | 'config_state' | 'device'> & {
  config_rev: string | null;
  device: FbChatAccountDevice | null;
};

export async function listAccounts(sql: SqlLike): Promise<FbChatAccountsAnswer> {
  // The device is whichever enrolled Chrome last pushed for the account.
  // client_id is its only link: a foreign key would not survive the nightly
  // sync, which brings accounts from prod and keeps dev's own devices.
  const rows = await sql<AccountDbRow[]>`
    SELECT a.id::int AS id, a.no, a.fb_uid, a.label, a.ext_version, a.restricted, a.restricted_at,
           a.last_seen_at, a.created_at, a.config_rev, a.config_seen_at,
           (SELECT COUNT(*)::int FROM fb_chat_threads t WHERE t.account_id = a.id) AS threads,
           (SELECT COUNT(*)::int FROM fb_chat_threads t
             WHERE t.account_id = a.id AND t.last_inbound_seq > t.read_seq) AS unread,
           (SELECT COUNT(*)::int FROM fb_chat_messages m JOIN fb_chat_threads t ON t.id = m.thread_id
             WHERE t.account_id = a.id AND m.send_state IN ('queued','sending')) AS replies_waiting,
           (SELECT MAX(t.last_synced_at) FROM fb_chat_threads t WHERE t.account_id = a.id) AS last_sync_at,
           CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object(
             'id', d.id, 'label', d.label, 'status', d.status, 'ext_version', d.ext_version,
             'user_agent', d.user_agent, 'created_ip', d.created_ip, 'last_seen_at', d.last_seen_at,
             'decided_by', du.name, 'decided_at', d.decided_at) END AS device
      FROM fb_chat_accounts a
      LEFT JOIN fb_chat_devices d ON a.client_id = 'device:' || d.id
      LEFT JOIN users du ON du.id = d.decided_by
     ORDER BY a.no`;
  const configs = await configsFor(sql, rows.map((r) => r.id));
  const accounts = rows.map(({ config_rev, ...a }): FbChatAccountRow => {
    const config = configs.get(a.id)!;
    const poll = config.values.configPollSec;
    return {
      ...a,
      paused: config.values.paused === true,
      // An account is touched at least once per settings check, so three
      // missed checks is silence.
      stale_after_sec: Math.max(STALE_FLOOR_SEC, 3 * (typeof poll === 'number' ? poll : DEFAULT_CONFIG_POLL_SEC)),
      config_state: config_rev === config.rev ? 'up_to_date' : 'waiting',
    };
  });
  return {
    accounts,
    next_no: Math.max(0, ...accounts.map((a) => a.no)) + 1,
    latest_ext_version: await latestExtVersion(sql),
  };
}

/** Names the account, and stops the extension's own label replacing the name. */
export async function renameAccount(sql: SqlLike, id: number, label: string): Promise<boolean> {
  const rows = await sql`UPDATE fb_chat_accounts SET label = ${label}, label_locked = TRUE WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export async function topicCount(sql: SqlLike): Promise<number> {
  const [row] = await sql<{ topics: number }[]>`
    SELECT COUNT(*)::int AS topics FROM fb_chat_threads WHERE telegram_topic_id IS NOT NULL`;
  return row!.topics;
}
