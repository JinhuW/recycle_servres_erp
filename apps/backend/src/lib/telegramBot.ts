// A thin Bot API caller for the features that need more than one-way text
// (forum topics, updates, reactions). The URL carries the token, so an error
// names Telegram's own description only.

const TIMEOUT_MS = 10_000;

export class TelegramError extends Error {
  constructor(message: string, readonly code: number, readonly retryAfterSec: number | null) {
    super(message);
  }
}

export type TelegramCall = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;

export function telegramCaller(token: string): TelegramCall {
  return async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null) as
      | { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } }
      | null;
    if (!res.ok || !body?.ok) {
      throw new TelegramError(body?.description ?? `Telegram refused ${method}`, body?.error_code ?? res.status,
        body?.parameters?.retry_after ?? null);
    }
    return body.result as T;
  };
}
