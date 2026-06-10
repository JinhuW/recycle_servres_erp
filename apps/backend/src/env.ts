// Builds the app Env from process.env. Replaces Cloudflare's injected
// bindings now that the backend runs as a plain Node process.

import type { Env } from './types';

// Values that ship in the repo (Dockerfile ENV / .env.example). Sessions are
// HS256-signed with JWT_SECRET, so booting prod on a published value means
// anyone can mint a valid cookie for any user — refuse instead.
const KNOWN_DEFAULT_JWT_SECRETS = new Set([
  'dev-jwt-secret-change-me-in-prod',
  'dev-secret-change-me',
]);

export function buildEnv(src: NodeJS.ProcessEnv = process.env): Env {
  if (!src.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  if (!src.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (src.NODE_ENV === 'production' && KNOWN_DEFAULT_JWT_SECRETS.has(src.JWT_SECRET)) {
    throw new Error('JWT_SECRET is set to a published default — set a real secret in production');
  }
  if (src.NODE_ENV === 'production') {
    // The compose file falls back to the documented dev password when
    // POSTGRES_PASSWORD is unset; don't let that combination reach prod.
    try {
      if (new URL(src.DATABASE_URL).password === 'recycle') {
        throw new Error('DATABASE_URL uses the default dev password in production');
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('default dev password')) throw e;
      // unparseable URL: let the DB driver surface it
    }
  }
  if (src.NODE_ENV === 'production' && !src.CORS_ALLOWED_ORIGINS) {
    throw new Error('CORS_ALLOWED_ORIGINS is required in production');
  }
  // The stub OCR provider returns canned data with a fixed high confidence —
  // safe for dev/tests, catastrophic in prod where users would trust it as
  // real readings. Refuse to boot prod without a real key.
  if (src.NODE_ENV === 'production' && !src.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required in production (the stub OCR returns canned data)');
  }
  if (src.NODE_ENV === 'production' && !src.OAUTH_SIGNING_KEY_CURRENT) {
    throw new Error('OAUTH_SIGNING_KEY_CURRENT must be set in production');
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
    OAUTH_ISSUER_URL: src.OAUTH_ISSUER_URL,
    OAUTH_SIGNING_KEY_CURRENT: src.OAUTH_SIGNING_KEY_CURRENT,
    OAUTH_SIGNING_KEY_PREVIOUS: src.OAUTH_SIGNING_KEY_PREVIOUS,
    OAUTH_ACCESS_TOKEN_TTL_SEC: src.OAUTH_ACCESS_TOKEN_TTL_SEC,
    OAUTH_REFRESH_TOKEN_TTL_SEC: src.OAUTH_REFRESH_TOKEN_TTL_SEC,
    OAUTH_DCR_OPEN: src.OAUTH_DCR_OPEN,
  };
}
