import { describe, it, expect } from 'vitest';
import { buildEnv } from '../src/env';
import { uploadAttachment, copyAttachment, StorageUnavailableError } from '../src/r2';
import type { Env } from '../src/types';

const prodBase = {
  NODE_ENV: 'production',
  JWT_SECRET: 'x'.repeat(64),
  DATABASE_URL: 'postgres://app:not-the-default@db.internal:5432/erp',
  CORS_ALLOWED_ORIGINS: 'https://inventory.recycleservers.com',
  OPENROUTER_API_KEY: 'k',
  OAUTH_SIGNING_KEY_CURRENT: 'k',
};
const r2 = {
  R2_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', R2_ACCESS_KEY_ID: 'AK',
  R2_SECRET_ACCESS_KEY: 'SK', R2_BUCKET: 'b', R2_ATTACHMENTS_PUBLIC_URL: 'https://cdn.example.com',
};

// Half an R2 configuration used to fall back to the stub as quietly as none
// did, and every receipt uploaded in production was recorded as stored while
// its bytes went nowhere.
describe('attachment storage in production', () => {
  it('refuses to boot with R2 partially configured', () => {
    const { R2_BUCKET: _b, ...partial } = r2;
    expect(() => buildEnv({ ...prodBase, ...partial })).toThrow(/R2 is partially configured: missing R2_BUCKET/);
    expect(() => buildEnv({ ...prodBase, ...r2 })).not.toThrow();
    expect(() => buildEnv({ ...prodBase })).not.toThrow();
  });

  it('refuses an upload or copy instead of minting a stub', async () => {
    const env = { JWT_SECRET: 'x', NODE_ENV: 'production' } as Env;
    const file = new File([new Uint8Array([0xff, 0xd8])], 'r.jpg', { type: 'image/jpeg' });
    await expect(uploadAttachment(env, file, 'p')).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(copyAttachment(env, 'orders/x/y.jpg', 'https://cdn/x', 'p')).rejects.toBeInstanceOf(StorageUnavailableError);
    // Dev and tests keep the stub.
    expect((await uploadAttachment({ JWT_SECRET: 'x' } as Env, file, 'p')).provider).toBe('stub');
  });
});
