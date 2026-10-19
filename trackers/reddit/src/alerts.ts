// Where a buy alert goes. Telegram is the production transport; console is for
// running the pipeline before a bot token exists, so the LLM's verdicts can be
// read straight off the worker's log.
//
// Both transports report per-recipient results in the same shape, so the notify
// loop's claim/mark-notified logic does not change between them.

import {
  formatAlert,
  formatReview,
  sendAlert,
  sendReview,
  type AlertContent,
  type ReviewContent,
  type SendReport,
} from './telegram.ts';

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
  /** A dev-chat review: the alert plus each prompt's verdict and reasoning. */
  sendReview(chatIds: string[], review: ReviewContent): Promise<SendReport>;
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
      return printed('BUY ALERT', formatAlert(alert), chatIds);
    },
    async sendReview(chatIds: string[], review: ReviewContent): Promise<SendReport> {
      return printed('REVIEW', formatReview(review), chatIds);
    },
  };

  function printed(banner: string, html: string, chatIds: string[]): SendReport {
    print([RULE, banner, '', toPlainText(html), RULE].join('\n'));
    // Report the configured chats when there are any, so the log still shows
    // who would have been messaged once a bot token is wired up. No message
    // ids: nothing was sent that anyone could react to.
    return {delivered: chatIds.length > 0 ? [...chatIds] : ['console'], sent: [], failed: []};
  }
}

export function createTelegramAlertSender(botToken: string): AlertSender {
  return {
    transport: 'telegram',
    requiresRecipients: true,
    async send(chatIds: string[], alert: AlertContent): Promise<SendReport> {
      return sendAlert(botToken, chatIds, alert);
    },
    async sendReview(chatIds: string[], review: ReviewContent): Promise<SendReport> {
      return sendReview(botToken, chatIds, review);
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
