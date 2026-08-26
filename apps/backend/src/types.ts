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
  // Reddit tracker admin proxy (/api/tracker/*). Both unset → proxy answers
  // 501 so the UI can show a "not configured" state instead of erroring.
  TRACKER_API_URL?: string;
  TRACKER_API_TOKEN?: string;
  // Facebook fleet console facade (/api/coordinator/*). Both unset → proxy
  // answers 501, same "not configured" contract as the tracker proxy.
  COORDINATOR_API_URL?: string;
  COORDINATOR_API_TOKEN?: string;
  // Cloudflare Access service token guarding the facade's tunnel hostname.
  // Optional: without them the proxy still works against an unguarded URL.
  COORDINATOR_ACCESS_CLIENT_ID?: string;
  COORDINATOR_ACCESS_CLIENT_SECRET?: string;
  // ShipSaving prepaid-label API. Either unset → deterministic stub provider
  // (demo rates/labels, no real purchases) and the tracking poll stays off.
  // ShipSaving v2 (docs.shipsaving.com/v2): OAuth client credentials.
  // API_URL overrides the default https://x-api.shipsaving.com.
  SHIPSAVING_API_URL?: string;
  SHIPSAVING_APP_KEY?: string;
  SHIPSAVING_APP_SECRET?: string;
  // Bank-transaction sync (manager Payments page). A source with no keys is
  // reported as "not configured" — there is NO silent stub fallback here.
  // BANKTX_STUB=1 explicitly opts into deterministic canned data for dev.
  // API_URL overrides exist for tests; defaults are the live endpoints.
  MERCURY_API_URL?: string;
  MERCURY_API_TOKEN?: string;
  PAYPAL_API_URL?: string;
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  BANKTX_STUB?: string;
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
  defaultWarehouseId: string | null;
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
