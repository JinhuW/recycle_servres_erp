# Market-value MCP setup

This document walks operators and integrators through deploying,
configuring, and using the market-value Model Context Protocol (MCP)
server that ships with this ERP.

The reference deployment is `https://inventory.recycleservers.com`;
substitute your own host throughout.

## What is the MCP server

The ERP exposes its `ref_prices` table to external LLM agents over the
[Model Context Protocol](https://modelcontextprotocol.io). Two tools
are advertised:

| Tool | Args | Returns |
|---|---|---|
| `list_market_values` | `{ category?, q?, limit? }` | `MarketValue[]` |
| `get_market_value` | `{ id?, partNumber? }` (exactly one) | `MarketValue \| null` |

The MCP server is mounted at `/api/mcp` and protected by OAuth 2.1
Bearer tokens with scope `market:read`.

A second surface, `POST /api/market/values`, accepts pushes from an
external scraper service. It uses scope `market:write` and is the only
way to refresh market values — the ERP itself does no scraping.

## Architecture in one diagram

```
┌─────────────────────────┐
│  Claude Code / Claude.ai│  (interactive agents, market:read)
└──────────┬──────────────┘
           │ OAuth 2.1
           │ authorization_code + PKCE
           ▼
┌─────────────────────────┐    ┌──────────────────────────────┐
│  /oauth/authorize       │◄──►│  Settings → Connectors UI    │
│  /oauth/token           │    │  (manager-only client mgmt)  │
│  /oauth/revoke          │    └──────────────────────────────┘
│  /oauth/register (DCR)  │
│  /.well-known/*         │
└──────────┬──────────────┘
           │ access token (JWS Ed25519, 15-min TTL)
           ▼
┌─────────────────────────┐                   ┌──────────────┐
│ /api/mcp  (market:read) │◄──── ref_prices ─►│ scraper      │
│ /api/market/values      │      table        │ (market:write,│
│           (market:write)│                   │  client_creds)│
└─────────────────────────┘                   └──────────────┘
```

All OAuth state lives in three tables: `oauth_clients`,
`oauth_authorization_codes`, `oauth_pending_consent`,
`oauth_refresh_tokens` (added in migrations 0046–0048).

## Server setup

### 1. Generate the OAuth signing key

The AS signs access tokens with Ed25519 JWS. Generate the key once,
store as base64-encoded PKCS#8 PEM:

```sh
node -e "import('jose').then(async j => {
  const {privateKey} = await j.generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const pem = await j.exportPKCS8(privateKey);
  process.stdout.write(Buffer.from(pem).toString('base64'));
})"
```

Treat the output as a secret — anyone with this key can mint valid
access tokens.

### 2. Set env vars in production `.env`

```dotenv
OAUTH_ISSUER_URL=https://inventory.recycleservers.com
OAUTH_SIGNING_KEY_CURRENT=<base64 PKCS#8 PEM from above, single line>
OAUTH_SIGNING_KEY_PREVIOUS=                              # optional; see Rotation below
OAUTH_ACCESS_TOKEN_TTL_SEC=900                           # 15 min
OAUTH_REFRESH_TOKEN_TTL_SEC=2592000                      # 30 days
OAUTH_DCR_OPEN=false                                     # see DCR section below
```

The backend refuses to boot in production without
`OAUTH_SIGNING_KEY_CURRENT`. Missing or empty value → startup error.

### 3. Verify Caddy proxies the OAuth surface

`apps/frontend/Caddyfile` must include these blocks (already in repo
since commit `2fb8844`):

```caddyfile
handle /oauth/* {
  reverse_proxy backend:8787
}
handle /.well-known/* {
  reverse_proxy backend:8787
}
```

Without these, requests to `/.well-known/oauth-authorization-server`
fall through to the SPA's HTML, and OAuth clients can't discover the
AS.

### 4. Rebuild + redeploy

Migrations 0046–0048 apply automatically on backend startup. On a host
running the standard docker-compose stack:

```sh
git pull
docker compose build backend frontend
docker compose up -d
docker compose logs backend | grep migrate  # confirm 0046–0048 applied
```

### 5. Smoke test

```sh
ISSUER=https://inventory.recycleservers.com

# AS metadata
curl -s "$ISSUER/.well-known/oauth-authorization-server" | jq .

# Expect: issuer == $ISSUER, endpoints under /oauth/*, scopes_supported
# includes market:read + market:write, code_challenge_methods_supported == [S256]

# MCP 401 with discovery hint
curl -i -X POST "$ISSUER/api/mcp" -H 'Content-Type: application/json' -d '{}'

# Expect: HTTP/2 401
#         WWW-Authenticate: Bearer realm="recycle-erp", error="invalid_token",
#                           resource_metadata="$ISSUER/.well-known/oauth-protected-resource"
```

If either fails, the deployment hasn't picked up the new code/Caddy
config — recheck step 4.

## Registering a connector

### Option A: through the Settings UI (recommended for first setup)

1. Sign in to the ERP as a **manager** in your browser.
2. Open **Settings → Connectors**.
3. Click **"Add a service client"**, enter a descriptive name
   (e.g. `claude-code-jinhu` or `ebay-scraper-prod`), submit.
4. Copy the `clientSecret` from the one-time dialog (Copy button is
   provided). The secret is shown exactly once and stored only as a
   bcrypt hash server-side.

The Settings UI is sufficient for both interactive Claude clients
(`grant_types = [authorization_code, refresh_token]`, default in the
UI uses `client_credentials` because the dialog is shaped for scrapers
— for an interactive client, register via DCR below or extend the UI).

### Option B: Dynamic Client Registration (RFC 7591)

Turn on DCR by setting `OAUTH_DCR_OPEN=true` in `.env` and restarting
the backend. Then any client can self-register:

```sh
curl -X POST https://inventory.recycleservers.com/oauth/register \
  -H 'Content-Type: application/json' \
  -d '{
    "client_name": "claude-ai-connector",
    "redirect_uris": ["https://claude.ai/oauth/callback"],
    "grant_types": ["authorization_code","refresh_token"],
    "scope": "market:read"
  }'
```

DCR is gated by `OAUTH_DCR_OPEN` because anyone can register otherwise.
For a managed deployment, keep it `false` and use the Settings UI.

### Allowed values

| Field | Allowed values |
|---|---|
| `scopes` | `market:read`, `market:write` |
| `grant_types` | `authorization_code`, `refresh_token`, `client_credentials` |
| `redirect_uris` | `https://…` or `http://localhost…` (DCR rejects other schemes) |

A client can hold multiple scopes; the admin POST and DCR both
validate against the closed set above.

## Using it from Claude Code

After registering a client with `grant_types = [authorization_code, refresh_token]`
and `scope = market:read`:

```sh
claude mcp add --transport http recycle-erp-market \
  https://inventory.recycleservers.com/api/mcp
```

What Claude Code does behind the scenes:

1. Hits `POST /api/mcp` → receives `401` with the `WWW-Authenticate` header.
2. Follows the `resource_metadata` URL → `oauth-protected-resource` doc.
3. Fetches the AS metadata at `/.well-known/oauth-authorization-server`.
4. Starts an authorization_code+PKCE flow, opens your browser at
   `https://inventory.recycleservers.com/oauth/authorize?…`.
5. You log into the ERP, see the consent screen ("Allow `recycle-erp-market`
   to access your account?"), click Approve (or Deny).
6. Browser redirects back to Claude Code with `?code=…`; Claude exchanges
   it for `{access_token, refresh_token}`.
7. Subsequent MCP requests carry `Authorization: Bearer <access_token>`.
   When the 15-min access token expires, Claude Code silently rotates
   via the refresh token.

After connection, in any Claude Code session:

```
/mcp
```

…lists `recycle-erp-market` as connected. Example prompts:

> What's the current market value of a 32 GB DDR4 RDIMM?

> List the top 5 most recently updated RAM SKUs by avgSell.

> Get the market value for part number M393A4K40DB2-CWE.

## Using it from Claude.ai (web)

Claude.ai supports custom MCP connectors. Settings → Connectors → Add
custom connector. The URL is the same:
`https://inventory.recycleservers.com/api/mcp`. The OAuth flow is
identical; on approve, you're returned to Claude.ai with the connector
authorized.

## Scraper integration

The scraper service is a separate process — not part of the ERP. It
pushes prices via the write endpoint using a `client_credentials` token.

### One-time setup

1. In Settings → Connectors, create a service client with
   `grant_types=[client_credentials]` and `scopes=[market:write]`.
2. Copy the `clientId` and `clientSecret` into the scraper's `.env` (or
   secrets manager).

### Per-batch flow

```sh
ID=…       # client_id from Settings
SECRET=…   # client_secret from Settings

TOKEN=$(curl -sX POST https://inventory.recycleservers.com/oauth/token \
  -d 'grant_type=client_credentials' \
  -d "client_id=$ID" -d "client_secret=$SECRET" \
  -d 'scope=market:write' | jq -r '.access_token')

curl -X POST https://inventory.recycleservers.com/api/market/values \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "values": [
      {
        "selector": { "partNumber": "M393A4K40DB2-CWE" },
        "low":     "120.00",
        "high":    "180.00",
        "avgSell": "145.00",
        "samples": 12,
        "source":  "ebay-sold-30d"
      }
    ]
  }'
```

Response:

```json
{ "updated": 1, "notFound": 0, "errors": [] }
```

Behavior notes:

- Batch up to **500 rows per request**. 501+ → `HTTP 413`.
- Selector is `{id}` OR `{partNumber}`. No upsert — unknown SKUs land
  in `notFound` and are skipped. Create the `ref_prices` row through
  the UI first.
- Per-row validation: numerics ≥ 0, `low ≤ avgSell ≤ high`, `samples`
  non-negative integer. Failures land in `errors` and don't roll back
  the other rows.
- Each successful write replaces `low/high/avg_sell/samples/source`,
  appends `{ts, avg}` to `history` (JSONB), recomputes `trend`, sets
  `updated_at = NOW()`.
- The access token has a 15-min TTL. The scraper can re-fetch a new
  token per batch; `client_credentials` doesn't issue a refresh token.

## Token rotation (signing key)

Access tokens are stateless JWS. To rotate the signing key without
breaking outstanding tokens:

1. Move the current key to `OAUTH_SIGNING_KEY_PREVIOUS`.
2. Set `OAUTH_SIGNING_KEY_CURRENT` to a new key (use the same node
   one-liner from §1).
3. Restart the backend.
4. After all access tokens issued with the old key have expired (15
   min by default), clear `OAUTH_SIGNING_KEY_PREVIOUS` on the next
   restart.

The JWS header carries a deterministic `kid`, so verifiers always pick
the right key from the ring.

## Revoking access

Three ways to revoke:

- **Per-token**: a client `POST`s to `/oauth/revoke` with its own
  refresh token. The whole refresh-token family (initial + all
  rotations) is invalidated.
- **Whole client**: Settings → Connectors → Revoke. The client's row
  is marked revoked, and all live refresh tokens for it are killed.
- **Token-theft signal**: reusing an already-rotated refresh token
  automatically revokes the whole family (anti-replay).

Access tokens always expire on their own within 15 minutes —
revocation just blocks future refreshes.

## Reference

### Endpoints

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/.well-known/oauth-authorization-server` | GET | public | RFC 8414 AS metadata |
| `/.well-known/oauth-protected-resource` | GET | public | RFC 9728 resource metadata |
| `/oauth/register` | POST | none (gated by `OAUTH_DCR_OPEN`) | RFC 7591 DCR |
| `/oauth/authorize` | GET | cookie | Start auth-code flow |
| `/oauth/authorize/consent` | POST | cookie | User clicks Approve |
| `/oauth/authorize/deny` | POST | cookie | User clicks Deny |
| `/oauth/authorize/pending/:req` | GET | cookie | SPA fetches parked request data |
| `/oauth/token` | POST | client creds | Mint tokens (3 grants) |
| `/oauth/revoke` | POST | client creds | RFC 7009 revoke a refresh token |
| `/api/oauth/clients` | GET/POST/DELETE | cookie + manager role | Admin client mgmt |
| `/api/mcp` | POST | Bearer `market:read` | MCP JSON-RPC tools |
| `/api/market/values` | POST | Bearer `market:write` | Scraper push |

### Scopes

| Scope | Grants |
|---|---|
| `market:read` | Call `list_market_values`, `get_market_value` over MCP |
| `market:write` | Push to `/api/market/values` |

### OAuth error codes returned

Standard RFC 6749 §5.2 codes: `invalid_request`, `invalid_client`,
`invalid_grant`, `unauthorized_client`, `unsupported_grant_type`,
`invalid_scope`, `access_denied`. RFC 6750 `invalid_token` and
`insufficient_scope` on the Bearer path.

### JSON-RPC error codes (MCP)

| Code | Meaning |
|---|---|
| -32700 | Parse error |
| -32601 | Method or tool not found |
| -32602 | Invalid params |

### Metrics

The Prometheus sidecar at `/metrics` exposes:

| Counter | Labels |
|---|---|
| `oauth_grants_total` | `grant_type`, `status` |
| `oauth_refresh_revocations_total` | `reason` ∈ {reuse, manual, client_revoked} |
| `mcp_tool_calls_total` | `tool`, `status` |
| `market_writes_total` | `outcome` ∈ {updated, notfound, error} |

## Troubleshooting

**`/.well-known/oauth-authorization-server` returns HTML**
Caddy isn't proxying the path. Confirm the two `handle` blocks in
`apps/frontend/Caddyfile`, then rebuild the frontend image.

**`/api/mcp` returns 403, not 401**
The CSRF middleware ran before the bearer guard and the path isn't on
the exempt list. Confirm `apps/backend/src/csrf.ts` exempts `/api/mcp`
and rebuild the backend image. (As of commit `ea2f0c3` it does.)

**Backend won't start in production**
Check that `OAUTH_SIGNING_KEY_CURRENT` is set in `.env`. The startup
guard (commit `f5586d4`) refuses to boot without it.

**Consent screen shows "expired_or_unknown"**
The `oauth_pending_consent` row's 10-minute TTL elapsed before the
user approved. The Claude client will retry the authorize step.

**Claude Code says the bearer token is invalid right after connect**
The signing key in the running container doesn't match what's in
`.env`. Inspect with `docker compose exec backend env | grep OAUTH_`.

**Scraper gets 403 with `insufficient_scope`**
The client's scopes don't include `market:write`. Check Settings →
Connectors → the client's scope list. If wrong, revoke and re-create.

**`/oauth/authorize` redirects to `/login?next=…` even after login**
The browser doesn't have the ERP's `at` cookie. Cross-origin or
incognito sessions need to log into the ERP in the same browser
context first.

## Security model

- **Access tokens** are signed JWS (EdDSA / Ed25519); 15-min TTL by
  default. Not stored server-side; revocation is via short TTL +
  refresh-token revocation.
- **Refresh tokens** are 32-byte opaque random, stored hashed (SHA-256
  of the raw token, never the raw token itself). Rotated on every use.
  Token theft is detected by the anti-replay check: reuse of a
  rotated token revokes the entire family.
- **PKCE S256 mandatory** on every authorization_code flow. The `plain`
  challenge method is not accepted.
- **Redirect URIs** must be an exact match against the registered
  allowlist. `http://localhost*` is allowed for native-app clients;
  otherwise `https://` only.
- **Client secrets** are bcrypt-hashed at rest, shown only once at
  creation time.
- **Cross-client revoke** is rejected silently (RFC 7009 §2.2): a
  client can only revoke its own tokens.
- **CSRF protection** still applies to all cookie-authed routes,
  including `/oauth/authorize/consent`. The `/oauth/*` paths that use
  client credentials or are unauthenticated are exempt; `/api/mcp` and
  `/api/market/values` are Bearer-only, so cookies and CSRF don't
  apply.
- **DCR is gated** by `OAUTH_DCR_OPEN` — keep this `false` unless you
  want anyone on the internet to register clients.

## Related docs

- Design spec: `docs/superpowers/specs/2026-05-22-market-value-mcp-design.md`
- Implementation plan: `docs/superpowers/plans/2026-05-22-market-value-mcp.md`
- Project conventions: `CLAUDE.md` (sections on Auth & CSRF, Database
  & migrations, Storage & OCR).
