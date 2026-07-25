// Attachment storage for sell-order status evidence and label-scan images.
// Uses Cloudflare R2 via its S3-compatible API. When the R2 env vars are
// absent (dev / tests), returns a stub key + data: URL so the app still works.

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { SAFE_UPLOAD_MIME } from './lib/settings';
import type { Env } from './types';

export type UploadResult = {
  storageKey: string;
  deliveryUrl: string;
  provider: 'r2' | 'stub';
};

// Thrown by uploadAttachment if the file's declared MIME isn't on the safe
// allowlist. Routes catch this and convert to a 415. Defence-in-depth: the
// route layer already runs the same check via getUploadLimits, but if a new
// caller forgets to gate, the storage layer still refuses to forward a
// hostile Content-Type to a public bucket.
export class UnsafeMimeError extends Error {
  constructor(public readonly mime: string) {
    super(`unsupported file type: ${mime || 'unknown'}`);
    this.name = 'UnsafeMimeError';
  }
}

// The SDK client is designed to be reused (connection pooling, credential
// caching). Constructing one per upload/delete added latency and socket
// churn under load — memoize by the credential tuple instead.
let cached: { key: string; client: S3Client } | null = null;

function client(env: Env): S3Client | null {
  if (
    !env.R2_S3_ENDPOINT ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY ||
    !env.R2_BUCKET ||
    !env.R2_ATTACHMENTS_PUBLIC_URL
  ) {
    return null;
  }
  const key = `${env.R2_S3_ENDPOINT} ${env.R2_ACCESS_KEY_ID} ${env.R2_SECRET_ACCESS_KEY}`;
  if (cached && cached.key === key) return cached.client;
  const s3 = new S3Client({
    region: 'auto',
    endpoint: env.R2_S3_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  cached = { key, client: s3 };
  return s3;
}

export async function uploadAttachment(
  env: Env,
  file: File,
  prefix: string,
): Promise<UploadResult> {
  // Public R2 bucket: never trust the client MIME to set Content-Type. The
  // safe set is small (PDF + raster images) and any unknown / hostile type
  // (image/svg+xml, text/html, application/javascript, …) is refused at the
  // storage layer too. Stub uploads in dev/tests run the same gate so a
  // forged MIME can't pass through CI either.
  const declared = (file.type || '').toLowerCase();
  if (!SAFE_UPLOAD_MIME.has(declared)) {
    throw new UnsafeMimeError(declared);
  }

  const s3 = client(env);
  if (!s3) {
    const stubId = 'stub-' + crypto.randomUUID();
    return {
      storageKey: stubId,
      deliveryUrl: `data:${declared};name=${encodeURIComponent(file.name)}`,
      provider: 'stub',
    };
  }

  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
  const key = `${prefix}/${crypto.randomUUID()}-${safeName}`;
  const body = new Uint8Array(await file.arrayBuffer());
  // Images and PDFs are viewed in place (lightbox / inline PDF), so they keep
  // the default disposition. Everything else — spreadsheets today — is forced
  // to download, so the browser never gets to decide what to do with a type
  // served from a public bucket.
  const inline = declared.startsWith('image/') || declared === 'application/pdf';
  await s3.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: declared,
      ...(inline ? {} : { ContentDisposition: `attachment; filename="${safeName}"` }),
    }),
    { abortSignal: AbortSignal.timeout(15_000) },
  );
  return {
    storageKey: key,
    deliveryUrl: `${env.R2_ATTACHMENTS_PUBLIC_URL!.replace(/\/$/, '')}/${key}`,
    provider: 'r2',
  };
}

// Best-effort read: callers embed the bytes into generated documents, and a
// missing or unreachable object must degrade to "no image", never an error.
export async function getAttachmentBytes(env: Env, storageKey: string): Promise<Buffer | null> {
  if (storageKey.startsWith('stub-')) return null;
  const s3 = client(env);
  if (!s3) return null;
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: storageKey }),
      { abortSignal: AbortSignal.timeout(10_000) },
    );
    if (!res.Body) return null;
    return Buffer.from(await res.Body.transformToByteArray());
  } catch {
    return null;
  }
}

export async function deleteAttachment(env: Env, storageKey: string): Promise<void> {
  if (storageKey.startsWith('stub-')) return;
  const s3 = client(env);
  if (!s3) return;
  await s3.send(
    new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: storageKey }),
    { abortSignal: AbortSignal.timeout(15_000) },
  );
}
