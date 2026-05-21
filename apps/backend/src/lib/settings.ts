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
// Absolute ceiling for upload_max_bytes regardless of workspace config, and
// the HTTP-level body-limit cap. Uploads are buffered fully in memory by
// c.req.formData(), so an unbounded setting risks OOM-killing the container.
export const UPLOAD_HARD_CAP_BYTES = 50 * 1024 * 1024;
// Stored-XSS guard: attachments land in a public R2 bucket and are served with
// their declared Content-Type. SVG and HTML render scripts in the browser, so
// they're not on the list; PDFs render inline but are sandboxed by the browser
// so they stay allowed.
export const DEFAULT_UPLOAD_ALLOWED_MIME = [
  'application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp',
];
// Hard allowlist enforced at the route layer AND on the R2 PutObject — the
// workspace setting can only narrow this set, never widen it. Anything outside
// the list is rejected before we ever set ContentType on R2 (the route layer
// already strips the client MIME on read, but a defence-in-depth check at the
// storage layer is cheap insurance against a future bypass).
export const SAFE_UPLOAD_MIME = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp',
]);

export async function getUploadLimits(
  sql: Sql,
): Promise<{ maxBytes: number; allowedMime: Set<string> }> {
  const [maxBytes, mimeList] = await Promise.all([
    getWorkspaceSetting(sql, 'upload_max_bytes', DEFAULT_UPLOAD_MAX_BYTES),
    getWorkspaceSetting<string[]>(sql, 'upload_allowed_mime', DEFAULT_UPLOAD_ALLOWED_MIME),
  ]);
  // Intersect with the hard allowlist — the workspace setting can only narrow,
  // never widen. A bad migration / legacy seed that snuck image/svg+xml or
  // text/html in there must NOT propagate to upload acceptance.
  const allowedMime = new Set(mimeList.filter(m => SAFE_UPLOAD_MIME.has(m)));
  return { maxBytes, allowedMime };
}
