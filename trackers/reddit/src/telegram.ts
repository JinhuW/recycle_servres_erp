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

export interface SendReport {
  delivered: string[];
  failed: Array<{chatId: string; error: string}>;
}

const TELEGRAM_TIMEOUT_MS = 20_000;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Composes the alert body: what the item is, what it costs, where to find it. */
export function formatAlert(alert: AlertContent): string {
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

async function sendOne(
  botToken: string,
  chatId: string,
  text: string,
  sleep: (ms: number) => Promise<void>,
): Promise<{ok: true} | {ok: false; error: string}> {
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
    };
    if (response.ok && payload.ok === true) return {ok: true};
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
  const report: SendReport = {delivered: [], failed: []};

  for (const chatId of chatIds) {
    const result = await sendOne(botToken, chatId, text, sleep);
    if (result.ok) report.delivered.push(chatId);
    else report.failed.push({chatId, error: result.error});
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
