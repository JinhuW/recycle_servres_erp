// Pulls reactions on alert messages back from Telegram: the lead signal every
// prompt version is scored by.
//
// getUpdates is exclusive per bot token — a second poller makes Telegram
// answer the first with 409 — so this runs in the api process only, the one
// service that runs as a single copy, and only with the Telegram transport so
// a local api never takes production's updates. Telegram delivers reactions
// only while the bot is an admin of the chat and only after
// "message_reaction" entered allowed_updates; there is no history API, so a
// reaction made while this is down is gone.

import type {Sql} from '../db.ts';
import type {Logger} from '../logger.ts';
import type {SettingsStore} from '../settings.ts';

/** Telegram holds the request open this long waiting for an update. */
const LONG_POLL_SECONDS = 25;

const ALLOWED_UPDATES = ['message_reaction', 'message_reaction_count', 'my_chat_member'];

interface TelegramChat {
  id: number;
  type?: string;
  title?: string;
}

type ReactionType =
  | {type: 'emoji'; emoji: string}
  | {type: 'custom_emoji'; custom_emoji_id: string}
  | {type: string};

interface ReactionUpdate {
  chat: TelegramChat;
  message_id: number;
  user?: {id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string};
  actor_chat?: TelegramChat;
  date: number;
  old_reaction: ReactionType[];
  new_reaction: ReactionType[];
}

interface ReactionCountUpdate {
  chat: TelegramChat;
  message_id: number;
  date: number;
  reactions: Array<{type: ReactionType; total_count: number}>;
}

interface ChatMemberUpdate {
  chat: TelegramChat;
  new_chat_member?: {status?: string};
}

export interface TelegramUpdate {
  update_id: number;
  message_reaction?: ReactionUpdate;
  message_reaction_count?: ReactionCountUpdate;
  my_chat_member?: ChatMemberUpdate;
}

export interface ReactionsDeps {
  sql: Sql;
  botToken: string;
  settings: SettingsStore;
  logger: Logger;
  /** Aborted on shutdown so a pending long poll does not hold the process up. */
  signal?: AbortSignal;
}

/**
 * A reaction as a plain string. Standard reactions carry an emoji, custom ones
 * an id; the type is the fallback (e.g. "paid"), so an unknown future shape is
 * still recorded rather than dropped.
 */
function reactionKey(reaction: ReactionType): string {
  if ('emoji' in reaction) return reaction.emoji;
  if ('custom_emoji_id' in reaction) return reaction.custom_emoji_id;
  return reaction.type;
}

/** One long poll. True when it brought back updates, so the loop asks again at once. */
export async function reactionsOnce(deps: ReactionsDeps): Promise<boolean> {
  const {sql, logger} = deps;
  const [state] = await sql<Array<{next_offset: string}>>`
    SELECT next_offset::text FROM telegram_state`;
  const offset = Number(state?.next_offset ?? 0);

  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${deps.botToken}/getUpdates`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({offset, timeout: LONG_POLL_SECONDS, allowed_updates: ALLOWED_UPDATES}),
      signal: AbortSignal.any([
        AbortSignal.timeout((LONG_POLL_SECONDS + 10) * 1000),
        ...(deps.signal ? [deps.signal] : []),
      ]),
    });
  } catch (e) {
    if (!deps.signal?.aborted) {
      logger.warn('getUpdates failed', {error: e instanceof Error ? e.message : String(e)});
    }
    return false;
  }

  const payload = await response.json().catch(() => ({})) as {
    ok?: boolean;
    description?: string;
    result?: TelegramUpdate[];
  };
  if (response.status === 409) {
    logger.warn('another process is polling this bot\'s updates; reactions are split between them', {
      description: payload.description,
    });
    return false;
  }
  if (!response.ok || payload.ok !== true || !Array.isArray(payload.result)) {
    logger.warn('getUpdates rejected', {status: response.status, description: payload.description});
    return false;
  }
  if (payload.result.length === 0) return false;

  const settings = await deps.settings.get();
  const chats = new Set([...settings.telegramChatIds, ...settings.telegramDevChatIds]);

  for (const update of payload.result) {
    try {
      await handleUpdate(sql, chats, update, logger);
    } catch (e) {
      // One update that cannot be stored must not wedge the cursor: skipping
      // it loses one reaction, while retrying it forever loses all of them.
      logger.error('could not record a Telegram update; skipping it', {
        updateId: update.update_id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    // Past every update, actionable or not. Replaying is harmless — the event
    // log is keyed by update id and the current-state writes are overwrites —
    // so the cursor needs no transaction with the writes above.
    await sql`
      UPDATE telegram_state
         SET next_offset = ${String(update.update_id + 1)}::bigint, updated_at = NOW()`;
  }
  return true;
}

async function handleUpdate(
  sql: Sql,
  chats: ReadonlySet<string>,
  update: TelegramUpdate,
  logger: Logger,
): Promise<void> {
  if (update.my_chat_member) {
    // The bot being added to a chat is how a new dev channel's id surfaces:
    // it is in the api's log the moment someone makes the bot an admin.
    const {chat, new_chat_member: member} = update.my_chat_member;
    logger.event('telegram_chat_member', {
      chatId: String(chat.id),
      chatType: chat.type,
      chatTitle: chat.title,
      status: member?.status,
    });
    return;
  }

  const reaction = update.message_reaction;
  if (reaction) {
    const chatId = String(reaction.chat.id);
    if (!chats.has(chatId)) return;
    const reactor = reaction.user
      ? (reaction.user.is_bot ? null : String(reaction.user.id))
      // An anonymous admin reacts as the group itself; still a person acting.
      : reaction.actor_chat ? `chat:${reaction.actor_chat.id}` : null;
    if (reactor === null) return;

    const name = reaction.user
      ? [reaction.user.first_name, reaction.user.last_name].filter(Boolean).join(' ')
        || reaction.user.username
        || null
      : reaction.actor_chat?.title ?? null;
    const emoji = reaction.new_reaction.map(reactionKey);
    const at = new Date(reaction.date * 1000);

    await recordEvent(sql, update.update_id, chatId, reaction.message_id, reaction);
    await sql`
      INSERT INTO message_reactions
        (chat_id, message_id, reactor, reactor_name, emoji, first_reacted_at, updated_at)
      VALUES (${chatId}, ${reaction.message_id}, ${reactor}, ${name}, ${sql.json(emoji)},
              ${emoji.length > 0 ? at : null}, ${at})
      ON CONFLICT (chat_id, message_id, reactor) DO UPDATE
        SET emoji = EXCLUDED.emoji,
            reactor_name = EXCLUDED.reactor_name,
            first_reacted_at = COALESCE(message_reactions.first_reacted_at,
                                        EXCLUDED.first_reacted_at),
            updated_at = EXCLUDED.updated_at`;
    return;
  }

  const counts = update.message_reaction_count;
  if (counts) {
    const chatId = String(counts.chat.id);
    if (!chats.has(chatId)) return;
    const totals = Object.fromEntries(
      counts.reactions.map((r) => [reactionKey(r.type), r.total_count]),
    );

    await recordEvent(sql, update.update_id, chatId, counts.message_id, counts);
    await sql`
      INSERT INTO message_reaction_counts (chat_id, message_id, counts, updated_at)
      VALUES (${chatId}, ${counts.message_id}, ${sql.json(totals)}, ${new Date(counts.date * 1000)})
      ON CONFLICT (chat_id, message_id) DO UPDATE
        SET counts = EXCLUDED.counts, updated_at = EXCLUDED.updated_at`;
  }
}

async function recordEvent(
  sql: Sql,
  updateId: number,
  chatId: string,
  messageId: number,
  payload: ReactionUpdate | ReactionCountUpdate,
): Promise<void> {
  await sql`
    INSERT INTO reaction_events (update_id, chat_id, message_id, payload)
    VALUES (${updateId}, ${chatId}, ${messageId}, ${sql.json(payload as never)})
    ON CONFLICT (update_id) DO NOTHING`;
}
