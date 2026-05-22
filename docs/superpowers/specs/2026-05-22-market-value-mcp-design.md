# Market-Value MCP + Write Endpoint — Design

**Date:** 2026-05-22
**Status:** Approved, ready for implementation plan.

## Summary

Expose Recycle ERP's market-value data (`ref_prices` table) over the
Model Context Protocol so external LLM agents (Claude Code, Claude.ai
connectors, etc.) can read current pricing; and accept pushes from an
external scraper service via a dedicated REST endpoint so those values
stay current. The ERP itself does no scraping; it is the system of
record + the API surface.

Authentication for both surfaces uses a minimal OAuth 2.1 Authorization
Server implemented inside the existing Hono backend, per the MCP spec's
recommended flow.

Browser cookie auth is unchanged. The OAuth surface coexists at a
separate URL prefix and shares the `users` table.

## Non-goals

- No scraping or LLM-driven research inside the ERP. The scraper is
  someone else's process.
- No scheduled refresh job. The ERP reflects whatever the scraper has
  pushed.
- No OpenID Connect (no ID tokens). Pure OAuth 2.1.
- No external IdP (Auth0/Clerk). Self-hosted AS only.
- No `ref_prices` upsert via the write endpoint — only updates of
  existing rows. Creating a new `ref_prices` row stays in the Market UI.

## Architecture

Three new module groups, all under `apps/backend/src/`:

```
apps/backend/src/
├── oauth/
│   ├── server.ts        Authorization Server: routes, metadata, DCR
│   ├── pkce.ts          S256 verifier/challenge helpers
│   ├── tokens.ts        Mint/verify access (JWS) + refresh (opaque, rotating)
│   ├── clients.ts       CRUD on oauth_clients (with redirect-URI allowlist)
│   └── guard.ts         bearerGuard({ scopes: [...] }) middleware
├── mcp/
│   ├── server.ts        MCP server factory; mounts at /api/mcp (Streamable HTTP)
│   └── tools/market.ts  list_market_values, get_market_value
└── routes/
    ├── market.ts        Existing GET / + new POST /values write endpoint
    └── oauth.ts         Mounts oauth/server.ts under /oauth/* + /.well-known/*
```

Existing files touched:

- `apps/backend/src/index.ts` — register the new `oauth`, `mcp`, and
  market write routes.
- `apps/backend/src/routes/market.ts` — extract the row-to-DTO
  formatter into `lib/market.ts` so the REST `GET /api/market` and the
  MCP tools return byte-identical shapes.
- `apps/frontend/src/pages/desktop/DesktopSettings.tsx` — add a
  "Connectors" tab listing OAuth clients with Add / Revoke actions.

## Auth surface (OAuth 2.1, minimal MCP profile)

### Tables (migration `0046_oauth.sql`)

```sql
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,            -- client_id (random, public)
  secret_hash TEXT,               -- bcrypt of client_secret; NULL for public clients
  name TEXT NOT NULL,             -- shown on consent screen
  redirect_uris TEXT[] NOT NULL,  -- exact-match allowlist
  grant_types TEXT[] NOT NULL,    -- subset of {authorization_code, refresh_token, client_credentials}
  scopes TEXT[] NOT NULL,         -- subset of {market:read, market:write}
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,     -- SHA-256 of opaque code
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  code_challenge TEXT NOT NULL,   -- PKCE; S256 only (no `plain`)
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX ON oauth_authorization_codes (expires_at);

CREATE TABLE oauth_refresh_tokens (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id INT REFERENCES users(id) ON DELETE CASCADE,  -- NULL for client_credentials
  scopes TEXT[] NOT NULL,
  family_id UUID NOT NULL,
  parent_id BIGINT REFERENCES oauth_refresh_tokens(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX ON oauth_refresh_tokens (family_id);
CREATE INDEX ON oauth_refresh_tokens (user_id);
CREATE INDEX ON oauth_refresh_tokens (client_id);
```

### Tokens

- **Access tokens** are JWS-signed compact tokens, *not stored in DB*.
  Payload: `{iss, sub: user_id_or_null, cid: client_id, scopes,
  exp, jti, aud: "recycle-erp-api"}`. TTL 15 minutes (configurable).
  Verification is signature + expiry only — no DB round-trip per
  request. Revocation strategy: short TTL; explicit revocation lives at
  the refresh layer.
- **Refresh tokens** are opaque 32-byte CSPRNG values, stored hashed
  (`SHA-256`). Rotating family — using an already-rotated token revokes
  the entire `family_id`, matching the existing `rt` cookie pattern.
  TTL 30 days (configurable).
- **JWS signing** uses Ed25519. The header carries `kid` so the
  validator can pick the right key from a two-key ring
  (`OAUTH_SIGNING_KEY_CURRENT`, `OAUTH_SIGNING_KEY_PREVIOUS`) for
  zero-downtime rotation. Library: `@panva/jose`.

### Scopes (closed set)

- `market:read` — granted via `authorization_code+PKCE` to interactive
  agents. Required to call `list_market_values` and `get_market_value`.
- `market:write` — granted via `client_credentials` to the scraper.
  Required to call `POST /api/market/values`.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/.well-known/oauth-authorization-server` | RFC 8414 AS metadata. |
| GET    | `/.well-known/oauth-protected-resource`   | RFC 9728 resource metadata, advertised on `WWW-Authenticate` for 401s. |
| POST   | `/oauth/register`                          | RFC 7591 Dynamic Client Registration. Gated by `OAUTH_DCR_OPEN` env (default `false` in prod). |
| GET    | `/oauth/authorize`                         | Renders consent page if user is logged in; redirects to ERP login otherwise. PKCE `S256` only. |
| POST   | `/oauth/authorize/consent`                 | Records consent, mints + returns the code via 302 to `redirect_uri`. |
| POST   | `/oauth/token`                             | Grants: `authorization_code`, `refresh_token`, `client_credentials`. |
| POST   | `/oauth/revoke`                            | RFC 7009 revocation (refresh tokens; access tokens age out). |

The consent screen lives in the existing frontend bundle (a new route
in `DesktopApp.tsx` only — vendor portal and mobile shell don't need
it). It uses the same cookie-auth session as the rest of the app.

### Flows

**Interactive agent (Claude.ai connector, Claude Code MCP config, …):**

1. Agent kicks off authorization_code flow → `/oauth/authorize`.
2. User must be logged into ERP. If not, 302 to ERP login → back to
   `/oauth/authorize` after login.
3. Consent screen shows client name + requested scopes.
4. On approve → `POST /oauth/authorize/consent` → 302 to `redirect_uri`
   with `code` + `state`.
5. Agent calls `POST /oauth/token` with
   `grant_type=authorization_code`, `code`, `code_verifier`,
   `client_id` (+ `client_secret` if confidential).
6. AS verifies PKCE, consumes the code, mints access + refresh tokens
   with `user_id` set.

**Scraper service (machine-to-machine):**

1. A manager opens **Settings > Connectors**, "Add service client".
   Form: name, scopes (`market:write`). Backend creates
   `oauth_clients` row with `grant_types=['client_credentials']`,
   returns `client_id` + a single one-time view of `client_secret`.
2. Scraper stores both in its own `.env`.
3. Scraper `POST /oauth/token` with `grant_type=client_credentials`,
   `client_id`, `client_secret`, `scope=market:write`. Gets an access
   token (`user_id=NULL` in the JWS payload, `cid` set).
4. Scraper calls `POST /api/market/values` with `Authorization: Bearer
   <access_token>`.

### `bearerGuard`

A small middleware mirroring the existing `authGuard`/`csrfGuard`
shape:

```ts
bearerGuard({ scopes: ['market:read'] })
```

Behavior:

1. Reads `Authorization: Bearer <jwt>`.
2. Verifies signature against the active key ring and `exp`/`iss`/`aud`.
3. Checks the JWT's `scopes` superset-includes the required scopes.
4. On failure returns 401 with
   `WWW-Authenticate: Bearer realm="recycle-erp", resource_metadata="<issuer>/.well-known/oauth-protected-resource"`.
5. On success sets `c.set('oauthCtx', {clientId, userId, scopes, jti})`
   for handlers.

CSRF middleware is NOT applied on Bearer-authed routes — Bearer auth
removes the cross-site cookie problem CSRF addresses.

### Settings UI

New **Connectors** tab inside the existing Settings page (desktop
only). Lists each `oauth_clients` row with: name, scopes, grant_types,
created_by (user name), created_at, last_used_at (derived from
`oauth_refresh_tokens.created_at` MAX where revoked_at IS NULL).
Buttons: "Add client" (modal), "Revoke" (sets `revoked_at`, cascades
to refresh tokens). Only managers (existing role) can see this tab.

## MCP server

### Transport

Streamable HTTP (current MCP spec transport), mounted at:

```
POST /api/mcp
GET  /api/mcp        (SSE upgrade for server-initiated messages)
```

Wrapped in `bearerGuard({ scopes: ['market:read'] })`. No CSRF
middleware. SDK: `@modelcontextprotocol/sdk` (official TypeScript SDK);
the adapter to Hono is small (`mcp/server.ts`).

### Capabilities (advertised on `initialize`)

```json
{
  "protocolVersion": "<sdk default>",
  "capabilities": { "tools": { "listChanged": false } },
  "serverInfo": { "name": "recycle-erp-market", "version": "<from package.json>" }
}
```

### Tools

```ts
list_market_values({
  category?: string,            // exact: "RAM" | "SSD" | "HDD" | "CPU" | ...
  q?: string,                   // substring match on label + part_number
  limit?: number,               // default 50, max 200
}) => MarketValue[]

get_market_value({
  id?: string,                  // exact UUID
  partNumber?: string,          // exact, case-insensitive
}) => MarketValue | null        // exactly one of {id, partNumber} required
```

Both delegate to `lib/market.ts` formatter shared with `GET /api/market`.

`MarketValue` shape:

```ts
{
  id, category, brand, capacity, type, classification, rank, speed,
  interface, formFactor, partNumber, label, sub,
  low, high, avgSell, maxBuy, target,        // numeric strings
  trend, samples, source, stock, demand,     // metadata
  history,                                   // JSONB: { ts, avg }[]
  updatedAt                                  // ISO 8601
}
```

### Errors

- Invalid input → JSON-RPC `-32602 Invalid params` with `data: { field, reason }`.
- Auth missing/invalid → HTTP 401, body empty, headers carry
  `WWW-Authenticate: Bearer …`.
- Scope insufficient → HTTP 403, body `{ error: "insufficient_scope" }`.

## Write endpoint

```
POST /api/market/values
Authorization: Bearer <token with scope=market:write>
Content-Type:  application/json
```

Body:

```json
{
  "values": [
    {
      "selector":  { "id": "<uuid>" },
      "low":       "120.00",
      "high":      "180.00",
      "avgSell":   "145.00",
      "samples":   12,
      "source":    "ebay-sold-30d"
    }
  ]
}
```

`selector` is `{ id }` OR `{ partNumber }`. Numerics are JSON strings to
preserve `NUMERIC` precision through `postgres.js`.

Response (always 200 on a well-formed request, even with partial failures):

```json
{
  "updated":  3,
  "notFound": 1,
  "errors":   [ { "selector": {"partNumber": "X"}, "error": "low > avgSell" } ]
}
```

### Per-row behavior, inside a single `sql.begin` per request

1. Resolve `selector` to a `ref_prices.id`. Miss → push to `notFound`,
   skip. v1 does not upsert.
2. Validate `low ≤ avgSell ≤ high`, all numerics ≥ 0, `samples` is a
   non-negative integer. Failure → push to `errors`, skip.
3. Update `low_price`, `high_price`, `avg_sell`. Replace `samples`
   (don't increment — the scraper's number reflects its window).
   Replace `source`. Append `{ ts: now(), avg }` to `history` (JSONB).
   Recompute `trend = latest.avg − previous.avg` or NULL if no previous.
   `updated_at = now()`.

### Limits and idempotency

- Hard cap: `values.length ≤ 500` per request. Above → HTTP 413
  with `{ error: "payload_too_large", hint: "paginate to ≤500 rows" }`.
- No `Idempotency-Key` support in v1. The scraper owns retry safety.
  History duplication is acceptable.

### Audit

No dedicated `ref_price_events` table in v1. The `source` column
captures the scraper's data-source label; the OAuth access token's
`cid` identifies the writing service, logged at the access-log layer.
Per-write attribution at finer granularity can be added later via an
additive migration.

## Observability

`prom-client` counters (the sidecar from migration `0042_metrics_role`
is already wired up):

- `oauth_grants_total{grant_type, status}` — increment per token mint.
- `oauth_refresh_revocations_total{reason}` — `reason="reuse"` also
  logs at WARN.
- `mcp_tool_calls_total{tool, status}`.
- `market_writes_total{outcome="updated|notfound|error"}`.

Structured logs:

- Token mint: `{grant_type, client_id, user_id?, scopes, jti, ip}` at INFO.
- Refresh-family revocation: `{family_id, reason, ip}` at WARN.
- Invalid bearer attempts: `{reason, ip}` at INFO (rate-limited).

No PII inside JWS payloads themselves (no email, no name).

## Env additions

Added to `.env.example` and the backend service in `docker-compose.yml`:

| Variable | Purpose | Default |
|----------|---------|---------|
| `OAUTH_ISSUER_URL` | Used as `iss` claim + in discovery docs. | — (required in prod) |
| `OAUTH_SIGNING_KEY_CURRENT` | Ed25519 PEM (base64 to survive `.env`). | — (required) |
| `OAUTH_SIGNING_KEY_PREVIOUS` | Previous Ed25519 key (rotation grace). | empty |
| `OAUTH_ACCESS_TOKEN_TTL_SEC` | Access token TTL. | 900 |
| `OAUTH_REFRESH_TOKEN_TTL_SEC` | Refresh token TTL. | 2592000 |
| `OAUTH_DCR_OPEN` | If `true`, `/oauth/register` is unauthenticated. | `false` |

CORS: the existing `CORS_ALLOWED_ORIGINS` env governs browser-side
OAuth flows. The MCP and write endpoints are Bearer-only and don't
need browser CORS.

## Tests (vitest, integration, against real Postgres)

### OAuth

- DCR happy path. Rejects redirect URIs that aren't `https://` (or
  `http://localhost*`).
- `authorization_code` grant: missing/invalid `code_verifier` → 400;
  consuming a code twice → 400.
- `refresh_token` rotation: presenting an already-rotated token revokes
  the whole `family_id`.
- `client_credentials` grant: rejects clients without that grant in
  `grant_types`; rejects requests for scopes the client doesn't have.
- Bearer validation: expired → 401; tampered signature → 401; wrong
  scope → 403.
- `revoke` only revokes the caller's own family.

### MCP

- `initialize` returns expected capabilities.
- `tools/list` returns the two tools.
- `tools/call` happy path for each.
- Invalid input → JSON-RPC `-32602`.
- 401 includes `WWW-Authenticate: Bearer resource_metadata=…`.

### Write endpoint

- 401 without bearer, 403 with `market:read`-only token.
- 200 with mixed updated / notFound / errors.
- 400 on `low > avgSell`.
- 413 on >500 rows.
- Atomic — failures in one row don't poison the others (single
  `sql.begin`).

## Rollout

Six commits to `main`, each independently mergeable because earlier
steps don't expose anything new until step 4:

1. Migration `0046_oauth.sql` + storage-layer helpers + tests.
2. OAuth endpoints (`/oauth/*`, `/.well-known/*`) + tests +
   `DesktopSettings > Connectors` tab.
3. `bearerGuard` middleware + tests.
4. MCP server + `list_market_values` + `get_market_value` + tests.
5. `POST /api/market/values` + tests.
6. README section: how to register a client and use the MCP from
   Claude Code's MCP config.

## Pointers

- Existing market screen: `apps/frontend/src/pages/desktop/DesktopMarket.tsx`.
- Existing read API: `apps/backend/src/routes/market.ts`.
- Existing auth model: `apps/backend/src/routes/auth.ts` + cookie
  middleware (separate from this OAuth surface).
- Metrics sidecar: design at
  `docs/superpowers/specs/2026-05-21-system-metrics-sidecar-design.md`.
