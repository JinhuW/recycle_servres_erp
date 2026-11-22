// A thin Bot API caller for the features that need more than one-way text
// (forum topics, updates, reactions, photos sent as bytes). The URL carries
// the token, so an error names Telegram's own description only.

const TIMEOUT_MS = 10_000;
// An album is up to ten photos of up to 8 MB each, sent in one request.
const UPLOAD_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export class TelegramError extends Error {
  constructor(message: string, readonly code: number, readonly retryAfterSec: number | null) {
    super(message);
  }
}

/**
 * A file sent as its bytes. It goes as `photo` itself, or as the `media` of an
 * item in a `sendMediaGroup` list; the caller turns it into a multipart part.
 */
export class TelegramUpload {
  constructor(readonly bytes: Buffer, readonly mime: string, readonly name: string) {}
}

export type TelegramCall = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;

/**
 * `downloadFile` is not a Bot API method: both callers answer it with the
 * bytes of the file `file_id` names, so the hub reads a photo the same way in
 * either mode. A refusal on Telegram's side is a `TelegramError` below 500.
 */
export const DOWNLOAD_FILE = 'downloadFile';
export type TelegramDownload = { bytes: Buffer };

type MediaItem = Record<string, unknown> & { media?: unknown };

const hasUpload = (params: Record<string, unknown>): boolean =>
  Object.values(params).some((v) => v instanceof TelegramUpload
    || (Array.isArray(v) && v.some((item) => (item as MediaItem)?.media instanceof TelegramUpload)));

/** The multipart body for a call that carries files; other fields as the Bot API reads them from a form. */
export function telegramForm(params: Record<string, unknown>): FormData {
  const form = new FormData();
  const blob = (u: TelegramUpload) => new Blob([new Uint8Array(u.bytes)], { type: u.mime });
  let parts = 0;
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (value instanceof TelegramUpload) {
      form.append(key, blob(value), value.name);
    } else if (Array.isArray(value) && value.some((item) => (item as MediaItem)?.media instanceof TelegramUpload)) {
      // An album names each file by an attach:// reference to its own part.
      const items = value.map((item: MediaItem) => {
        if (!(item.media instanceof TelegramUpload)) return item;
        const part = `file${parts++}`;
        form.append(part, blob(item.media), item.media.name);
        return { ...item, media: `attach://${part}` };
      });
      form.append(key, JSON.stringify(items));
    } else {
      form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
  return form;
}

export function telegramCaller(token: string): TelegramCall {
  const call = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const upload = hasUpload(params);
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, upload
      ? { method: 'POST', body: telegramForm(params), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) }
      : {
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
  // A bot is served files of up to 20 MB: getFile refuses bigger ones with a 400.
  const download = async (fileId: string): Promise<TelegramDownload> => {
    const file = await call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!file.file_path) throw new TelegramError('Telegram gave no path for the file', 400, null);
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new TelegramError(`Telegram refused the file download (${res.status})`, res.status, null);
    return { bytes: Buffer.from(await res.arrayBuffer()) };
  };
  return async <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    method === DOWNLOAD_FILE ? download(String(params.file_id)) as Promise<T> : call<T>(method, params);
}
