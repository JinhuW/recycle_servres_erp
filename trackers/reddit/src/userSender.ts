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
  members(chatId: string): Promise<ChatMember[]>;
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
  await client.connect();
  const me = await client.getMe();
  // Fills GramJS's entity cache, without which a bare -100… chat id does not
  // resolve to a peer.
  await client.getDialogs({limit: 100});
  logger.info('telegram user session up', {userId: String(me.id), username: me.username ?? null});

  return {
    selfId: String(me.id),
    async sendHtml(chatId, html) {
      const message = await client.sendMessage(chatId, {message: html, parseMode: 'html', linkPreview: true});
      return message.id;
    },
    async readers(chatId, messageId) {
      const result = await client.invoke(new Api.messages.GetMessageReadParticipants({
        peer: chatId,
        msgId: messageId,
      }));
      return result.map((r) => ({userId: String(r.userId), readAt: new Date(r.date * 1000)}));
    },
    async members(chatId) {
      const users = await client.getParticipants(chatId, {});
      return users
        .filter((u) => !u.bot && !u.deleted)
        .map((u) => ({
          userId: String(u.id),
          name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || String(u.id),
          username: u.username ?? null,
        }));
    },
    async disconnect() {
      await client.destroy();
    },
  };
}

/**
 * Sends each buyer alert as the user account, and through the bot to any
 * chat the user account failed. Reviews stay with the bot: the dev chat's
 * reads are not what the Seen tab is about.
 */
export function createUserFirstSender(user: UserClient, bot: AlertSender): AlertSender {
  return {
    transport: bot.transport,
    requiresRecipients: true,
    async send(chatIds: string[], alert: AlertContent): Promise<SendReport> {
      const report: SendReport = {delivered: [], sent: [], failed: []};
      const fallback: Array<{chatId: string; error: string}> = [];
      for (const chatId of chatIds) {
        try {
          const messageId = await user.sendHtml(chatId, formatAlert(alert));
          report.delivered.push(chatId);
          report.sent.push({chatId, messageId, sentAs: 'user'});
        } catch (e) {
          fallback.push({chatId, error: e instanceof Error ? e.message : String(e)});
        }
      }
      if (fallback.length === 0) return report;

      const viaBot = await bot.send(fallback.map((f) => f.chatId), alert);
      report.delivered.push(...viaBot.delivered);
      report.sent.push(...viaBot.sent);
      // A chat only counts as failed when the bot failed it too; the user
      // account's error rides along so the warning says why it fell back.
      report.failed.push(...viaBot.failed.map((f) => ({
        chatId: f.chatId,
        error: `user: ${fallback.find((u) => u.chatId === f.chatId)?.error}; bot: ${f.error}`,
      })));
      report.fellBack = fallback;
      return report;
    },
    sendReview: (chatIds, review) => bot.sendReview(chatIds, review),
  };
}
