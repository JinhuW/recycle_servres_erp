// App configuration, built from process.env (see src/env.ts). Passed to the
// Hono app as `Bindings` so existing `c.env` / getDb(c.env) call sites work
// unchanged.

export type Env = {
  DATABASE_URL?: string;
  // Postgres pool size cap. Unset → 10 (prod default). The test harness sets it
  // low so its many parallel worker pools stay under max_connections.
  DB_POOL_MAX?: string;
  JWT_SECRET: string;
  JWT_ISSUER?: string;
  STUB_LOW_CONF?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_OCR_MODEL?: string;
  // Cloudflare R2 via its S3-compatible API. When any of endpoint / key /
  // secret / bucket is missing, uploadAttachment returns a stub (dev/tests).
  R2_S3_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  R2_ATTACHMENTS_PUBLIC_URL?: string;
  // Comma-separated list of origins allowed to make credentialed CORS
  // requests. Unset = loopback-only (dev); set it in production to the real
  // frontend origin(s).
  CORS_ALLOWED_ORIGINS?: string;
  // Shared secret that the Cloudflare Worker injects (X-Proxy-Secret) on every
  // proxied request. When set, the backend refuses requests that don't carry
  // it — so the public Railway origin can't be hit directly, only via the
  // Worker. Unset disables the gate (Docker stack / local dev). See index.ts.
  PROXY_SECRET?: string;
  // 'production' locks down dev-only conveniences (e.g. the demo-accounts
  // login picker). Sourced from process.env.NODE_ENV.
  NODE_ENV?: string;
  // Explicit opt-in to expose /api/auth/demo-accounts even in production.
  ENABLE_DEMO_ACCOUNTS?: string;
  // OAuth 2.1 AS for the market-value MCP read + scraper write surfaces.
  OAUTH_ISSUER_URL?: string;
  OAUTH_SIGNING_KEY_CURRENT?: string;
  OAUTH_SIGNING_KEY_PREVIOUS?: string;
  OAUTH_ACCESS_TOKEN_TTL_SEC?: string;
  OAUTH_REFRESH_TOKEN_TTL_SEC?: string;
  OAUTH_DCR_OPEN?: string;
};

export type Role = 'manager' | 'purchaser';

export type User = {
  id: string;
  email: string;
  name: string;
  initials: string;
  role: Role;
  team: string | null;
  language: 'en' | 'zh';
  preferences: Record<string, unknown>;
};

export type LineCategory = 'RAM' | 'SSD' | 'HDD' | 'Other';

export type OAuthScope =
  | 'market:read'
  | 'market:write'
  | 'sellorder:read'
  | 'sellorder:write';

export type OAuthCtx = {
  clientId: string;
  userId: string | null;   // null for client_credentials grant
  scopes: OAuthScope[];
  jti: string;
};
