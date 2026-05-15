// R2 attachment helper for sell-order status evidence (Shipped / Awaiting
// payment / Done). Mirrors images.ts: if the R2_ATTACHMENTS binding and
// R2_ATTACHMENTS_PUBLIC_URL env var are present, files go to R2; otherwise
// a stub key + data: URL placeholder is returned so dev works without R2.

import type { Env } from './types';

export type UploadResult = {
  storageKey: string;
  deliveryUrl: string;
  provider: 'r2' | 'stub';
};

export async function uploadAttachment(
  env: Env,
  file: File,
  prefix: string,
): Promise<UploadResult> {
  const bucket = env.R2_ATTACHMENTS;
  const publicBase = env.R2_ATTACHMENTS_PUBLIC_URL;

  if (!bucket || !publicBase) {
    const stubId = 'stub-' + crypto.randomUUID();
    return {
      storageKey: stubId,
      deliveryUrl: `data:${file.type || 'application/octet-stream'};name=${encodeURIComponent(file.name)}`,
      provider: 'stub',
    };
  }

  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
  const key = `${prefix}/${crypto.randomUUID()}-${safeName}`;
  await bucket.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });
  return {
    storageKey: key,
    deliveryUrl: `${publicBase.replace(/\/$/, '')}/${key}`,
    provider: 'r2',
  };
}

export async function deleteAttachment(env: Env, storageKey: string): Promise<void> {
  if (!env.R2_ATTACHMENTS) return;
  if (storageKey.startsWith('stub-')) return;
  await env.R2_ATTACHMENTS.delete(storageKey);
}
