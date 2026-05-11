// Cloudflare Images upload helper. Falls back to an in-memory data: URL when
// CF_ACCOUNT_ID / CF_IMAGES_TOKEN aren't set so the dev UX still works without
// a Cloudflare account.

import type { Env } from './types';

export type UploadResult = {
  imageId: string;
  deliveryUrl: string;
  provider: 'cloudflare' | 'stub';
};

export async function uploadLabelImage(env: Env, file: File): Promise<UploadResult> {
  const accountId = env.CF_ACCOUNT_ID;
  const token = env.CF_IMAGES_TOKEN;

  if (!accountId || !token) {
    // Dev fallback: skip the upload, return a placeholder we can persist for
    // audit. The frontend will still get an OCR result; production must set
    // both env vars.
    const stubId = 'stub-' + crypto.randomUUID();
    return {
      imageId: stubId,
      deliveryUrl: `data:image/placeholder;name=${stubId}`,
      provider: 'stub',
    };
  }

  const form = new FormData();
  form.append('file', file, file.name || 'label.jpg');
  // Tag uploads so they're filterable in the Images dashboard.
  form.append('metadata', JSON.stringify({ kind: 'label-scan' }));
  // Require a signed URL? `requireSignedURLs=true` if you want private images.
  form.append('requireSignedURLs', 'false');

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Cloudflare Images upload failed (${res.status}): ${body}`);
  }

  const json = (await res.json()) as {
    success: boolean;
    result?: { id: string; variants: string[] };
    errors?: { message: string }[];
  };

  if (!json.success || !json.result) {
    throw new Error('Cloudflare Images: ' + (json.errors?.[0]?.message ?? 'unknown error'));
  }

  // Pick the first variant URL (account default — usually `public`).
  return {
    imageId: json.result.id,
    deliveryUrl: json.result.variants[0],
    provider: 'cloudflare',
  };
}
