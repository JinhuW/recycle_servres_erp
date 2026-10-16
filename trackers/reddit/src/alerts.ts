// Where a buy alert goes. Telegram is the production transport; console is for
// running the pipeline before a bot token exists, so the LLM's verdicts can be
// read straight off the worker's log.
//
// Both transports report per-recipient results in the same shape, so the notify
// loop's claim/mark-notified logic does not change between them.

import {formatAlert, sendAlert, type AlertContent, type SendReport} from './telegram.ts';

export type AlertTransport = 'telegram' | 'console';

export interface AlertSender {
  readonly transport: AlertTransport;
  /**
   * Whether the transport is useless without recipients. Telegram has nowhere
   * to send with an empty chat list, so the notify loop holds targets back;
   * the console always has somewhere to write.
   */
  readonly requiresRecipients: boolean;
  send(chatIds: string[], alert: AlertContent): Promise<SendReport>;
}

/** Undoes the HTML entities and tags formatAlert adds for Telegram. */
function toPlainText(html: string): string {
  return html
    .replace(/<\/?[a-z]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const RULE = '─'.repeat(64);

export function createConsoleAlertSender(
  print: (text: string) => void = (text) => process.stdout.write(`${text}\n`),
): AlertSender {
  return {
    transport: 'console',
    requiresRecipients: false,
    async send(chatIds: string[], alert: AlertContent): Promise<SendReport> {
      print([RULE, 'BUY ALERT', '', toPlainText(formatAlert(alert)), RULE].join('\n'));
      // Report the configured chats when there are any, so the log still shows
      // who would have been messaged once a bot token is wired up.
      return {delivered: chatIds.length > 0 ? [...chatIds] : ['console'], failed: []};
    },
  };
}

export function createTelegramAlertSender(botToken: string): AlertSender {
  return {
    transport: 'telegram',
    requiresRecipients: true,
    async send(chatIds: string[], alert: AlertContent): Promise<SendReport> {
      return sendAlert(botToken, chatIds, alert);
    },
  };
}

export function createAlertSender(
  transport: AlertTransport,
  botToken: string,
): AlertSender {
  return transport === 'console'
    ? createConsoleAlertSender()
    : createTelegramAlertSender(botToken);
}
