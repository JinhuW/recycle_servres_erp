// Buyer alerts sent as a Telegram user account rather than the bot. Telegram
// tells only the sender who read a message, and only to a user account, so
// this is the one way the Seen tab gets its read lists. The bot stays behind
// it: a chat the user account cannot reach still gets the alert from the bot.
//
// A user session must live in one process. The same auth key used from
// several IPs at once gets revoked (AUTH_KEY_DUPLICATED), so only the api,
// which runs as a single copy, ever opens it.

import {Api, TelegramClient} from 'telegram';
import {StringSession} from 'telegram/sessions/index.js';
import type {AlertSender} from './alerts.ts';
import type {Logger} from './logger.ts';
import {formatAlert, type AlertContent, type SendReport} from './telegram.ts';

export interface UserCredentials {
  apiId: number;
  apiHash: string;
  session: string;
}

export interface ReadReceipt {
  userId: string;
  readAt: Date;
}

export interface ChatMember {
  userId: string;
  name: string;
  username: string | null;
}

/** What the reads loop and the sender need from Telegram, so tests can fake it. */
export interface UserClient {
  readonly selfId: string;
  sendHtml(chatId: string, html: string): Promise<number>;
  readers(chatId: string, messageId: number): Promise<ReadReceipt[]>;
  /**
   * complete is false when Telegram listed fewer people than the chat holds
   * (hidden members, lost admin rights), so absence there means nothing.
   */
  members(chatId: string): Promise<{members: ChatMember[]; complete: boolean}>;
  disconnect(): Promise<void>;
}

export async function connectUserClient(
  creds: UserCredentials,
  logger: Logger,
): Promise<UserClient> {
  const client = new TelegramClient(new StringSession(creds.session), creds.apiId, creds.apiHash, {
    connectionRetries: 5,
  });
  client.setLogLevel('error' as never);
  let me: Api.User;
  try {
    await client.connect();
    me = await client.getMe();
    // Fills GramJS's entity cache, without which a bare -100… chat id does not
    // resolve to a peer: a user account needs the chat's access hash.
    await client.getDialogs({});
  } catch (e) {
    await client.destroy().catch(() => {});
    throw e;
  }
  logger.info('telegram user session up', {userId: String(me.id), username: me.username ?? null});

  // A chat added to the settings after boot is not in the cache yet. Reload
  // the dialogs to find it, but not on every miss: a chat the account was
  // never in stays a miss.
  let dialogsAt = Date.now();
  async function peer(chatId: string): Promise<Api.TypeInputPeer> {
    try {
      return await client.getInputEntity(chatId);
    } catch (e) {
      if (Date.now() - dialogsAt < DIALOGS_RELOAD_MS) throw e;
      dialogsAt = Date.now();
      await client.getDialogs({});
      return client.getInputEntity(chatId);
    }
  }

  return {
    selfId: String(me.id),
    async sendHtml(chatId, html) {
      const message = await client.sendMessage(await peer(chatId), {message: html, parseMode: 'html', linkPreview: true});
      return message.id;
    },
    async readers(chatId, messageId) {
      const result = await client.invoke(new Api.messages.GetMessageReadParticipants({
        peer: await peer(chatId),
        msgId: messageId,
      }));
      return result.map((r) => ({userId: String(r.userId), readAt: new Date(r.date * 1000)}));
    },
    async members(chatId) {
      const users = await client.getParticipants(await peer(chatId), {});
      return {
        complete: users.length >= (users.total ?? 0),
        members: users
          .filter((u) => !u.bot && !u.deleted)
          .map((u) => ({
            userId: String(u.id),
            name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || String(u.id),
            username: u.username ?? null,
          })),
      };
    },
    async disconnect() {
      await client.destroy();
    },
  };
}

const DIALOGS_RELOAD_MS = 10 * 60_000;

/**
 * A basic group's message ids are per account: the id the user account gets
 * back is not the one the bot's reaction updates carry, so reactions on a
 * user-sent alert there would match no post. Supergroups share ids.
 */
function isBasicGroup(chatId: string): boolean {
  return /^-(?!100)\d+$/.test(chatId);
}

/**
 * Sends each buyer alert as the user account, and through the bot to any
 * chat the user account failed or a basic group. Reviews stay with the bot: the dev chat's
 * reads are not what the Seen tab is about.
 */
export function createUserFirstSender(user: UserClient, bot: AlertSender): AlertSender {
  return {
    transport: bot.transport,
    requiresRecipients: true,
    async send(chatIds: string[], alert: AlertContent): Promise<SendReport> {
      const report: SendReport = {delivered: [], sent: [], failed: []};
      const botOnly = chatIds.filter(isBasicGroup);
      const fallback: Array<{chatId: string; error: string}> = [];
      for (const chatId of chatIds) {
        if (isBasicGroup(chatId)) continue;
        try {
          const messageId = await user.sendHtml(chatId, formatAlert(alert));
          report.delivered.push(chatId);
          report.sent.push({chatId, messageId, sentAs: 'user'});
        } catch (e) {
          fallback.push({chatId, error: e instanceof Error ? e.message : String(e)});
        }
      }
      if (botOnly.length === 0 && fallback.length === 0) return report;

      const viaBot = await bot.send([...botOnly, ...fallback.map((f) => f.chatId)], alert);
      report.delivered.push(...viaBot.delivered);
      report.sent.push(...viaBot.sent);
      // A chat only counts as failed when the bot failed it too; the user
      // account's error rides along so the warning says why it fell back.
      report.failed.push(...viaBot.failed.map((f) => {
        const userError = fallback.find((u) => u.chatId === f.chatId)?.error;
        return {chatId: f.chatId, error: userError ? `user: ${userError}; bot: ${f.error}` : f.error};
      }));
      if (fallback.length) report.fellBack = fallback;
      return report;
    },
    sendReview: (chatIds, review) => bot.sendReview(chatIds, review),
  };
}
