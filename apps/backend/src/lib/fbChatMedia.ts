import { createHash } from 'node:crypto';

import { FB_CHAT_MEDIA_MAX_STORED_BYTES, FB_CHAT_MEDIA_MIMES } from '@recycle-erp/shared';
import sharp from 'sharp';

import type { SqlLike } from '../db';
import { getAttachmentBytes, uploadAttachment } from '../r2';
import type { Env } from '../types';
import { ImageRejectedError, shrinkImageToFit } from './image-shrink';
import { getUploadLimits } from './settings';

// Photos in Facebook chats, kept once per sha256 of the bytes as received.
// Facebook's links are signed and expire, so this copy is what the chats page
// and Telegram read. The bucket is public, so the key is unguessable and
// readers still go through `GET /api/fb-chat/media/:id`, never the bucket URL.

export type FbChatMediaSource = 'facebook' | 'telegram' | 'erp';

export type FbChatMediaFile = { bytes: Buffer; mime: string };

const MIMES: ReadonlySet<string> = new Set(FB_CHAT_MEDIA_MIMES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isFbChatMediaId = (s: unknown): s is string => typeof s === 'string' && UUID.test(s);

export { ImageRejectedError };

/** The photo could not be brought under the stored size limit. */
export class FbChatMediaTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`photo is larger than ${maxBytes} bytes after shrinking`);
    this.name = 'FbChatMediaTooLargeError';
  }
}

/**
 * Stores one photo and answers its id; bytes seen before answer the existing
 * id. Throws `ImageRejectedError` for anything that is not a JPEG, PNG or WebP
 * that decodes, and `StorageUnavailableError` in production without R2.
 * Callers check the upload size first.
 */
export async function storeFbChatMedia(
  sql: SqlLike,
  env: Env,
  bytes: Uint8Array,
  declaredMime: string,
  source: FbChatMediaSource,
): Promise<{ id: string; created: boolean }> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const [seen] = await sql<{ id: string }[]>`SELECT id::text AS id FROM fb_chat_media WHERE sha256 = ${sha256}`;
  if (seen) return { id: seen.id, created: false };

  const mime = declaredMime.toLowerCase().split(';')[0]!.trim();
  // Every stored file answers to the workspace upload settings, which can
  // only narrow what this table takes.
  const limits = await getUploadLimits(sql);
  if (!MIMES.has(mime) || !limits.allowedMime.has(mime)) throw new ImageRejectedError('wrong_format');
  const maxBytes = Math.min(FB_CHAT_MEDIA_MAX_STORED_BYTES, limits.maxBytes);
  const file = await shrinkImageToFit(
    new File([new Uint8Array(bytes)], `photo.${mime.slice(6)}`, { type: mime }),
    maxBytes,
    { strict: true },
  );
  // The shrink gives up after a few passes and hands the file back as it was.
  if (file.size > maxBytes) throw new FbChatMediaTooLargeError(maxBytes);
  const body = Buffer.from(await file.arrayBuffer());
  const meta = await sharp(body).metadata();
  const stored = await uploadAttachment(env, file, 'fb-chat');
  const stub = stored.provider === 'stub' ? body : null;

  const [row] = await sql<{ id: string }[]>`
    INSERT INTO fb_chat_media (sha256, source, storage_key, stub_bytes, mime, bytes, width, height)
    VALUES (${sha256}, ${source}, ${stored.storageKey}, ${stub}, ${file.type}, ${body.length},
            ${meta.width ?? null}, ${meta.height ?? null})
    ON CONFLICT (sha256) DO NOTHING
    RETURNING id::text AS id`;
  if (row) return { id: row.id, created: true };
  // Another upload of the same bytes won the race; its object is the one kept.
  const [other] = await sql<{ id: string }[]>`SELECT id::text AS id FROM fb_chat_media WHERE sha256 = ${sha256}`;
  return { id: other!.id, created: false };
}

/** The stored photo, or null when the id is unknown or the object cannot be read. */
export async function fbChatMediaFile(sql: SqlLike, env: Env, id: string): Promise<FbChatMediaFile | null> {
  if (!isFbChatMediaId(id)) return null;
  const [row] = await sql<{ storage_key: string; stub_bytes: Buffer | null; mime: string }[]>`
    SELECT storage_key, stub_bytes, mime FROM fb_chat_media WHERE id = ${id}`;
  if (!row) return null;
  const bytes = row.stub_bytes ?? await getAttachmentBytes(env, row.storage_key);
  return bytes ? { bytes, mime: row.mime } : null;
}
