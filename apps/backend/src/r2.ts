// Attachment storage for sell-order status evidence and label-scan images.
// Uses Cloudflare R2 via its S3-compatible API. When the R2 env vars are
// absent (dev / tests), returns a stub key + data: URL so the app still works.

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { Env } from './types';

export type UploadResult = {
  storageKey: string;
  deliveryUrl: string;
  provider: 'r2' | 'stub';
};

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
  return new S3Client({
    region: 'auto',
    endpoint: env.R2_S3_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
}

export async function uploadAttachment(
  env: Env,
  file: File,
  prefix: string,
): Promise<UploadResult> {
  const s3 = client(env);
  if (!s3) {
    const stubId = 'stub-' + crypto.randomUUID();
    return {
      storageKey: stubId,
      deliveryUrl: `data:${file.type || 'application/octet-stream'};name=${encodeURIComponent(file.name)}`,
      provider: 'stub',
    };
  }

  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
  const key = `${prefix}/${crypto.randomUUID()}-${safeName}`;
  const body = new Uint8Array(await file.arrayBuffer());
  await s3.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: file.type || 'application/octet-stream',
    }),
  );
  return {
    storageKey: key,
    deliveryUrl: `${env.R2_ATTACHMENTS_PUBLIC_URL!.replace(/\/$/, '')}/${key}`,
    provider: 'r2',
  };
}

export async function deleteAttachment(env: Env, storageKey: string): Promise<void> {
  if (storageKey.startsWith('stub-')) return;
  const s3 = client(env);
  if (!s3) return;
  await s3.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: storageKey }));
}
