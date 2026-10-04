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

const MIN_PROD_JWT_SECRET_BYTES = 32;

export function buildEnv(src: NodeJS.ProcessEnv = process.env): Env {
  if (!src.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  if (!src.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (src.NODE_ENV === 'production' && KNOWN_DEFAULT_JWT_SECRETS.has(src.JWT_SECRET)) {
    throw new Error('JWT_SECRET is set to a published default — set a real secret in production');
  }
  // Any captured cookie is an offline brute-force target for its HS256 key,
  // so a short secret is as good as a published one.
  if (src.NODE_ENV === 'production' && Buffer.byteLength(src.JWT_SECRET) < MIN_PROD_JWT_SECRET_BYTES) {
    throw new Error(`JWT_SECRET must be at least ${MIN_PROD_JWT_SECRET_BYTES} bytes in production`);
  }
  // The Railway origin has a public hostname, and the proxy secret is the only
  // thing that keeps callers going through the Worker. The Docker stack has no
  // Worker in front and leaves it unset.
  if (src.NODE_ENV === 'production' && src.RAILWAY_ENVIRONMENT && !src.PROXY_SECRET) {
    throw new Error('PROXY_SECRET is required when running on Railway in production');
  }
  if (src.NODE_ENV === 'production') {
    // The compose file falls back to the documented dev password when
    // POSTGRES_PASSWORD is unset; don't let that combination reach prod.
    let password: string | undefined;
    try {
      password = new URL(src.DATABASE_URL).password;
    } catch {
      // unparseable URL: let the DB driver surface it
    }
    if (password === 'recycle') {
      throw new Error('DATABASE_URL uses the default dev password in production');
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
    TRACKER_API_URL: src.TRACKER_API_URL,
    TRACKER_API_TOKEN: src.TRACKER_API_TOKEN,
    COORDINATOR_API_URL: src.COORDINATOR_API_URL,
    COORDINATOR_API_TOKEN: src.COORDINATOR_API_TOKEN,
    COORDINATOR_ACCESS_CLIENT_ID: src.COORDINATOR_ACCESS_CLIENT_ID,
    COORDINATOR_ACCESS_CLIENT_SECRET: src.COORDINATOR_ACCESS_CLIENT_SECRET,
    SHIPPO_API_URL: src.SHIPPO_API_URL,
    SHIPPO_API_TOKEN: src.SHIPPO_API_TOKEN,
    SHIPPO_WEBHOOK_SECRET: src.SHIPPO_WEBHOOK_SECRET,
    MERCURY_API_URL: src.MERCURY_API_URL,
    MERCURY_API_TOKEN: src.MERCURY_API_TOKEN,
    PAYPAL_API_URL: src.PAYPAL_API_URL,
    PAYPAL_CLIENT_ID: src.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: src.PAYPAL_CLIENT_SECRET,
    BANKTX_STUB: src.BANKTX_STUB,
    MAIL_USER: src.MAIL_USER,
    MAIL_PASSWORD: src.MAIL_PASSWORD, // pragma: allowlist secret
    MAIL_SMTP_HOST: src.MAIL_SMTP_HOST,
    MAIL_SMTP_PORT: src.MAIL_SMTP_PORT,
    MAIL_IMAP_HOST: src.MAIL_IMAP_HOST,
    MAIL_IMAP_PORT: src.MAIL_IMAP_PORT,
    MAIL_STUB: src.MAIL_STUB,
    R2_S3_ENDPOINT: src.R2_S3_ENDPOINT,
    R2_ACCESS_KEY_ID: src.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: src.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: src.R2_BUCKET,
    R2_ATTACHMENTS_PUBLIC_URL: src.R2_ATTACHMENTS_PUBLIC_URL,
    CORS_ALLOWED_ORIGINS: src.CORS_ALLOWED_ORIGINS,
    PUBLIC_FORM_ORIGINS: src.PUBLIC_FORM_ORIGINS,
    PROXY_SECRET: src.PROXY_SECRET, // pragma: allowlist secret
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
