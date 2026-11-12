import { Api, TelegramClient, helpers } from 'telegram';
import { FloodWaitError, RPCError } from 'telegram/errors/index.js';
import { StringSession } from 'telegram/sessions/index.js';
import { TelegramError, type TelegramCall } from './telegramBot';

// The Facebook chat hub's Telegram side, signed in as an ordinary Telegram
// account (MTProto) rather than a bot. The hub's pass is written against Bot
// API method names; `userAccountCaller` answers those same calls from a user
// session, so the pass and its tests do not change with the mode.
//
// Two things differ from a bot and shape this file:
// - A user account has no getUpdates. Replies are read from the group's
//   history, after the last message id seen, and only when an update says
//   something arrived (or a catch-up interval passed), to stay clear of flood
//   limits.
// - Messages the account itself sends come back marked `out`, whether the hub
//   posted them or the owner typed them on a phone signed in to the same
//   account. The hub remembers what it posted (ids, and texts in case an id
//   was not returned) and reports only those as from a bot. An `out` message
//   it did not post is a reply. One from before this session started is
//   taken as a post: nothing is known about it, and relaying a post would
//   send the buyer's own words back to them.

/** One message in the group, as much as the hub reads. */
export type UserMessage = {
  id: number;
  /** Unix seconds. */
  date: number;
  /** The forum topic it is in, or null for General. */
  topicId: number | null;
  out: boolean;
  fromId: string | null;
  firstName?: string;
  lastName?: string;
  username?: string;
  text: string;
};

/** What the hub needs from a signed-in account, in the group it posts to. */
export interface TelegramUserClient {
  /** Messages after `afterId`, oldest first. With `afterId` 0, only the latest. */
  history(afterId: number, limit: number): Promise<UserMessage[]>;
  send(text: string, opts: { topicId?: number; replyToId?: number }): Promise<number>;
  sendPhotoUrl(url: string, caption: string | undefined, topicId: number): Promise<number>;
  createTopic(title: string): Promise<number>;
  renameTopic(topicId: number, title: string): Promise<void>;
  react(messageId: number, emoji: string): Promise<void>;
  /** Called on any update for the group; tells the caller history moved. */
  onActivity(listener: () => void): void;
}

// A missed update costs at most this much delay before a reply is read.
const CATCH_UP_MS = 20_000;
// How many of its own posts the hub remembers, to tell them from typed replies.
const POSTED_KEPT = 500;

type Params = Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** Bot API calls, answered from a user session. */
export function userAccountCaller(client: TelegramUserClient, chatId: string): TelegramCall {
  let dirty = true;
  let lastFetch = 0;
  client.onActivity(() => { dirty = true; });
  const chat = { id: Number(chatId) };
  const startedAt = Math.floor(Date.now() / 1000);
  const postedIds = new Set<number>();
  const postedTexts: string[] = [];
  const posted = (id: number, text?: string) => {
    if (id) postedIds.add(id);
    if (postedIds.size > POSTED_KEPT) postedIds.delete(postedIds.values().next().value!);
    if (text?.trim()) postedTexts.push(text.trim());
    if (postedTexts.length > POSTED_KEPT) postedTexts.shift();
  };
  const isPost = (m: UserMessage) =>
    m.out && (postedIds.has(m.id) || m.date <= startedAt || postedTexts.includes(m.text.trim()));

  const call = async (method: string, p: Params): Promise<unknown> => {
    switch (method) {
      case 'getUpdates': {
        const offset = num(p.offset) ?? 0;
        if (!dirty && Date.now() - lastFetch < CATCH_UP_MS) return [];
        dirty = false;
        lastFetch = Date.now();
        const messages = await client.history(Math.max(0, offset - 1), num(p.limit) ?? 50);
        return messages.map((m) => ({
          update_id: m.id,
          message: {
            message_id: m.id,
            message_thread_id: m.topicId ?? undefined,
            is_topic_message: m.topicId !== null,
            chat,
            // The first read only places the cursor: nothing before it is a reply.
            from: offset === 0 || !m.fromId ? undefined : {
              id: Number(m.fromId), is_bot: isPost(m), first_name: m.firstName, last_name: m.lastName, username: m.username,
            },
            text: m.text || undefined,
          },
        }));
      }
      case 'sendMessage': {
        const reply = p.reply_parameters as { message_id?: number } | undefined;
        const id = await client.send(String(p.text), { topicId: num(p.message_thread_id), replyToId: reply?.message_id });
        posted(id, String(p.text));
        return { message_id: id };
      }
      case 'sendPhoto': {
        const id = await client.sendPhotoUrl(String(p.photo), p.caption as string | undefined, num(p.message_thread_id)!);
        posted(id, p.caption as string | undefined);
        return { message_id: id };
      }
      case 'createForumTopic':
        return { message_thread_id: await client.createTopic(String(p.name)) };
      case 'editForumTopic':
        await client.renameTopic(num(p.message_thread_id)!, String(p.name));
        return true;
      case 'setMessageReaction': {
        const reaction = (p.reaction as { emoji: string }[])[0]!;
        await client.react(num(p.message_id)!, reaction.emoji);
        return true;
      }
      default:
        throw new Error(`no user-account equivalent for ${method}`);
    }
  };
  return (async <T>(method: string, params: Params): Promise<T> => {
    try {
      return (await call(method, params)) as T;
    } catch (e) {
      if (e instanceof FloodWaitError) throw new TelegramError(`FLOOD_WAIT_${e.seconds}`, 420, e.seconds);
      if (e instanceof RPCError) throw new TelegramError(e.errorMessage, e.code ?? 400, null);
      throw e;
    }
  }) as TelegramCall;
}

export type UserSessionConfig = { apiId: number; apiHash: string; session: string; chatId: string };

/** A connected GramJS session, scoped to one forum group. */
export async function connectUserClient(cfg: UserSessionConfig): Promise<{ client: TelegramUserClient; disconnect: () => Promise<void> }> {
  const tg = new TelegramClient(new StringSession(cfg.session), cfg.apiId, cfg.apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
  });
  // GramJS logs to stdout on its own; the hub logs through lib/log.
  tg.setLogLevel('none' as never);
  await tg.connect();
  if (!(await tg.checkAuthorization())) {
    await tg.disconnect();
    throw new Error('the Telegram session is not signed in; create a new FB_CHAT_TELEGRAM_SESSION');
  }
  // Resolving a group needs its access hash, which the dialog list caches.
  await tg.getDialogs({ limit: 200 });
  const peer = await tg.getInputEntity(cfg.chatId);
  const channelId = String(cfg.chatId).replace(/^-100/, '');

  const topicOf = (m: Api.Message): number | null => {
    const r = m.replyTo;
    if (!(r instanceof Api.MessageReplyHeader) || !r.forumTopic) return null;
    return r.replyToTopId ?? r.replyToMsgId ?? null;
  };
  const replyTo = (topicId?: number, replyToId?: number) =>
    topicId || replyToId
      ? new Api.InputReplyToMessage({ replyToMsgId: replyToId ?? topicId!, topMsgId: topicId })
      : undefined;
  const sentId = (updates: Api.TypeUpdates): number => {
    const list = 'updates' in updates ? updates.updates : [];
    for (const u of list) {
      if ((u instanceof Api.UpdateNewChannelMessage || u instanceof Api.UpdateNewMessage) && 'id' in u.message) return u.message.id;
    }
    for (const u of list) if (u instanceof Api.UpdateMessageID) return u.id;
    return 0;
  };

  const client: TelegramUserClient = {
    async history(afterId, limit) {
      const found = afterId === 0
        ? await tg.getMessages(peer, { limit: 1 })
        : await tg.getMessages(peer, { minId: afterId, limit, reverse: true });
      return found
        .filter((m): m is Api.Message => m instanceof Api.Message)
        .map((m) => {
          const sender = m.sender instanceof Api.User ? m.sender : undefined;
          return {
            id: m.id,
            date: m.date,
            topicId: topicOf(m),
            out: !!m.out,
            fromId: m.senderId ? m.senderId.toString() : null,
            firstName: sender?.firstName ?? undefined,
            lastName: sender?.lastName ?? undefined,
            username: sender?.username ?? undefined,
            text: m.message ?? '',
          };
        });
    },
    async send(text, { topicId, replyToId }) {
      const updates = await tg.invoke(new Api.messages.SendMessage({
        peer, message: text, noWebpage: true, randomId: helpers.generateRandomLong(), replyTo: replyTo(topicId, replyToId),
      }));
      return sentId(updates);
    },
    async sendPhotoUrl(url, caption, topicId) {
      const updates = await tg.invoke(new Api.messages.SendMedia({
        peer, media: new Api.InputMediaPhotoExternal({ url }), message: caption ?? '',
        randomId: helpers.generateRandomLong(), replyTo: replyTo(topicId),
      }));
      return sentId(updates);
    },
    async createTopic(title) {
      const updates = await tg.invoke(new Api.channels.CreateForumTopic({
        channel: peer, title, randomId: helpers.generateRandomLong(),
      }));
      const id = sentId(updates);
      if (!id) throw new TelegramError('Telegram did not say which topic it created', 500, null);
      return id;
    },
    async renameTopic(topicId, title) {
      await tg.invoke(new Api.channels.EditForumTopic({ channel: peer, topicId, title }));
    },
    async react(messageId, emoji) {
      await tg.invoke(new Api.messages.SendReaction({
        peer, msgId: messageId, reaction: [new Api.ReactionEmoji({ emoticon: emoji })],
      }));
    },
    onActivity(listener) {
      tg.addEventHandler((update: unknown) => {
        const message = (update as { message?: { peerId?: { channelId?: { toString(): string } } } }).message;
        const channel = message?.peerId?.channelId?.toString();
        if (!channel || channel === channelId) listener();
      });
    },
  };
  return { client, disconnect: async () => { await tg.destroy(); } };
}
