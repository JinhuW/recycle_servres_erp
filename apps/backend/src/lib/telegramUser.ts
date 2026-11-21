import { Api, TelegramClient, helpers } from 'telegram';
import { FloodWaitError, RPCError } from 'telegram/errors/index.js';
import { CustomFile } from 'telegram/client/uploads.js';
import { StringSession } from 'telegram/sessions/index.js';
import { DOWNLOAD_FILE, TelegramError, TelegramUpload, type TelegramCall, type TelegramDownload } from './telegramBot';

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
// A message with a photo or file is reported the way the Bot API reports it
// (`photo` or `document`, the text as `caption`), with the message id as the
// file id, so `downloadFile` can fetch it again by that id.

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
  /** The text, or the caption when the message carries a file. */
  text: string;
  /** A photo, a file, or something else (video, sticker, voice); absent on plain text and link previews. */
  media?: { kind: 'photo' | 'document' | 'other'; mime?: string; bytes?: number; width?: number; height?: number };
  /** Shared by the messages of one album. */
  groupedId?: string;
};

/** What the hub needs from a signed-in account, in the group it posts to. */
export interface TelegramUserClient {
  /** Messages after `afterId`, oldest first. With `afterId` 0, only the latest. */
  history(afterId: number, limit: number): Promise<UserMessage[]>;
  /** `chatId` posts to another chat the account is in instead of the group. */
  send(text: string, opts: { topicId?: number; replyToId?: number; chatId?: string }): Promise<number>;
  sendPhotoUrl(url: string, caption: string | undefined, topicId: number): Promise<number>;
  /** One photo, or an album of up to ten, from their bytes; the caption goes on the first. Answers the message ids. */
  sendPhotos(files: TelegramUpload[], caption: string | undefined, topicId: number): Promise<number[]>;
  createTopic(title: string): Promise<number>;
  renameTopic(topicId: number, title: string): Promise<void>;
  react(messageId: number, emoji: string): Promise<void>;
  /** The photo or file a message in the group carries. */
  download(messageId: number): Promise<Buffer>;
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
            ...mediaFields(m),
            message_id: m.id,
            message_thread_id: m.topicId ?? undefined,
            is_topic_message: m.topicId !== null,
            chat,
            // The first read only places the cursor: nothing before it is a reply.
            from: offset === 0 || !m.fromId ? undefined : {
              id: Number(m.fromId), is_bot: isPost(m), first_name: m.firstName, last_name: m.lastName, username: m.username,
            },
            text: m.media ? undefined : m.text || undefined,
          },
        }));
      }
      case DOWNLOAD_FILE: {
        const answer: TelegramDownload = { bytes: await client.download(Number(p.file_id)) };
        return answer;
      }
      case 'sendMessage': {
        const reply = p.reply_parameters as { message_id?: number } | undefined;
        const elsewhere = p.chat_id !== undefined && String(p.chat_id) !== chatId ? String(p.chat_id) : undefined;
        const id = await client.send(String(p.text), { topicId: num(p.message_thread_id), replyToId: reply?.message_id, chatId: elsewhere });
        // Only the group's history is read back, so only its posts are remembered.
        if (!elsewhere) posted(id, String(p.text));
        return { message_id: id };
      }
      case 'sendPhoto': {
        const caption = p.caption as string | undefined;
        const id = p.photo instanceof TelegramUpload
          ? (await client.sendPhotos([p.photo], caption, num(p.message_thread_id)!))[0] ?? 0
          : await client.sendPhotoUrl(String(p.photo), caption, num(p.message_thread_id)!);
        posted(id, caption);
        return { message_id: id };
      }
      case 'sendMediaGroup': {
        const items = p.media as Array<{ media: unknown; caption?: string }>;
        const files = items.map((item) => item.media);
        if (!files.every((f): f is TelegramUpload => f instanceof TelegramUpload)) {
          throw new Error('an account sends an album only from uploaded files');
        }
        const caption = items[0]?.caption;
        const ids = await client.sendPhotos(files, caption, num(p.message_thread_id)!);
        ids.forEach((id, i) => posted(id, i === 0 ? caption : undefined));
        return ids.map((id) => ({ message_id: id }));
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

/** A message's file as the Bot API names it; `other` media is left as a bare caption, which the hub refuses. */
function mediaFields(m: UserMessage): Params {
  if (!m.media) return {};
  const fileId = String(m.id);
  return {
    caption: m.text || undefined,
    media_group_id: m.groupedId,
    ...(m.media.kind === 'photo'
      ? { photo: [{ file_id: fileId, width: m.media.width ?? 0, height: m.media.height ?? 0, file_size: m.media.bytes }] }
      : {}),
    ...(m.media.kind === 'document'
      ? { document: { file_id: fileId, mime_type: m.media.mime, file_size: m.media.bytes } }
      : {}),
  };
}

/** What a message carries, in the terms `UserMessage` reports. */
function mediaOf(m: Api.Message): UserMessage['media'] {
  const media = m.media;
  // A link's preview is still a text message.
  if (!media || media instanceof Api.MessageMediaEmpty || media instanceof Api.MessageMediaWebPage) return undefined;
  if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
    let best: { w: number; h: number; bytes?: number } | null = null;
    for (const size of media.photo.sizes) {
      const found = size instanceof Api.PhotoSize ? { w: size.w, h: size.h, bytes: size.size }
        : size instanceof Api.PhotoSizeProgressive ? { w: size.w, h: size.h, bytes: size.sizes.at(-1) }
          : null;
      if (found && (!best || found.w * found.h >= best.w * best.h)) best = found;
    }
    return { kind: 'photo', mime: 'image/jpeg', width: best?.w, height: best?.h, bytes: best?.bytes };
  }
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const d = media.document;
    // Stickers are WebP documents, and GIFs and voice notes documents too; none is a photo to forward.
    const special = d.attributes.some((a) => a instanceof Api.DocumentAttributeSticker
      || a instanceof Api.DocumentAttributeAnimated || a instanceof Api.DocumentAttributeVideo
      || a instanceof Api.DocumentAttributeAudio);
    if (special) return { kind: 'other' };
    return { kind: 'document', mime: d.mimeType, bytes: Number(d.size) };
  }
  return { kind: 'other' };
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
  const others = new Map<string, Api.TypeInputPeer>();
  // A chat joined since connecting is not in the cached dialogs yet.
  const peerOf = async (chatId: string | undefined): Promise<Api.TypeInputPeer> => {
    if (!chatId || chatId === cfg.chatId) return peer;
    let p = others.get(chatId);
    if (!p) {
      p = await tg.getInputEntity(chatId).catch(async () => {
        await tg.getDialogs({ limit: 200 });
        return tg.getInputEntity(chatId);
      });
      others.set(chatId, p);
    }
    return p;
  };

  const topicOf = (m: Api.Message): number | null => {
    const r = m.replyTo;
    if (!(r instanceof Api.MessageReplyHeader) || !r.forumTopic) return null;
    return r.replyToTopId ?? r.replyToMsgId ?? null;
  };
  const replyTo = (topicId?: number, replyToId?: number) =>
    topicId || replyToId
      ? new Api.InputReplyToMessage({ replyToMsgId: replyToId ?? topicId!, topMsgId: topicId })
      : undefined;
  const sentIds = (updates: Api.TypeUpdates): number[] => {
    const list = 'updates' in updates ? updates.updates : [];
    const made = list.flatMap((u) =>
      (u instanceof Api.UpdateNewChannelMessage || u instanceof Api.UpdateNewMessage) && 'id' in u.message ? [u.message.id] : []);
    const ids = made.length ? made : list.flatMap((u) => (u instanceof Api.UpdateMessageID ? [u.id] : []));
    return ids.sort((a, b) => a - b);
  };
  const sentId = (updates: Api.TypeUpdates): number => sentIds(updates)[0] ?? 0;
  const upload = (f: TelegramUpload) =>
    tg.uploadFile({ file: new CustomFile(f.name, f.bytes.length, '', f.bytes), workers: 1 });

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
            media: mediaOf(m),
            groupedId: m.groupedId ? m.groupedId.toString() : undefined,
          };
        });
    },
    async send(text, { topicId, replyToId, chatId }) {
      const updates = await tg.invoke(new Api.messages.SendMessage({
        peer: await peerOf(chatId), message: text, noWebpage: true, randomId: helpers.generateRandomLong(), replyTo: replyTo(topicId, replyToId),
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
    async sendPhotos(files, caption, topicId) {
      if (files.length === 1) {
        const updates = await tg.invoke(new Api.messages.SendMedia({
          peer, media: new Api.InputMediaUploadedPhoto({ file: await upload(files[0]!) }), message: caption ?? '',
          randomId: helpers.generateRandomLong(), replyTo: replyTo(topicId),
        }));
        return sentIds(updates);
      }
      // An album takes photos already on Telegram's side: each is uploaded,
      // turned into a photo, then the album points at those.
      const media: Api.InputMediaPhoto[] = [];
      for (const f of files) {
        const done = await tg.invoke(new Api.messages.UploadMedia({
          peer, media: new Api.InputMediaUploadedPhoto({ file: await upload(f) }),
        }));
        if (!(done instanceof Api.MessageMediaPhoto) || !(done.photo instanceof Api.Photo)) {
          throw new TelegramError('Telegram did not take the photo', 500, null);
        }
        const { id, accessHash, fileReference } = done.photo;
        media.push(new Api.InputMediaPhoto({ id: new Api.InputPhoto({ id, accessHash, fileReference }) }));
      }
      const updates = await tg.invoke(new Api.messages.SendMultiMedia({
        peer, replyTo: replyTo(topicId),
        multiMedia: media.map((m, i) => new Api.InputSingleMedia({
          media: m, message: i === 0 ? caption ?? '' : '', randomId: helpers.generateRandomLong(),
        })),
      }));
      return sentIds(updates);
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
    async download(messageId) {
      const [m] = await tg.getMessages(peer, { ids: [messageId] });
      if (!(m instanceof Api.Message) || !m.media) throw new TelegramError('the message has no file', 400, null);
      const bytes = await tg.downloadMedia(m, {});
      if (!Buffer.isBuffer(bytes)) throw new TelegramError('Telegram gave no file', 400, null);
      return bytes;
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
