// Builds the app Env from process.env. Replaces Cloudflare's injected
// bindings now that the backend runs as a plain Node process.

import type { Env } from './types';

export function buildEnv(src: NodeJS.ProcessEnv = process.env): Env {
  if (!src.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  if (!src.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (src.NODE_ENV === 'production' && !src.CORS_ALLOWED_ORIGINS) {
    throw new Error('CORS_ALLOWED_ORIGINS is required in production');
  }
  // The stub OCR provider returns canned data with a fixed high confidence —
  // safe for dev/tests, catastrophic in prod where users would trust it as
  // real readings. Refuse to boot prod without a real key.
  if (src.NODE_ENV === 'production' && !src.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required in production (the stub OCR returns canned data)');
  }
  return {
    DATABASE_URL: src.DATABASE_URL,
    JWT_SECRET: src.JWT_SECRET,
    JWT_ISSUER: src.JWT_ISSUER ?? 'recycle-erp',
    STUB_LOW_CONF: src.STUB_LOW_CONF,
    OPENROUTER_API_KEY: src.OPENROUTER_API_KEY,
    OPENROUTER_OCR_MODEL: src.OPENROUTER_OCR_MODEL,
    R2_S3_ENDPOINT: src.R2_S3_ENDPOINT,
    R2_ACCESS_KEY_ID: src.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: src.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: src.R2_BUCKET,
    R2_ATTACHMENTS_PUBLIC_URL: src.R2_ATTACHMENTS_PUBLIC_URL,
    CORS_ALLOWED_ORIGINS: src.CORS_ALLOWED_ORIGINS,
    NODE_ENV: src.NODE_ENV,
    ENABLE_DEMO_ACCOUNTS: src.ENABLE_DEMO_ACCOUNTS,
  };
}
