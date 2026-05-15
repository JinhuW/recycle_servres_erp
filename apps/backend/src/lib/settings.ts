// Read a single workspace_settings value (JSONB) with a typed fallback.
// Centralises the "thresholds live in the DB, not hardcoded" lookup so route
// handlers don't each re-implement the query. The fallback is only used when
// the key is absent — migration 0025 seeds the standard keys.

import postgres from 'postgres';

type Sql = ReturnType<typeof postgres>;

export async function getWorkspaceSetting<T>(
  sql: Sql,
  key: string,
  fallback: T,
): Promise<T> {
  const row = (await sql<{ value: unknown }[]>`
    SELECT value FROM workspace_settings WHERE key = ${key}
  `)[0];
  const v = row?.value;
  return v === undefined || v === null ? fallback : (v as T);
}

// Attachment / evidence upload constraints. Single source for both the
// generic attachments route and sell-order evidence uploads.
export const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_UPLOAD_ALLOWED_MIME = [
  'application/pdf', 'image/png', 'image/jpeg', 'image/jpg',
];

export async function getUploadLimits(
  sql: Sql,
): Promise<{ maxBytes: number; allowedMime: Set<string> }> {
  const [maxBytes, mimeList] = await Promise.all([
    getWorkspaceSetting(sql, 'upload_max_bytes', DEFAULT_UPLOAD_MAX_BYTES),
    getWorkspaceSetting<string[]>(sql, 'upload_allowed_mime', DEFAULT_UPLOAD_ALLOWED_MIME),
  ]);
  return { maxBytes, allowedMime: new Set(mimeList) };
}
