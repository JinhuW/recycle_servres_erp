import type postgres from 'postgres';
import { getDb } from '../db';
import { chunkForTelegram, FB_CHAT_REPLY_MAX, fbChatTopicName } from '../lib/fbChat';
import { log } from '../lib/log';
import { TelegramError, telegramCaller, type TelegramCall } from '../lib/telegramBot';
import type { Env } from '../types';

// The Telegram half of the Facebook chat hub. One pass:
//   1. reads the bot's updates and queues the replies typed in topics;
//   2. posts account alerts to General;
//   3. mirrors stored messages into each buyer's topic, creating it on first use;
//   4. renames a topic whose buyer name or location has since changed;
//   5. tells Telegram how each reply ended.
// Every step works from rows, so a pass that dies midway is finished by the
// next one. getUpdates is exclusive per bot token: the advisory lock keeps two
// backend instances from both consuming updates, and the token must not be one
// another program polls.

const flog = log.child({ module: 'fbChat' });

const TICK_MS = 2_000;
const FIRST_RUN_MS = 3_000;
const MIRROR_BATCH = 40;
// More unposted messages than this in one thread go out as a transcript.
const TRANSCRIPT_OVER = 4;
// Telegram allows a bot about 20 messages a minute in one group.
const SENDS_PER_TICK = 6;

export type FbChatTelegramConfig = { call: TelegramCall; chatId: string; userIds: Set<string> };

let testCall: TelegramCall | null = null;
/** Tests replace the Bot API with a recorder. */
export function setFbChatTelegramForTests(call: TelegramCall | null): void {
  testCall = call;
}

export function fbChatTelegramConfig(env: Env): FbChatTelegramConfig | null {
  const chatId = env.FB_CHAT_TELEGRAM_CHAT_ID?.trim();
  const token = env.FB_CHAT_TELEGRAM_BOT_TOKEN?.trim();
  if (!chatId || !(token || testCall)) return null;
  const userIds = new Set((env.FB_CHAT_TELEGRAM_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  return { call: testCall ?? telegramCaller(token!), chatId, userIds };
}

type Update = {
  update_id: number;
  message?: {
    message_id: number;
    message_thread_id?: number;
    is_topic_message?: boolean;
    chat: { id: number };
    from?: { id: number; is_bot: boolean; first_name?: string; last_name?: string; username?: string };
    text?: string;
  };
};

class Budget {
  private left = SENDS_PER_TICK;
  take(): boolean {
    if (this.left <= 0) return false;
    this.left -= 1;
    return true;
  }
}

async function pollUpdates(sql: postgres.Sql, cfg: FbChatTelegramConfig): Promise<number> {
  const [state] = await sql<{ offset: string }[]>`SELECT "offset" FROM fb_chat_telegram_state`;
  const updates = await cfg.call<Update[]>('getUpdates', {
    offset: Number(state!.offset), timeout: 0, limit: 50, allowed_updates: ['message'],
  });
  let queued = 0;
  for (const u of updates) {
    queued += await handleUpdate(sql, cfg, u);
    await sql`UPDATE fb_chat_telegram_state SET "offset" = ${u.update_id + 1}`;
  }
  return queued;
}

async function handleUpdate(sql: postgres.Sql, cfg: FbChatTelegramConfig, u: Update): Promise<number> {
  const m = u.message;
  if (!m || String(m.chat.id) !== cfg.chatId || !m.from || m.from.is_bot) return 0;
  // General and service messages carry no topic; a reply belongs to a buyer.
  if (!m.is_topic_message || !m.message_thread_id) return 0;
  if (cfg.userIds.size && !cfg.userIds.has(String(m.from.id))) return 0;
  const [thread] = await sql<{ id: number }[]>`
    SELECT id::int AS id FROM fb_chat_threads WHERE telegram_topic_id = ${m.message_thread_id}`;
  if (!thread) return 0;
  const reply = (text: string) => cfg.call('sendMessage', {
    chat_id: cfg.chatId, message_thread_id: m.message_thread_id, text,
    reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true },
  }).catch((e) => flog.warn('telegram reply failed', e));
  const body = m.text?.trim();
  if (!body) {
    await reply('Only text can be sent to Facebook. This message was not forwarded.');
    return 0;
  }
  // A leading slash is a bot command or a note to self, never for the buyer.
  if (body.startsWith('/')) return 0;
  if (body.length > FB_CHAT_REPLY_MAX) {
    await reply(`Too long to send (${body.length} characters; the limit is ${FB_CHAT_REPLY_MAX}). Not forwarded.`);
    return 0;
  }
  const who = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username || String(m.from.id);
  const rows = await sql`
    INSERT INTO fb_chat_messages (thread_id, direction, source, body, send_state, tg_message_id, tg_user_id, tg_user_name, mirrored_at)
    VALUES (${thread.id}, 'out', 'telegram', ${body}, 'queued', ${m.message_id}, ${m.from.id}, ${who}, NOW())
    ON CONFLICT (thread_id, tg_message_id) DO NOTHING
    RETURNING id`;
  return rows.length;
}

async function postAlerts(sql: postgres.Sql, cfg: FbChatTelegramConfig, budget: Budget): Promise<void> {
  const alerts = await sql<{ id: number; alert: string }[]>`
    SELECT id::int AS id, alert FROM fb_chat_events
     WHERE alert IS NOT NULL AND alerted_at IS NULL ORDER BY id LIMIT 5`;
  for (const a of alerts) {
    if (!budget.take()) return;
    await cfg.call('sendMessage', { chat_id: cfg.chatId, text: a.alert });
    await sql`UPDATE fb_chat_events SET alerted_at = NOW() WHERE id = ${a.id}`;
  }
}

type Unmirrored = {
  id: number; thread_id: number; direction: 'in' | 'out'; body: string; images: string[]; backfill: boolean;
};

type ThreadRow = {
  id: number; fb_thread_id: string; buyer_name: string | null; buyer_location: string | null;
  listing_id: string | null; listing_title: string | null;
  telegram_topic_id: string | null; telegram_topic_name: string | null; header_sent_at: Date | null;
  account_label: string; fb_uid: string;
  rating: string | null; rating_count: number | null; joined_year: number | null;
};

function header(t: ThreadRow): string {
  const stars = t.rating == null ? 'no ratings yet'
    : `⭐ ${Number(t.rating).toFixed(1)}${t.rating_count == null ? '' : ` (${t.rating_count} rating${t.rating_count === 1 ? '' : 's'})`}`;
  const lines = [`👤 ${t.buyer_name ?? 'Unknown buyer'} · ${stars}`];
  const where = [t.buyer_location && `📍 ${t.buyer_location}`, t.joined_year && `on Facebook since ${t.joined_year}`].filter(Boolean);
  if (where.length) lines.push(where.join(' · '));
  if (t.listing_title || t.listing_id) {
    lines.push(`🛒 ${[t.listing_title, t.listing_id && `https://www.facebook.com/marketplace/item/${t.listing_id}/`].filter(Boolean).join(' — ')}`);
  }
  lines.push(`💬 https://www.facebook.com/marketplace/t/${t.fb_thread_id}/`);
  lines.push(`🔑 Account: ${t.account_label || t.fb_uid}`);
  lines.push('', 'Reply here to answer on Facebook. Start a line with / to keep a note to yourself.');
  return lines.join('\n');
}

const gone = (e: unknown) => e instanceof TelegramError
  && /thread not found|topic.?(deleted|closed|not.?found)|TOPIC_/i.test(e.message);

/** The thread's topic, created or renamed as needed. Null when out of budget. */
async function ensureTopic(sql: postgres.Sql, cfg: FbChatTelegramConfig, t: ThreadRow, budget: Budget): Promise<number | null> {
  const name = fbChatTopicName(t.buyer_name, t.buyer_location, t.fb_thread_id);
  let topicId = t.telegram_topic_id == null ? null : Number(t.telegram_topic_id);
  if (topicId == null) {
    if (!budget.take()) return null;
    const made = await cfg.call<{ message_thread_id: number }>('createForumTopic', { chat_id: cfg.chatId, name });
    topicId = made.message_thread_id;
    await sql`
      UPDATE fb_chat_threads SET telegram_topic_id = ${topicId}, telegram_topic_name = ${name}, header_sent_at = NULL
       WHERE id = ${t.id}`;
    await sql`INSERT INTO fb_chat_events (thread_id, kind, detail) VALUES (${t.id}, 'topic_created', ${sql.json({ topic_id: topicId, name })})`;
  } else if (t.telegram_topic_name !== name) {
    // The location often arrives after the first message, from the profile page.
    if (!budget.take()) return null;
    try {
      await cfg.call('editForumTopic', { chat_id: cfg.chatId, message_thread_id: topicId, name });
    } catch (e) {
      // Telegram refuses a rename to the name the topic already has.
      if (!(e instanceof TelegramError) || !/not.?modified/i.test(e.message)) throw e;
    }
    await sql`UPDATE fb_chat_threads SET telegram_topic_name = ${name} WHERE id = ${t.id}`;
  }
  if (!t.header_sent_at) {
    if (!budget.take()) return null;
    await cfg.call('sendMessage', {
      chat_id: cfg.chatId, message_thread_id: topicId, text: header(t), link_preview_options: { is_disabled: true },
    });
    await sql`UPDATE fb_chat_threads SET header_sent_at = NOW() WHERE id = ${t.id}`;
  }
  return topicId;
}

function transcriptLine(m: Unmirrored, buyer: string): string {
  const text = [m.body, ...m.images.map(() => '[photo]')].filter(Boolean).join(' ');
  return `${m.direction === 'in' ? buyer : 'You'}: ${text}`;
}

async function postOne(cfg: FbChatTelegramConfig, topicId: number, m: Unmirrored): Promise<void> {
  const text = m.direction === 'in' ? m.body : `↩️ You: ${m.body}`;
  const [first, ...more] = m.images;
  if (first) {
    try {
      await cfg.call('sendPhoto', {
        chat_id: cfg.chatId, message_thread_id: topicId, photo: first, caption: text.slice(0, 1000) || undefined,
      });
      for (const url of more) await cfg.call('sendPhoto', { chat_id: cfg.chatId, message_thread_id: topicId, photo: url });
      return;
    } catch (e) {
      if (gone(e) || (e instanceof TelegramError && e.retryAfterSec)) throw e;
      // Telegram could not fetch the image; the link still gets it across.
    }
    await cfg.call('sendMessage', { chat_id: cfg.chatId, message_thread_id: topicId, text: [text, ...m.images].filter(Boolean).join('\n') });
    return;
  }
  for (const chunk of chunkForTelegram(text)) {
    await cfg.call('sendMessage', {
      chat_id: cfg.chatId, message_thread_id: topicId, text: chunk, link_preview_options: { is_disabled: true },
    });
  }
}

async function loadThread(sql: postgres.Sql, threadId: number): Promise<ThreadRow> {
  const [t] = await sql<ThreadRow[]>`
    SELECT t.id::int AS id, t.fb_thread_id, t.buyer_name, t.buyer_location, t.listing_id, t.listing_title,
           t.telegram_topic_id, t.telegram_topic_name, t.header_sent_at,
           a.label AS account_label, a.fb_uid, b.rating, b.rating_count, b.joined_year
      FROM fb_chat_threads t JOIN fb_chat_accounts a ON a.id = t.account_id
      LEFT JOIN fb_chat_buyers b ON b.id = t.buyer_id
     WHERE t.id = ${threadId}`;
  return t!;
}

const forgetTopic = (sql: postgres.Sql, threadId: number) => sql`
  UPDATE fb_chat_threads SET telegram_topic_id = NULL, telegram_topic_name = NULL, header_sent_at = NULL
   WHERE id = ${threadId}`;

/** Topics whose buyer name or location changed since they were named. */
async function renameTopics(sql: postgres.Sql, cfg: FbChatTelegramConfig, budget: Budget): Promise<void> {
  const stale = await sql<{ id: number }[]>`
    SELECT id::int AS id FROM fb_chat_threads
     WHERE telegram_topic_id IS NOT NULL AND telegram_topic_name IS NULL ORDER BY id LIMIT 5`;
  for (const { id } of stale) {
    try {
      if ((await ensureTopic(sql, cfg, await loadThread(sql, id), budget)) == null) return;
    } catch (e) {
      if (!gone(e)) throw e;
      await forgetTopic(sql, id);
    }
  }
}

async function mirror(sql: postgres.Sql, cfg: FbChatTelegramConfig, budget: Budget): Promise<number> {
  const rows = await sql<Unmirrored[]>`
    SELECT id::int AS id, thread_id::int AS thread_id, direction, body, images, backfill
      FROM fb_chat_messages WHERE mirrored_at IS NULL ORDER BY id LIMIT ${MIRROR_BATCH}`;
  const byThread = new Map<number, Unmirrored[]>();
  for (const r of rows) byThread.set(r.thread_id, [...(byThread.get(r.thread_id) ?? []), r]);
  let posted = 0;
  for (const [threadId, messages] of byThread) {
    const t = await loadThread(sql, threadId);
    try {
      const topicId = await ensureTopic(sql, cfg, t, budget);
      if (topicId == null) return posted;
      const done = (ids: number[]) => sql`UPDATE fb_chat_messages SET mirrored_at = NOW() WHERE id IN ${sql(ids)}`;
      if (messages.some((m) => m.backfill) || messages.length > TRANSCRIPT_OVER) {
        const buyer = t.buyer_name ?? 'Buyer';
        const title = messages[0]!.backfill ? '📜 Earlier messages\n' : '';
        const chunks = chunkForTelegram(title + messages.map((m) => transcriptLine(m, buyer)).join('\n'));
        for (const chunk of chunks) {
          if (!budget.take()) return posted;
          await cfg.call('sendMessage', {
            chat_id: cfg.chatId, message_thread_id: topicId, text: chunk, link_preview_options: { is_disabled: true },
          });
        }
        await done(messages.map((m) => m.id));
        posted += messages.length;
      } else {
        for (const m of messages) {
          if (!budget.take()) return posted;
          await postOne(cfg, topicId, m);
          await done([m.id]);
          posted += 1;
        }
      }
    } catch (e) {
      if (!gone(e)) throw e;
      // The topic was deleted in Telegram: open a new one on the next pass.
      await forgetTopic(sql, threadId);
    }
  }
  return posted;
}

async function ackReplies(sql: postgres.Sql, cfg: FbChatTelegramConfig, budget: Budget): Promise<void> {
  const rows = await sql<{ id: number; send_state: string; error: string | null; tg_message_id: string; topic: string | null }[]>`
    SELECT m.id::int AS id, m.send_state, m.error, m.tg_message_id, t.telegram_topic_id AS topic
      FROM fb_chat_messages m JOIN fb_chat_threads t ON t.id = m.thread_id
     WHERE m.send_state IN ('sent','failed','uncertain') AND m.acked_at IS NULL AND m.tg_message_id IS NOT NULL
     ORDER BY m.id LIMIT 10`;
  for (const r of rows) {
    if (!budget.take()) return;
    try {
      if (r.send_state === 'sent') {
        await cfg.call('setMessageReaction', {
          chat_id: cfg.chatId, message_id: Number(r.tg_message_id), reaction: [{ type: 'emoji', emoji: '👍' }],
        });
      } else {
        await cfg.call('sendMessage', {
          chat_id: cfg.chatId, message_thread_id: r.topic == null ? undefined : Number(r.topic),
          text: r.send_state === 'failed'
            ? `❌ Not sent to Facebook: ${r.error ?? 'unknown error'}. Send it again to retry.`
            : `⚠️ This reply may not have reached the buyer (${r.error ?? 'not confirmed'}). Check the conversation on Facebook before sending it again.`,
          reply_parameters: { message_id: Number(r.tg_message_id), allow_sending_without_reply: true },
        });
      }
    } catch (e) {
      if (e instanceof TelegramError && e.retryAfterSec) throw e;
      // The owner's message was deleted, or reactions are off: nothing to tell.
      flog.warn('telegram ack failed', e);
    }
    await sql`UPDATE fb_chat_messages SET acked_at = NOW() WHERE id = ${r.id}`;
  }
}

let pausedUntil = 0;

export type FbChatTickResult = { ran: boolean; queued: number; posted: number };

export async function runFbChatTelegramTick(sql: postgres.Sql, cfg: FbChatTelegramConfig): Promise<FbChatTickResult> {
  if (Date.now() < pausedUntil) return { ran: false, queued: 0, posted: 0 };
  return sql.begin(async (tx) => {
    // The transaction only holds the lock; the work commits row by row.
    const [lock] = await tx<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended('fb-chat-telegram', 0)) AS ok`;
    if (!lock!.ok) return { ran: false, queued: 0, posted: 0 };
    const budget = new Budget();
    try {
      const queued = await pollUpdates(sql, cfg);
      await postAlerts(sql, cfg, budget);
      const posted = await mirror(sql, cfg, budget);
      await renameTopics(sql, cfg, budget);
      await ackReplies(sql, cfg, budget);
      return { ran: true, queued, posted };
    } catch (e) {
      if (e instanceof TelegramError && e.retryAfterSec) {
        pausedUntil = Date.now() + e.retryAfterSec * 1000;
        flog.warn('telegram rate limit', { retryAfterSec: e.retryAfterSec });
        return { ran: true, queued: 0, posted: 0 };
      }
      throw e;
    }
  }) as Promise<FbChatTickResult>;
}

let kick: (() => void) | null = null;
/** Runs a pass now rather than at the next tick: a buyer's message just landed. */
export function kickFbChatTelegram(): void {
  kick?.();
}

export function startFbChatTelegramLoop(env: Env): { stop: () => void } {
  const cfg = fbChatTelegramConfig(env);
  // A mirror holds a copy of the tables; posting from it would double every message.
  if (!cfg || env.FLEET_ROLE === 'mirror') return { stop: () => {} };
  const sql = getDb(env);
  let stopped = false;
  let busy = false;
  let again = false;
  const tick = async () => {
    if (stopped) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const r = await runFbChatTelegramTick(sql, cfg);
      if (r.queued || r.posted) flog.info('fb chat telegram tick', r);
    } catch (e) {
      flog.error('fb chat telegram tick failed', e);
    } finally {
      busy = false;
      if (again) { again = false; setImmediate(() => void tick()); }
    }
  };
  kick = () => void tick();
  const first = setTimeout(() => void tick(), FIRST_RUN_MS);
  const handle = setInterval(() => void tick(), TICK_MS);
  first.unref?.();
  handle.unref?.();
  return { stop: () => { stopped = true; kick = null; clearTimeout(first); clearInterval(handle); } };
}
