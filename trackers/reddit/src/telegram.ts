// Delivers buy alerts. Uses Telegram's HTML parse mode rather than MarkdownV2:
// HTML needs only three characters escaped, while MarkdownV2 reserves eighteen
// that appear constantly in real listing titles ([USA-NY] [H] ... [W] ...).

export interface AlertContent {
  subreddit: string;
  summary: string;
  price: string | null;
  url: string;
  title: string;
}

/** Reactions arrive keyed by (chat, message), so this is how they find the post. */
export interface SentMessage {
  chatId: string;
  messageId: number;
}

export interface SendReport {
  delivered: string[];
  sent: SentMessage[];
  failed: Array<{chatId: string; error: string}>;
}

/** One prompt's verdict on a post, as a review shows it. */
export interface VerdictNote {
  label: 'Live' | 'Candidate';
  promptVersionId: number | null;
  model: string | null;
  isTarget: boolean;
  reasoning: string;
}

export interface ReviewContent {
  alert: AlertContent;
  verdicts: VerdictNote[];
}

const TELEGRAM_TIMEOUT_MS = 20_000;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * A buyer alert: the body, then a request for the reaction that scores the
 * prompt which sent it. Without it nobody knew reactions counted. Any emoji
 * but 👎 counts as a good catch (the message_labels view).
 */
export function formatAlert(alert: AlertContent): string {
  return `${alertBody(alert)}\n\n<i>React with any emoji if it's a good catch, 👎 if it's not useful.</i>`;
}

/** What the item is, what it costs, where to find it. */
function alertBody(alert: AlertContent): string {
  return [
    `<b>r/${escapeHtml(alert.subreddit)}</b> — possible buy`,
    '',
    escapeHtml(alert.title),
    '',
    escapeHtml(alert.summary),
    `Price: ${alert.price ? escapeHtml(alert.price) : 'not stated'}`,
    '',
    alert.url,
  ].join('\n');
}

/** Keeps two verdicts and the alert well inside Telegram's 4096-char limit. */
const MAX_REASONING_CHARS = 600;

/**
 * Composes a dev-chat review: the alert as buyers would see it, which prompt
 * flagged it, and each prompt's reasoning, so a reaction can label the post.
 */
export function formatReview(review: ReviewContent): string {
  const flaggedBy = review.verdicts.filter((v) => v.isTarget).map((v) => v.label.toLowerCase());
  const header = flaggedBy.length > 0
    ? `🧪 <b>Review</b> — flagged by ${flaggedBy.join(' and ')}`
    : '🧪 <b>Review</b>';
  const verdicts = review.verdicts.flatMap((v) => {
    const version = v.promptVersionId === null ? 'unversioned' : `v${v.promptVersionId}`;
    // By code point, so a cut never splits an emoji Telegram would then refuse.
    const chars = [...v.reasoning];
    const reasoning = chars.length > MAX_REASONING_CHARS
      ? `${chars.slice(0, MAX_REASONING_CHARS).join('')}…`
      : v.reasoning;
    return [
      `<b>${v.label}</b> ${version} · ${escapeHtml(v.model ?? 'unknown model')} — `
        + (v.isTarget ? '✅ alert' : '❌ no alert'),
      `<i>${escapeHtml(reasoning)}</i>`,
    ];
  });
  return [
    header,
    '',
    alertBody(review.alert),
    '',
    ...verdicts,
    '',
    'React with any emoji if this is a lead, 👎 if it should not have alerted.',
  ].join('\n');
}

async function sendOne(
  botToken: string,
  chatId: string,
  text: string,
  sleep: (ms: number) => Promise<void>,
): Promise<{ok: true; messageId: number | null} | {ok: false; error: string}> {
  const attempt = async (): Promise<Response> => fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        // The Reddit link preview shows the listing's images — worth keeping.
        disable_web_page_preview: false,
      }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    },
  );

  try {
    let response = await attempt();

    if (response.status === 429) {
      const body = await response.json().catch(() => ({})) as {
        parameters?: {retry_after?: number};
      };
      const retryAfter = Math.min(body.parameters?.retry_after ?? 5, 60);
      await sleep(retryAfter * 1000);
      response = await attempt();
    }

    const payload = await response.json().catch(() => ({})) as {
      ok?: boolean;
      description?: string;
      result?: {message_id?: unknown};
    };
    if (response.ok && payload.ok === true) {
      const messageId = payload.result?.message_id;
      return {ok: true, messageId: typeof messageId === 'number' ? messageId : null};
    }
    return {ok: false, error: payload.description ?? `HTTP ${response.status}`};
  } catch (e) {
    return {ok: false, error: e instanceof Error ? e.message : String(e)};
  }
}

/**
 * Sends one message to every configured chat. Chats are independent: one bad
 * chat id must not stop the others from being alerted, so the caller decides
 * what to do from the per-chat report.
 */
export async function sendMessage(
  botToken: string,
  chatIds: string[],
  text: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<SendReport> {
  const report: SendReport = {delivered: [], sent: [], failed: []};

  for (const chatId of chatIds) {
    const result = await sendOne(botToken, chatId, text, sleep);
    if (result.ok) {
      report.delivered.push(chatId);
      if (result.messageId !== null) report.sent.push({chatId, messageId: result.messageId});
    } else {
      report.failed.push({chatId, error: result.error});
    }
  }

  return report;
}

export async function sendAlert(
  botToken: string,
  chatIds: string[],
  alert: AlertContent,
  sleep?: (ms: number) => Promise<void>,
): Promise<SendReport> {
  return sendMessage(botToken, chatIds, formatAlert(alert), sleep);
}

export async function sendReview(
  botToken: string,
  chatIds: string[],
  review: ReviewContent,
  sleep?: (ms: number) => Promise<void>,
): Promise<SendReport> {
  return sendMessage(botToken, chatIds, formatReview(review), sleep);
}
