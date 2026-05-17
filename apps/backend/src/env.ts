// Builds the app Env from process.env. Replaces Cloudflare's injected
// bindings now that the backend runs as a plain Node process.

import type { Env } from './types';

export function buildEnv(src: NodeJS.ProcessEnv = process.env): Env {
  if (!src.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
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
  };
}
