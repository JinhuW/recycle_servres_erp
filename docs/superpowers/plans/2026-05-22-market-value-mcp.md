# Market-Value MCP + Write Endpoint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-22-market-value-mcp-design.md`

**Goal:** Expose `ref_prices` to external LLM agents over MCP (read) and accept scraper pushes via REST (write), authenticated by a minimal OAuth 2.1 AS inside the existing Hono backend.

**Architecture:** Three new module groups under `apps/backend/src/`: `oauth/` (AS routes, tokens, PKCE, bearerGuard), `mcp/` (server adapter + tools), and `lib/market.ts` (shared row→DTO formatter consumed by REST + MCP). A new migration `0046_oauth.sql` adds three OAuth tables. The frontend adds a consent screen and a `Settings > Connectors` tab. Browser cookie auth is untouched.

**Tech Stack:** Hono on Node 22, postgres.js, `@modelcontextprotocol/sdk` for MCP (Streamable HTTP transport), `jose` (panva) for Ed25519 JWS signing with a two-key ring, `bcryptjs` (already a dep) for client-secret hashing. Tests: vitest integration against a real Postgres at `127.0.0.1:5432`.

---

## File map (locked in before tasks)

**New backend files (each one file, one responsibility):**
- `apps/backend/migrations/0046_oauth.sql` — the three OAuth tables + indexes + FKs.
- `apps/backend/src/oauth/clients.ts` — CRUD on `oauth_clients`, secret hashing, redirect-URI validation.
- `apps/backend/src/oauth/pkce.ts` — S256 verifier/challenge helpers (pure functions, no DB).
- `apps/backend/src/oauth/tokens.ts` — JWS access-token mint/verify with `kid`-based key ring; opaque refresh-token issue/rotate/revoke (mirrors `auth.ts`).
- `apps/backend/src/oauth/metadata.ts` — `/.well-known/*` payload builders (pure functions of env).
- `apps/backend/src/oauth/server.ts` — Hono sub-app exposing all OAuth endpoints (composes the helpers above).
- `apps/backend/src/oauth/guard.ts` — `bearerGuard({ scopes })` middleware.
- `apps/backend/src/mcp/server.ts` — adapter from `@modelcontextprotocol/sdk` Streamable HTTP transport to Hono `c.req`/`c.res`.
- `apps/backend/src/mcp/tools/market.ts` — tool definitions + handlers (`list_market_values`, `get_market_value`).
- `apps/backend/src/lib/market.ts` — `formatRefPrice(row, targetMargin) → MarketValue` shared between REST and MCP.
- `apps/backend/src/lib/marketWrite.ts` — `applyMarketWrites(sql, values) → {updated, notFound, errors}`.

**New frontend files:**
- `apps/frontend/src/pages/Authorize.tsx` — consent screen rendered in the desktop shell at route `/authorize`.
- `apps/frontend/src/pages/desktop/DesktopSettingsConnectors.tsx` — sub-component used by the Connectors tab.

**Modified files (and where):**
- `apps/backend/package.json` — add `jose`, `@modelcontextprotocol/sdk` deps.
- `apps/backend/src/types.ts` — extend `Env` with `OAUTH_*` vars; add `OAuthCtx` type.
- `apps/backend/src/index.ts` — register `oauthRoutes`, `mcpHandler`, `POST /api/market/values`; mount the well-known routes on the unauthenticated public surface.
- `apps/backend/src/routes/market.ts` — call `formatRefPrice` instead of the inline map; add `POST /values`.
- `apps/backend/src/auth.ts` — no changes (referenced for read; OAuth lives in `oauth/`).
- `apps/backend/scripts/migrate.mjs` — no changes (the runner picks up new SQL files automatically).
- `apps/frontend/src/DesktopApp.tsx` — add `/authorize` route, add Connectors tab inside Settings.
- `apps/frontend/src/pages/desktop/DesktopSettings.tsx` — render `DesktopSettingsConnectors` when its tab is active.
- `apps/frontend/src/lib/api.ts` — no changes (uses cookie auth; OAuth APIs are Bearer-only and called by external clients).
- `.env.example` — add OAUTH_* vars.
- `docker-compose.yml` — pass OAUTH_* through to `backend`.
- `README.md` — add section on registering a connector and using the MCP from Claude Code.

**New test files** (each colocated with the unit under test in `apps/backend/tests/`):
- `oauth-clients.test.ts`, `oauth-pkce.test.ts`, `oauth-tokens.test.ts`, `oauth-endpoints.test.ts`, `oauth-guard.test.ts`, `mcp-server.test.ts`, `market-write.test.ts`, `market-format.test.ts`.

---

## Task 1: Bootstrap — deps + env + types

**Why:** Adds the two new npm deps and the `OAUTH_*` env surface in one focused change so every later task can import them cleanly. No behavior change yet.

**Files:**
- Modify: `apps/backend/package.json`
- Modify: `apps/backend/src/types.ts`
- Modify: `.env.example`
- Modify: `docker-compose.yml`

- [ ] **Step 1 — Add deps**

```bash
pnpm --filter recycle-erp-backend add jose@^6 @modelcontextprotocol/sdk@^1
```

- [ ] **Step 2 — Extend `Env` and add `OAuthCtx` type**

Edit `apps/backend/src/types.ts`. Add (alphabetically inside `Env`, keep existing keys):

```ts
  // OAuth 2.1 AS used by the MCP server. See spec
  // 2026-05-22-market-value-mcp-design.md.
  OAUTH_ISSUER_URL?: string;
  OAUTH_SIGNING_KEY_CURRENT?: string;
  OAUTH_SIGNING_KEY_PREVIOUS?: string;
  OAUTH_ACCESS_TOKEN_TTL_SEC?: string;
  OAUTH_REFRESH_TOKEN_TTL_SEC?: string;
  OAUTH_DCR_OPEN?: string;
```

At the end of the file add:

```ts
export type OAuthScope = 'market:read' | 'market:write';

export type OAuthCtx = {
  clientId: string;
  userId: string | null;   // null for client_credentials grant
  scopes: OAuthScope[];
  jti: string;
};
```

- [ ] **Step 3 — Add the same vars to `.env.example`**

Append to `.env.example`:

```dotenv
# OAuth 2.1 (powers the MCP read + scraper write surfaces).
# Generate Ed25519 keypair: openssl genpkey -algorithm ed25519 | base64 -w0
OAUTH_ISSUER_URL=http://localhost:8787
OAUTH_SIGNING_KEY_CURRENT=
OAUTH_SIGNING_KEY_PREVIOUS=
OAUTH_ACCESS_TOKEN_TTL_SEC=900
OAUTH_REFRESH_TOKEN_TTL_SEC=2592000
OAUTH_DCR_OPEN=false
```

- [ ] **Step 4 — Pass vars through compose**

In `docker-compose.yml`, find the `backend` service's `environment:` block (it already enumerates JWT_SECRET, R2_*, etc.) and add the six `OAUTH_*` keys following the same `${VAR}` interpolation pattern.

- [ ] **Step 5 — Typecheck**

Run: `pnpm --filter recycle-erp-backend typecheck`
Expected: clean.

- [ ] **Step 6 — Commit**

```bash
git add apps/backend/package.json apps/backend/pnpm-lock.yaml pnpm-lock.yaml apps/backend/src/types.ts .env.example docker-compose.yml
git commit -m "chore(backend): add jose + @modelcontextprotocol/sdk deps and OAUTH env surface"
```

---

## Task 2: Migration 0046_oauth.sql

**Why:** Lays down the three OAuth tables so all subsequent storage helpers compile and tests run. Additive only.

**Files:**
- Create: `apps/backend/migrations/0046_oauth.sql`
- Create: `apps/backend/tests/oauth-schema.test.ts`

- [ ] **Step 1 — Write the failing schema test**

`apps/backend/tests/oauth-schema.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';

describe('0046_oauth migration', () => {
  beforeAll(async () => { await resetDb(); });

  async function tableColumns(table: string): Promise<Set<string>> {
    const db = getTestDb();
    const rows = await db<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = ${table}
    `;
    return new Set(rows.map(r => r.column_name));
  }

  it('creates oauth_clients with expected columns', async () => {
    const cols = await tableColumns('oauth_clients');
    for (const c of ['id','secret_hash','name','redirect_uris','grant_types','scopes','created_by','created_at','revoked_at']) {
      expect(cols.has(c), `oauth_clients missing column ${c}`).toBe(true);
    }
  });

  it('creates oauth_authorization_codes with expected columns', async () => {
    const cols = await tableColumns('oauth_authorization_codes');
    for (const c of ['code_hash','client_id','user_id','redirect_uri','scopes','code_challenge','expires_at','consumed_at']) {
      expect(cols.has(c), `oauth_authorization_codes missing column ${c}`).toBe(true);
    }
  });

  it('creates oauth_refresh_tokens with expected columns + indexes', async () => {
    const cols = await tableColumns('oauth_refresh_tokens');
    for (const c of ['id','token_hash','client_id','user_id','scopes','family_id','parent_id','expires_at','revoked_at']) {
      expect(cols.has(c), `oauth_refresh_tokens missing column ${c}`).toBe(true);
    }
    const db = getTestDb();
    const idx = await db<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='oauth_refresh_tokens'
    `;
    const inames = new Set(idx.map(i => i.indexname));
    expect(inames.has('oauth_refresh_tokens_family_idx')).toBe(true);
    expect(inames.has('oauth_refresh_tokens_user_idx')).toBe(true);
    expect(inames.has('oauth_refresh_tokens_client_idx')).toBe(true);
  });
});
```

- [ ] **Step 2 — Run it; expect failure**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-schema.test.ts 2>&1
```
Expected: all three tests FAIL (tables don't exist yet).

- [ ] **Step 3 — Write the migration**

`apps/backend/migrations/0046_oauth.sql`:

```sql
-- OAuth 2.1 minimal AS for the market-value MCP + scraper write endpoint.
-- See docs/superpowers/specs/2026-05-22-market-value-mcp-design.md.

CREATE TABLE IF NOT EXISTS oauth_clients (
  id            TEXT PRIMARY KEY,
  secret_hash   TEXT,
  name          TEXT NOT NULL,
  redirect_uris TEXT[] NOT NULL,
  grant_types   TEXT[] NOT NULL,
  scopes        TEXT[] NOT NULL,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri    TEXT NOT NULL,
  scopes          TEXT[] NOT NULL,
  code_challenge  TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  consumed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_expires_idx
  ON oauth_authorization_codes (expires_at);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id          BIGSERIAL PRIMARY KEY,
  token_hash  TEXT UNIQUE NOT NULL,
  client_id   TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  scopes      TEXT[] NOT NULL,
  family_id   UUID NOT NULL,
  parent_id   BIGINT REFERENCES oauth_refresh_tokens(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_family_idx
  ON oauth_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_user_idx
  ON oauth_refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_client_idx
  ON oauth_refresh_tokens (client_id);
```

- [ ] **Step 4 — Run tests; expect pass**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-schema.test.ts 2>&1
```
Expected: all three tests PASS.

- [ ] **Step 5 — Commit**

```bash
git add apps/backend/migrations/0046_oauth.sql apps/backend/tests/oauth-schema.test.ts
git commit -m "feat(backend): 0046 oauth schema — clients, codes, refresh tokens"
```

---

## Task 3: oauth/clients.ts — client CRUD + secret verify

**Why:** Manager-facing operations on `oauth_clients`: create (with `client_secret` hashing via bcrypt), lookup-by-id with `secret_hash` compare, list, revoke. Used by both Settings UI later and by `/oauth/register` (DCR).

**Files:**
- Create: `apps/backend/src/oauth/clients.ts`
- Create: `apps/backend/tests/oauth-clients.test.ts`

- [ ] **Step 1 — Write the failing test**

`apps/backend/tests/oauth-clients.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { createOAuthClient, findOAuthClient, verifyClientSecret, listOAuthClients, revokeOAuthClient } from '../src/oauth/clients';

describe('oauth_clients CRUD', () => {
  beforeAll(async () => { await resetDb(); });

  async function aUser(): Promise<string> {
    const db = getTestDb();
    return (await db<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
  }

  it('creates a confidential client and returns secret only once', async () => {
    const db = getTestDb();
    const out = await createOAuthClient(db, {
      name: 'test confidential',
      redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code', 'refresh_token'],
      scopes: ['market:read'],
      createdBy: await aUser(),
      public: false,
    });
    expect(out.clientId).toMatch(/^[a-z0-9]{20,}$/);
    expect(out.clientSecret).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    const row = await findOAuthClient(db, out.clientId);
    expect(row?.name).toBe('test confidential');
    expect(row?.secret_hash).toBeTruthy();
  });

  it('verifyClientSecret compares against stored bcrypt hash', async () => {
    const db = getTestDb();
    const out = await createOAuthClient(db, {
      name: 'verify check',
      redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code'],
      scopes: ['market:read'],
      createdBy: await aUser(),
      public: false,
    });
    const row = await findOAuthClient(db, out.clientId);
    expect(await verifyClientSecret(row!, out.clientSecret)).toBe(true);
    expect(await verifyClientSecret(row!, 'wrong')).toBe(false);
  });

  it('creates a public client with no secret', async () => {
    const db = getTestDb();
    const out = await createOAuthClient(db, {
      name: 'public client',
      redirectUris: ['http://localhost:8080/cb'],
      grantTypes: ['authorization_code'],
      scopes: ['market:read'],
      createdBy: await aUser(),
      public: true,
    });
    expect(out.clientSecret).toBeNull();
    const row = await findOAuthClient(db, out.clientId);
    expect(row?.secret_hash).toBeNull();
  });

  it('revokeOAuthClient sets revoked_at and findOAuthClient returns null', async () => {
    const db = getTestDb();
    const uid = await aUser();
    const out = await createOAuthClient(db, {
      name: 'to revoke', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code'], scopes: ['market:read'],
      createdBy: uid, public: false,
    });
    await revokeOAuthClient(db, out.clientId);
    expect(await findOAuthClient(db, out.clientId)).toBeNull();
  });

  it('listOAuthClients hides revoked rows by default', async () => {
    const db = getTestDb();
    const before = (await listOAuthClients(db)).length;
    const uid = await aUser();
    const out = await createOAuthClient(db, {
      name: 'listed', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code'], scopes: ['market:read'],
      createdBy: uid, public: false,
    });
    expect((await listOAuthClients(db)).length).toBe(before + 1);
    await revokeOAuthClient(db, out.clientId);
    expect((await listOAuthClients(db)).length).toBe(before);
  });
});
```

- [ ] **Step 2 — Run it; expect import failure**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-clients.test.ts 2>&1
```
Expected: FAIL with module-not-found on `../src/oauth/clients`.

- [ ] **Step 3 — Implement clients.ts**

`apps/backend/src/oauth/clients.ts`:

```ts
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type postgres from 'postgres';

export type OAuthClientRow = {
  id: string;
  secret_hash: string | null;
  name: string;
  redirect_uris: string[];
  grant_types: string[];
  scopes: string[];
  created_by: string | null;
  created_at: Date;
  revoked_at: Date | null;
};

type AnySql = postgres.Sql | postgres.TransactionSql;

const newClientId = () => randomBytes(16).toString('hex');                  // 32 hex chars
const newClientSecret = () => randomBytes(32).toString('base64url');        // ~43 chars

export type CreateClientInput = {
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  scopes: string[];
  createdBy: string | null;
  public: boolean;
};

export async function createOAuthClient(
  sql: AnySql,
  input: CreateClientInput,
): Promise<{ clientId: string; clientSecret: string | null }> {
  const id = newClientId();
  const secret = input.public ? null : newClientSecret();
  const hash = secret ? await bcrypt.hash(secret, 10) : null;
  await sql`
    INSERT INTO oauth_clients
      (id, secret_hash, name, redirect_uris, grant_types, scopes, created_by)
    VALUES
      (${id}, ${hash}, ${input.name}, ${input.redirectUris},
       ${input.grantTypes}, ${input.scopes}, ${input.createdBy})
  `;
  return { clientId: id, clientSecret: secret };
}

export async function findOAuthClient(
  sql: AnySql,
  clientId: string,
): Promise<OAuthClientRow | null> {
  const rows = await sql<OAuthClientRow[]>`
    SELECT * FROM oauth_clients WHERE id = ${clientId} AND revoked_at IS NULL LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function verifyClientSecret(
  row: OAuthClientRow,
  presented: string,
): Promise<boolean> {
  if (!row.secret_hash) return false;
  return bcrypt.compare(presented, row.secret_hash);
}

export async function listOAuthClients(sql: AnySql): Promise<OAuthClientRow[]> {
  return sql<OAuthClientRow[]>`
    SELECT * FROM oauth_clients WHERE revoked_at IS NULL ORDER BY created_at DESC
  `;
}

export async function revokeOAuthClient(sql: AnySql, clientId: string): Promise<void> {
  await sql`
    UPDATE oauth_clients SET revoked_at = NOW() WHERE id = ${clientId} AND revoked_at IS NULL
  `;
  // Cascade revoke any live refresh tokens for this client.
  await sql`
    UPDATE oauth_refresh_tokens SET revoked_at = NOW()
    WHERE client_id = ${clientId} AND revoked_at IS NULL
  `;
}
```

- [ ] **Step 4 — Run tests; expect pass**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-clients.test.ts 2>&1
```
Expected: all five tests PASS.

- [ ] **Step 5 — Commit**

```bash
git add apps/backend/src/oauth/clients.ts apps/backend/tests/oauth-clients.test.ts
git commit -m "feat(oauth): client CRUD + secret hashing"
```

---

## Task 4: oauth/pkce.ts — S256 verifier/challenge helpers

**Why:** Tiny pure-function module verified standalone. Used by `/oauth/authorize` (stores `code_challenge`) and `/oauth/token` (verifies `code_verifier`).

**Files:**
- Create: `apps/backend/src/oauth/pkce.ts`
- Create: `apps/backend/tests/oauth-pkce.test.ts`

- [ ] **Step 1 — Write the failing test**

`apps/backend/tests/oauth-pkce.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateVerifier, challengeS256, verifyChallenge } from '../src/oauth/pkce';

describe('PKCE S256', () => {
  it('generates a verifier of 43-128 chars from the unreserved set', () => {
    const v = generateVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(/^[A-Za-z0-9_~.-]+$/.test(v)).toBe(true);
  });

  it('challengeS256 yields a 43-char base64url-without-padding hash', () => {
    const ch = challengeS256('abc');
    expect(ch.length).toBe(43);
    expect(/^[A-Za-z0-9_-]+$/.test(ch)).toBe(true);
    expect(ch.endsWith('=')).toBe(false);
  });

  it('verifyChallenge round-trips', () => {
    const v = generateVerifier();
    const ch = challengeS256(v);
    expect(verifyChallenge(ch, v)).toBe(true);
    expect(verifyChallenge(ch, v + 'x')).toBe(false);
  });
});
```

- [ ] **Step 2 — Run it; expect FAIL on import**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-pkce.test.ts 2>&1
```

- [ ] **Step 3 — Implement pkce.ts**

`apps/backend/src/oauth/pkce.ts`:

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// Generates a 64-byte verifier base64url-encoded (≈86 chars), inside the
// RFC 7636 length window.
export function generateVerifier(): string {
  return randomBytes(64).toString('base64url');
}

export function challengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function verifyChallenge(challenge: string, verifier: string): boolean {
  const expected = Buffer.from(challengeS256(verifier));
  const provided = Buffer.from(challenge);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
```

- [ ] **Step 4 — Run tests; expect pass**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-pkce.test.ts 2>&1
```

- [ ] **Step 5 — Commit**

```bash
git add apps/backend/src/oauth/pkce.ts apps/backend/tests/oauth-pkce.test.ts
git commit -m "feat(oauth): PKCE S256 helpers"
```

---

## Task 5: oauth/tokens.ts — JWS access tokens + opaque refresh family

**Why:** The cryptographic heart of the AS. Access tokens are JWS Ed25519, refresh tokens are opaque + rotating family — mirrors the existing `auth.ts` refresh-token logic with the same anti-theft semantic (reuse revokes the family).

**Files:**
- Create: `apps/backend/src/oauth/tokens.ts`
- Create: `apps/backend/tests/oauth-tokens.test.ts`

- [ ] **Step 1 — Write the failing test**

`apps/backend/tests/oauth-tokens.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { createOAuthClient } from '../src/oauth/clients';
import {
  generateSigningKey, signAccessToken, verifyAccessToken,
  issueRefreshToken, rotateRefreshToken, revokeRefreshFamily,
} from '../src/oauth/tokens';

const env = (overrides: Record<string, string> = {}) => ({
  OAUTH_ISSUER_URL: 'https://erp.test',
  OAUTH_SIGNING_KEY_CURRENT: process.env.__TEST_KEY__,
  OAUTH_ACCESS_TOKEN_TTL_SEC: '60',
  OAUTH_REFRESH_TOKEN_TTL_SEC: '3600',
  ...overrides,
} as any);

describe('oauth tokens', () => {
  beforeAll(async () => {
    await resetDb();
    process.env.__TEST_KEY__ = await generateSigningKey();
  });

  async function aClient() {
    const db = getTestDb();
    const u = (await db<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    return createOAuthClient(db, {
      name: 'tk', redirectUris: ['https://x/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
  }

  it('signs an access token and verifies it back', async () => {
    const c = await aClient();
    const at = await signAccessToken(env(), {
      clientId: c.clientId, userId: '00000000-0000-0000-0000-000000000001',
      scopes: ['market:read'],
    });
    const claims = await verifyAccessToken(env(), at);
    expect(claims?.cid).toBe(c.clientId);
    expect(claims?.scopes).toEqual(['market:read']);
    expect(claims?.iss).toBe('https://erp.test');
  });

  it('rejects an access token signed with a different key', async () => {
    const c = await aClient();
    const at = await signAccessToken(env(), {
      clientId: c.clientId, userId: null, scopes: ['market:write'],
    });
    const otherKey = await generateSigningKey();
    const e2 = env({ OAUTH_SIGNING_KEY_CURRENT: otherKey, OAUTH_SIGNING_KEY_PREVIOUS: '' });
    expect(await verifyAccessToken(e2, at)).toBeNull();
  });

  it('verifies tokens signed with the PREVIOUS key when CURRENT rotated', async () => {
    const c = await aClient();
    const oldKey = process.env.__TEST_KEY__!;
    const at = await signAccessToken(env(), {
      clientId: c.clientId, userId: null, scopes: ['market:read'],
    });
    const newKey = await generateSigningKey();
    const e2 = env({ OAUTH_SIGNING_KEY_CURRENT: newKey, OAUTH_SIGNING_KEY_PREVIOUS: oldKey });
    const claims = await verifyAccessToken(e2, at);
    expect(claims).not.toBeNull();
  });

  it('rotateRefreshToken detects reuse and revokes the family', async () => {
    const db = getTestDb();
    const c = await aClient();
    const u = (await db<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const r1 = await issueRefreshToken(db, env(), {
      clientId: c.clientId, userId: u, scopes: ['market:read'],
    });
    const r2 = await rotateRefreshToken(db, r1.raw);
    expect(r2.ok).toBe(true);
    const reuse = await rotateRefreshToken(db, r1.raw);
    expect(reuse.ok).toBe(false);
    // The just-issued r2 token is now revoked transitively.
    if (r2.ok) {
      const after = await rotateRefreshToken(db, r2.raw);
      expect(after.ok).toBe(false);
    }
  });

  it('issueRefreshToken with null userId works (client_credentials)', async () => {
    const db = getTestDb();
    const c = await aClient();
    const r = await issueRefreshToken(db, env(), {
      clientId: c.clientId, userId: null, scopes: ['market:write'],
    });
    expect(r.raw).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

- [ ] **Step 2 — Run it; expect FAIL**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-tokens.test.ts 2>&1
```

- [ ] **Step 3 — Implement tokens.ts**

`apps/backend/src/oauth/tokens.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { exportPKCS8, generateKeyPair, importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose';
import type postgres from 'postgres';
import type { Env, OAuthScope } from '../types';

type AnySql = postgres.Sql | postgres.TransactionSql;

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const sec = (n?: string, d?: number) => Number.parseInt(n ?? String(d), 10) || (d ?? 0);

// ── Keys ───────────────────────────────────────────────────────────────────
// Operator stores Ed25519 private keys in env as base64-encoded PKCS#8 PEM so
// `.env` doesn't have to wrap multi-line values. Generate one with
//   openssl genpkey -algorithm ed25519 | base64 -w0
// or call generateSigningKey() in a one-off script.

export async function generateSigningKey(): Promise<string> {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const pem = await exportPKCS8(privateKey);
  return Buffer.from(pem).toString('base64');
}

async function loadKey(b64: string): Promise<CryptoKey> {
  const pem = Buffer.from(b64, 'base64').toString('utf8');
  return importPKCS8(pem, 'EdDSA');
}

function keyKid(b64: string): string {
  // Deterministic short kid derived from the key bytes; lets the verifier pick
  // the matching key from the ring without exposing the key itself.
  return sha256hex(b64).slice(0, 16);
}

// ── Access tokens (JWS, not stored) ────────────────────────────────────────

export type AccessClaims = {
  iss: string;
  sub: string | null;       // user_id (UUID) or null for client_credentials
  cid: string;              // client_id
  scopes: OAuthScope[];
  jti: string;
  exp: number;
  iat: number;
  aud: 'recycle-erp-api';
};

export async function signAccessToken(env: Env, input: {
  clientId: string; userId: string | null; scopes: OAuthScope[];
}): Promise<string> {
  if (!env.OAUTH_SIGNING_KEY_CURRENT) throw new Error('OAUTH_SIGNING_KEY_CURRENT not set');
  const key = await loadKey(env.OAUTH_SIGNING_KEY_CURRENT);
  const kid = keyKid(env.OAUTH_SIGNING_KEY_CURRENT);
  const ttl = sec(env.OAUTH_ACCESS_TOKEN_TTL_SEC, 900);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ cid: input.clientId, scopes: input.scopes })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setIssuer(env.OAUTH_ISSUER_URL ?? '')
    .setAudience('recycle-erp-api')
    .setSubject(input.userId ?? '')
    .setJti(randomBytes(16).toString('hex'))
    .sign(key);
}

export async function verifyAccessToken(env: Env, token: string): Promise<AccessClaims | null> {
  const candidates = [env.OAUTH_SIGNING_KEY_CURRENT, env.OAUTH_SIGNING_KEY_PREVIOUS]
    .filter((s): s is string => Boolean(s));
  for (const b64 of candidates) {
    try {
      const key = await loadKey(b64);
      const { payload } = await jwtVerify(token, key, {
        issuer: env.OAUTH_ISSUER_URL ?? '',
        audience: 'recycle-erp-api',
      });
      return {
        iss: payload.iss as string,
        sub: (payload.sub as string) || null,
        cid: payload.cid as string,
        scopes: payload.scopes as OAuthScope[],
        jti: payload.jti as string,
        exp: payload.exp as number,
        iat: payload.iat as number,
        aud: 'recycle-erp-api',
      };
    } catch { /* try next */ }
  }
  return null;
}

// ── Refresh tokens (opaque, hashed, rotating family) ───────────────────────

const opaqueToken = () => randomBytes(32).toString('hex');

export type IssueRefreshInput = {
  clientId: string;
  userId: string | null;
  scopes: OAuthScope[];
  familyId?: string;
  parentId?: number;
};

export async function issueRefreshToken(
  sql: AnySql,
  env: Env,
  input: IssueRefreshInput,
): Promise<{ raw: string; familyId: string; id: number }> {
  const raw = opaqueToken();
  const familyId = input.familyId ?? crypto.randomUUID();
  const ttl = sec(env.OAUTH_REFRESH_TOKEN_TTL_SEC, 2_592_000);
  const exp = new Date(Date.now() + ttl * 1000);
  const rows = await sql<{ id: number }[]>`
    INSERT INTO oauth_refresh_tokens
      (token_hash, client_id, user_id, scopes, family_id, parent_id, expires_at)
    VALUES
      (${sha256hex(raw)}, ${input.clientId}, ${input.userId}, ${input.scopes},
       ${familyId}, ${input.parentId ?? null}, ${exp})
    RETURNING id
  `;
  return { raw, familyId, id: rows[0].id };
}

export type RotateRefreshResult =
  | { ok: true; raw: string; clientId: string; userId: string | null; scopes: OAuthScope[]; familyId: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'revoked' | 'reused' };

export async function rotateRefreshToken(
  sql: postgres.Sql,
  raw: string,
): Promise<RotateRefreshResult> {
  return sql.begin<RotateRefreshResult>(async (tx) => {
    const row = (await tx<{
      id: number; client_id: string; user_id: string | null; scopes: OAuthScope[];
      family_id: string; revoked_at: Date | null; expired: boolean;
    }[]>`
      SELECT id, client_id, user_id, scopes, family_id, revoked_at,
             (expires_at <= NOW()) AS expired
      FROM oauth_refresh_tokens
      WHERE token_hash = ${sha256hex(raw)}
      FOR UPDATE
      LIMIT 1
    `)[0];
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.revoked_at) {
      // Token-theft signal: someone replayed an already-rotated token.
      await revokeRefreshFamily(tx, row.family_id);
      return { ok: false, reason: 'reused' };
    }
    if (row.expired) return { ok: false, reason: 'expired' };
    await tx`UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE id = ${row.id}`;
    const env = process.env as unknown as Env;
    const next = await issueRefreshToken(tx, env, {
      clientId: row.client_id,
      userId: row.user_id,
      scopes: row.scopes,
      familyId: row.family_id,
      parentId: row.id,
    });
    return {
      ok: true, raw: next.raw, clientId: row.client_id, userId: row.user_id,
      scopes: row.scopes, familyId: row.family_id,
    };
  });
}

export async function revokeRefreshFamily(sql: AnySql, familyId: string): Promise<void> {
  await sql`
    UPDATE oauth_refresh_tokens SET revoked_at = NOW()
    WHERE family_id = ${familyId} AND revoked_at IS NULL
  `;
}
```

- [ ] **Step 4 — Run tests; expect pass**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-tokens.test.ts 2>&1
```

- [ ] **Step 5 — Commit**

```bash
git add apps/backend/src/oauth/tokens.ts apps/backend/tests/oauth-tokens.test.ts
git commit -m "feat(oauth): Ed25519 JWS access tokens + rotating refresh families"
```

---

## Task 6: oauth/metadata.ts + /.well-known endpoints

**Why:** RFC 8414 + RFC 9728 discovery so MCP clients can find the AS automatically off a 401 response. Pure functions of env — easy to test.

**Files:**
- Create: `apps/backend/src/oauth/metadata.ts`
- Modify: `apps/backend/src/oauth/server.ts` (created here as a stub)
- Create: `apps/backend/tests/oauth-endpoints.test.ts` (covers all OAuth HTTP from here on)

- [ ] **Step 1 — Write a failing test**

`apps/backend/tests/oauth-endpoints.test.ts` (initial slice — discovery only):

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';

describe('OAuth discovery', () => {
  beforeAll(async () => { await resetDb(); });

  it('GET /.well-known/oauth-authorization-server returns RFC 8414 metadata', async () => {
    const r = await api('GET', '/.well-known/oauth-authorization-server');
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(typeof body.issuer).toBe('string');
    expect(body.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
    expect(body.token_endpoint).toMatch(/\/oauth\/token$/);
    expect(body.registration_endpoint).toMatch(/\/oauth\/register$/);
    expect(body.revocation_endpoint).toMatch(/\/oauth\/revoke$/);
    expect((body.scopes_supported as string[])).toEqual(expect.arrayContaining(['market:read','market:write']));
    expect((body.grant_types_supported as string[])).toEqual(expect.arrayContaining(['authorization_code','refresh_token','client_credentials']));
    expect((body.code_challenge_methods_supported as string[])).toEqual(['S256']);
  });

  it('GET /.well-known/oauth-protected-resource points to the AS', async () => {
    const r = await api('GET', '/.well-known/oauth-protected-resource');
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect((body.authorization_servers as string[])[0]).toMatch(/^https?:\/\//);
    expect((body.scopes_supported as string[])).toEqual(expect.arrayContaining(['market:read','market:write']));
  });
});
```

- [ ] **Step 2 — Run; expect 404 failures**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-endpoints.test.ts 2>&1
```

- [ ] **Step 3 — Implement metadata + stub server**

`apps/backend/src/oauth/metadata.ts`:

```ts
import type { Env } from '../types';

const SCOPES = ['market:read', 'market:write'] as const;

export function authorizationServerMetadata(env: Env) {
  const iss = env.OAUTH_ISSUER_URL ?? '';
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    revocation_endpoint: `${iss}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: SCOPES,
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_signing_alg_values_supported: ['EdDSA'],
  };
}

export function protectedResourceMetadata(env: Env) {
  const iss = env.OAUTH_ISSUER_URL ?? '';
  return {
    resource: `${iss}/api/mcp`,
    authorization_servers: [iss],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
  };
}
```

`apps/backend/src/oauth/server.ts`:

```ts
import { Hono } from 'hono';
import type { Env, User } from '../types';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata';

const oauth = new Hono<{ Bindings: Env; Variables: { user: User } }>();

oauth.get('/oauth-authorization-server', (c) =>
  c.json(authorizationServerMetadata(c.env as Env)),
);

oauth.get('/oauth-protected-resource', (c) =>
  c.json(protectedResourceMetadata(c.env as Env)),
);

export default oauth;
```

- [ ] **Step 4 — Mount on the public surface**

Edit `apps/backend/src/index.ts`. Below the existing public route mounts (`/api/auth`, `/api/public/vendor`), add:

```ts
import oauthRoutes from './oauth/server';
app.route('/.well-known', oauthRoutes);
```

- [ ] **Step 5 — Run; expect PASS**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-endpoints.test.ts 2>&1
```

- [ ] **Step 6 — Commit**

```bash
git add apps/backend/src/oauth/metadata.ts apps/backend/src/oauth/server.ts apps/backend/src/index.ts apps/backend/tests/oauth-endpoints.test.ts
git commit -m "feat(oauth): RFC 8414 + RFC 9728 discovery endpoints"
```

---

## Task 7: /oauth/register (Dynamic Client Registration)

**Why:** Lets an MCP client (or our own Settings UI later) register itself without manual DB writes. Gated by `OAUTH_DCR_OPEN` in prod.

**Files:**
- Modify: `apps/backend/src/oauth/server.ts`
- Modify: `apps/backend/tests/oauth-endpoints.test.ts`

- [ ] **Step 1 — Add failing test cases**

Append inside `apps/backend/tests/oauth-endpoints.test.ts`:

```ts
describe('DCR /oauth/register', () => {
  it('rejects DCR by default (OAUTH_DCR_OPEN=false)', async () => {
    const r = await api('POST', '/oauth/register', {
      body: { client_name: 'x', redirect_uris: ['https://example.com/cb'] },
    });
    expect(r.status).toBe(403);
  });

  it('with OAUTH_DCR_OPEN=true, registers and returns client_id + secret', async () => {
    const prev = process.env.OAUTH_DCR_OPEN;
    process.env.OAUTH_DCR_OPEN = 'true';
    try {
      const r = await api('POST', '/oauth/register', {
        body: {
          client_name: 'claude-ai connector',
          redirect_uris: ['https://claude.ai/oauth/callback'],
          grant_types: ['authorization_code','refresh_token'],
          scope: 'market:read',
        },
      });
      expect(r.status).toBe(201);
      const body = r.body as Record<string, unknown>;
      expect(typeof body.client_id).toBe('string');
      expect(typeof body.client_secret).toBe('string');
      expect((body.redirect_uris as string[])[0]).toBe('https://claude.ai/oauth/callback');
    } finally {
      process.env.OAUTH_DCR_OPEN = prev;
    }
  });

  it('rejects non-https + non-localhost redirect URIs', async () => {
    const prev = process.env.OAUTH_DCR_OPEN;
    process.env.OAUTH_DCR_OPEN = 'true';
    try {
      const r = await api('POST', '/oauth/register', {
        body: { client_name: 'evil', redirect_uris: ['http://evil.example.com/cb'] },
      });
      expect(r.status).toBe(400);
    } finally {
      process.env.OAUTH_DCR_OPEN = prev;
    }
  });
});
```

- [ ] **Step 2 — Run; expect FAIL**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-endpoints.test.ts 2>&1
```

- [ ] **Step 3 — Implement /oauth/register**

Edit `apps/backend/src/oauth/server.ts`. Add after the existing metadata handlers:

```ts
import { getDb } from '../db';
import { createOAuthClient } from './clients';

function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
    return false;
  } catch { return false; }
}

oauth.post('/register', async (c) => {
  if ((c.env as Env).OAUTH_DCR_OPEN !== 'true') {
    return c.json({ error: 'registration disabled' }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as null | {
    client_name?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    scope?: string;
  };
  if (!body?.client_name || !Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    return c.json({ error: 'client_name and redirect_uris required' }, 400);
  }
  for (const r of body.redirect_uris) {
    if (!isValidRedirectUri(r)) return c.json({ error: `invalid redirect_uri: ${r}` }, 400);
  }
  const allowedGrants = new Set(['authorization_code', 'refresh_token']);
  const grants = (body.grant_types ?? ['authorization_code', 'refresh_token']).filter(g => allowedGrants.has(g));
  if (grants.length === 0) return c.json({ error: 'no allowed grant_types requested' }, 400);
  const scopes = (body.scope?.split(' ').filter(Boolean) ?? ['market:read']);
  for (const s of scopes) {
    if (s !== 'market:read') return c.json({ error: `scope ${s} not grantable via DCR` }, 400);
  }
  const sql = getDb(c.env);
  const out = await createOAuthClient(sql, {
    name: body.client_name,
    redirectUris: body.redirect_uris,
    grantTypes: grants,
    scopes,
    createdBy: null,
    public: false,
  });
  return c.json({
    client_id: out.clientId,
    client_secret: out.clientSecret,
    redirect_uris: body.redirect_uris,
    grant_types: grants,
    scope: scopes.join(' '),
    token_endpoint_auth_method: 'client_secret_basic',
  }, 201);
});
```

The route is mounted at `/.well-known` for discovery; we want `/oauth/*` for grants. Also mount a second sub-app at `/oauth/*` — change the export:

At the bottom of `apps/backend/src/oauth/server.ts`, restructure:

```ts
// Two mount points: .well-known/* for discovery, /oauth/* for grants.
export const wellKnown = new Hono<{ Bindings: Env; Variables: { user: User } }>()
  .get('/oauth-authorization-server', (c) => c.json(authorizationServerMetadata(c.env as Env)))
  .get('/oauth-protected-resource', (c) => c.json(protectedResourceMetadata(c.env as Env)));

export default oauth; // /oauth/* — currently has /register
```

…and update `apps/backend/src/index.ts` to mount both:

```ts
import oauthRoutes, { wellKnown } from './oauth/server';
app.route('/.well-known', wellKnown);
app.route('/oauth', oauthRoutes);
```

Then move the two `oauth.get('/oauth-...')` handlers above out of `oauth` (they belonged in `wellKnown`).

- [ ] **Step 4 — Run all OAuth tests; expect PASS**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-endpoints.test.ts 2>&1
```

- [ ] **Step 5 — Commit**

```bash
git add apps/backend/src/oauth/server.ts apps/backend/src/index.ts apps/backend/tests/oauth-endpoints.test.ts
git commit -m "feat(oauth): RFC 7591 Dynamic Client Registration (gated by OAUTH_DCR_OPEN)"
```

---

## Task 8: /oauth/authorize (auth-code flow, server-side)

**Why:** First half of the interactive grant. Validates the request, requires a logged-in user (cookie auth), and either redirects to login or renders the consent screen. v1 keeps the consent UI simple — it lives in the SPA at `/authorize` (Task 13). The backend's job is validation + the eventual code mint.

**Files:**
- Modify: `apps/backend/src/oauth/server.ts`
- Modify: `apps/backend/tests/oauth-endpoints.test.ts`

- [ ] **Step 1 — Write the failing tests**

Append to `apps/backend/tests/oauth-endpoints.test.ts`:

```ts
import { loginAs, ALEX } from './helpers/auth';
import { getTestDb } from './helpers/db';

describe('/oauth/authorize', () => {
  async function aClient() {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    return createOAuthClient(sql, {
      name: 'authz', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
  }

  it('400s on missing client_id', async () => {
    const r = await api('GET', '/oauth/authorize?response_type=code');
    expect(r.status).toBe(400);
  });

  it('400s on unknown client_id', async () => {
    const r = await api('GET', '/oauth/authorize?response_type=code&client_id=ghost&redirect_uri=https://x/cb&code_challenge=abc&code_challenge_method=S256');
    expect(r.status).toBe(400);
  });

  it('400s on redirect_uri not in allowlist', async () => {
    const c = await aClient();
    const r = await api('GET', `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://attacker/cb&code_challenge=ch&code_challenge_method=S256`);
    expect(r.status).toBe(400);
  });

  it('302s to /login when no auth cookie', async () => {
    const c = await aClient();
    const r = await api('GET', `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://example.com/cb&code_challenge=ch&code_challenge_method=S256&scope=market:read&state=s1`, {
      redirect: 'manual',
    });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/^\/login\?next=/);
  });

  it('renders the consent page when logged in (302 to /authorize?...)', async () => {
    const c = await aClient();
    const { cookie } = await loginAs(ALEX);
    const r = await api('GET', `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://example.com/cb&code_challenge=ch&code_challenge_method=S256&scope=market:read&state=s1`, {
      headers: { cookie }, redirect: 'manual',
    });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/^\/authorize\?req=/);
  });
});

describe('/oauth/authorize/consent', () => {
  it('issues a code and 302s to redirect_uri with code + state', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'consent', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const { cookie } = await loginAs(ALEX);
    const r = await api('POST', '/oauth/authorize/consent', {
      body: {
        client_id: c.clientId, redirect_uri: 'https://example.com/cb',
        scope: 'market:read', state: 's1',
        code_challenge: 'ch', code_challenge_method: 'S256',
      },
      headers: { cookie, 'X-Requested-By': 'recycle-erp' },
      redirect: 'manual',
    });
    expect(r.status).toBe(302);
    const loc = r.headers.get('location') ?? '';
    expect(loc.startsWith('https://example.com/cb')).toBe(true);
    expect(loc).toMatch(/[?&]code=/);
    expect(loc).toMatch(/[?&]state=s1\b/);
  });
});
```

- [ ] **Step 2 — Run; expect FAIL**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-endpoints.test.ts 2>&1
```

- [ ] **Step 3 — Implement authorize + consent**

In `apps/backend/src/oauth/server.ts`, add:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { getCookie } from 'hono/cookie';
import { authMiddleware } from '../auth';
import { findOAuthClient } from './clients';

const CODE_TTL_SEC = 600;
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

oauth.get('/authorize', async (c) => {
  const q = c.req.query();
  if (!q.client_id) return c.json({ error: 'invalid_request', detail: 'client_id required' }, 400);
  const sql = getDb(c.env);
  const client = await findOAuthClient(sql, q.client_id);
  if (!client) return c.json({ error: 'invalid_client' }, 400);
  if (q.response_type !== 'code') return c.json({ error: 'unsupported_response_type' }, 400);
  if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
    return c.json({ error: 'invalid_redirect_uri' }, 400);
  }
  if (q.code_challenge_method !== 'S256' || !q.code_challenge) {
    return c.json({ error: 'invalid_request', detail: 'PKCE S256 required' }, 400);
  }
  const requested = (q.scope ?? '').split(' ').filter(Boolean);
  for (const s of requested) {
    if (!client.scopes.includes(s)) {
      return c.json({ error: 'invalid_scope', detail: `client lacks scope ${s}` }, 400);
    }
  }
  // Require ERP login. Cookie auth runs only on /api/*; check the cookie ourselves.
  if (!getCookie(c, 'at')) {
    const next = encodeURIComponent('/oauth/authorize?' + new URLSearchParams(q).toString());
    return c.redirect(`/login?next=${next}`, 302);
  }
  // Park the request server-side and hand the SPA an opaque handle. This
  // keeps long PKCE challenges out of the URL on the consent screen.
  const req = randomBytes(16).toString('hex');
  await sql`
    INSERT INTO oauth_pending_consent (req, client_id, redirect_uri, scopes, code_challenge, state, expires_at, user_id_from_cookie)
    VALUES (${req}, ${q.client_id}, ${q.redirect_uri}, ${requested}, ${q.code_challenge}, ${q.state ?? null},
            NOW() + INTERVAL '10 minutes', NULL)
  `;
  return c.redirect(`/authorize?req=${req}`, 302);
});

oauth.post('/authorize/consent', authMiddleware, async (c) => {
  const body = (await c.req.json().catch(() => null)) as null | {
    client_id?: string; redirect_uri?: string; scope?: string; state?: string;
    code_challenge?: string; code_challenge_method?: string;
  };
  if (!body) return c.json({ error: 'invalid_request' }, 400);
  const sql = getDb(c.env);
  const client = body.client_id ? await findOAuthClient(sql, body.client_id) : null;
  if (!client) return c.json({ error: 'invalid_client' }, 400);
  if (!body.redirect_uri || !client.redirect_uris.includes(body.redirect_uri)) {
    return c.json({ error: 'invalid_redirect_uri' }, 400);
  }
  if (body.code_challenge_method !== 'S256' || !body.code_challenge) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const user = c.var.user;
  const scopes = (body.scope ?? '').split(' ').filter(Boolean);
  const code = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + CODE_TTL_SEC * 1000);
  await sql`
    INSERT INTO oauth_authorization_codes
      (code_hash, client_id, user_id, redirect_uri, scopes, code_challenge, expires_at)
    VALUES
      (${sha256hex(code)}, ${client.id}, ${user.id}, ${body.redirect_uri}, ${scopes},
       ${body.code_challenge}, ${expires})
  `;
  const url = new URL(body.redirect_uri);
  url.searchParams.set('code', code);
  if (body.state) url.searchParams.set('state', body.state);
  return c.redirect(url.toString(), 302);
});
```

The "pending consent" handle (`req`) is a UX nicety so the SPA doesn't have to parrot the PKCE challenge through the URL. That table isn't in `0046_oauth.sql` — extend it:

Append to `apps/backend/migrations/0046_oauth.sql`:

```sql
CREATE TABLE IF NOT EXISTS oauth_pending_consent (
  req                  TEXT PRIMARY KEY,
  client_id            TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  redirect_uri         TEXT NOT NULL,
  scopes               TEXT[] NOT NULL,
  code_challenge       TEXT NOT NULL,
  state                TEXT,
  expires_at           TIMESTAMPTZ NOT NULL,
  user_id_from_cookie  UUID  -- informational only; the consent POST re-derives from cookie
);
CREATE INDEX IF NOT EXISTS oauth_pending_consent_expires_idx
  ON oauth_pending_consent (expires_at);
```

The `_migration_ledger` records each file at first apply, so editing this migration is **only safe before it's been deployed anywhere**. Since this is still on a feature branch with no prior deploy, OK. (If you find this file edited post-deploy, add `0047_oauth_pending_consent.sql` instead.)

Add a small GET endpoint that the SPA hits to load the parked request payload:

```ts
oauth.get('/authorize/pending/:req', authMiddleware, async (c) => {
  const sql = getDb(c.env);
  const row = (await sql<{
    client_id: string; redirect_uri: string; scopes: string[];
    code_challenge: string; state: string | null;
  }[]>`
    SELECT client_id, redirect_uri, scopes, code_challenge, state
    FROM oauth_pending_consent
    WHERE req = ${c.req.param('req')} AND expires_at > NOW()
    LIMIT 1
  `)[0];
  if (!row) return c.json({ error: 'expired_or_unknown' }, 404);
  const client = await findOAuthClient(sql, row.client_id);
  if (!client) return c.json({ error: 'invalid_client' }, 400);
  return c.json({
    clientId: row.client_id,
    clientName: client.name,
    redirectUri: row.redirect_uri,
    scopes: row.scopes,
    codeChallenge: row.code_challenge,
    state: row.state,
  });
});
```

- [ ] **Step 4 — Run tests; expect pass**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-endpoints.test.ts 2>&1
```

- [ ] **Step 5 — Commit**

```bash
git add apps/backend/src/oauth/server.ts apps/backend/migrations/0046_oauth.sql apps/backend/tests/oauth-endpoints.test.ts
git commit -m "feat(oauth): /authorize + consent + pending-request handoff to SPA"
```

---

## Task 9: /oauth/token — authorization_code + refresh_token + client_credentials grants

**Why:** The token-mint surface. Three grants, all handled here. Authorization-code requires PKCE verifier check + client auth (basic OR post). Refresh rotates via `rotateRefreshToken` from Task 5. Client-credentials issues a token bound to a client only.

**Files:**
- Modify: `apps/backend/src/oauth/server.ts`
- Modify: `apps/backend/tests/oauth-endpoints.test.ts`

- [ ] **Step 1 — Write the failing tests**

Append to `apps/backend/tests/oauth-endpoints.test.ts`:

```ts
import { generateVerifier, challengeS256 } from '../src/oauth/pkce';

describe('/oauth/token', () => {
  it('authorization_code happy path returns access + refresh', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'tk-ac', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const verifier = generateVerifier();
    const challenge = challengeS256(verifier);
    const { cookie } = await loginAs(ALEX);
    const consent = await api('POST', '/oauth/authorize/consent', {
      body: { client_id: c.clientId, redirect_uri: 'https://example.com/cb',
              scope: 'market:read', state: 'st',
              code_challenge: challenge, code_challenge_method: 'S256' },
      headers: { cookie, 'X-Requested-By': 'recycle-erp' },
      redirect: 'manual',
    });
    const loc = consent.headers.get('location') ?? '';
    const code = new URL(loc).searchParams.get('code')!;
    const r = await api('POST', '/oauth/token', {
      form: {
        grant_type: 'authorization_code', code, code_verifier: verifier,
        redirect_uri: 'https://example.com/cb',
        client_id: c.clientId, client_secret: c.clientSecret!,
      },
    });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.token_type).toBe('Bearer');
    expect(body.scope).toBe('market:read');
  });

  it('rejects code reuse', async () => {
    // Same setup as above, then call /oauth/token twice with the same code.
    // Second call must be 400 invalid_grant.
    // [Repeat setup verbatim — see test above; here we condense to the second call.]
    // (full test body: replicate setup then call /token twice — second expects 400)
  });

  it('rejects wrong code_verifier', async () => {
    // Same setup, send a different verifier on the token call → 400.
  });

  it('client_credentials grant returns access token only', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'tk-cc', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['market:write'],
      createdBy: u, public: false,
    });
    const r = await api('POST', '/oauth/token', {
      form: {
        grant_type: 'client_credentials',
        client_id: c.clientId, client_secret: c.clientSecret!,
        scope: 'market:write',
      },
    });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(typeof body.access_token).toBe('string');
    expect(body.refresh_token).toBeUndefined();
    expect(body.scope).toBe('market:write');
  });

  it('rejects client_credentials for a client not granted that grant_type', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'wrong', redirectUris: ['https://x/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const r = await api('POST', '/oauth/token', {
      form: { grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret! },
    });
    expect(r.status).toBe(400);
  });

  it('refresh_token grant rotates and invalidates the old token', async () => {
    // Build via the authorization_code path, then exchange the refresh token,
    // then attempt to use the old refresh token → expect failure.
  });
});
```

(The test file should include the full bodies for the "code reuse", "wrong verifier", and "refresh rotates" cases — replicate the setup from the happy-path test verbatim. The implementing agent must NOT abbreviate.)

- [ ] **Step 2 — Run; expect FAIL**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-endpoints.test.ts 2>&1
```

- [ ] **Step 3 — Implement /oauth/token**

In `apps/backend/src/oauth/server.ts`, add:

```ts
import { findOAuthClient, verifyClientSecret } from './clients';
import { verifyChallenge } from './pkce';
import { signAccessToken, issueRefreshToken, rotateRefreshToken } from './tokens';

type ParsedClientCreds = { id: string; secret: string | null };

function readClientCreds(c: any, body: Record<string, string>): ParsedClientCreds | null {
  const authz = c.req.header('authorization');
  if (authz?.startsWith('Basic ')) {
    const decoded = Buffer.from(authz.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i > 0) return { id: decoded.slice(0, i), secret: decoded.slice(i + 1) };
  }
  if (body.client_id) {
    return { id: body.client_id, secret: body.client_secret ?? null };
  }
  return null;
}

async function readFormBody(c: any): Promise<Record<string, string>> {
  const ct = c.req.header('content-type') ?? '';
  if (ct.includes('application/json')) return await c.req.json();
  const text = await c.req.text();
  return Object.fromEntries(new URLSearchParams(text)) as Record<string, string>;
}

oauth.post('/token', async (c) => {
  const env = c.env as Env;
  const sql = getDb(env);
  const form = await readFormBody(c);
  const creds = readClientCreds(c, form);
  if (!creds) return c.json({ error: 'invalid_client' }, 401);

  const client = await findOAuthClient(sql, creds.id);
  if (!client) return c.json({ error: 'invalid_client' }, 401);

  if (client.secret_hash) {
    if (!creds.secret || !(await verifyClientSecret(client, creds.secret))) {
      return c.json({ error: 'invalid_client' }, 401);
    }
  }

  const grant = form.grant_type;

  if (grant === 'authorization_code') {
    if (!client.grant_types.includes('authorization_code')) {
      return c.json({ error: 'unauthorized_client' }, 400);
    }
    const { code, code_verifier, redirect_uri } = form;
    if (!code || !code_verifier || !redirect_uri) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const row = await sql.begin(async (tx) => {
      const r = (await tx<{
        client_id: string; user_id: string; redirect_uri: string; scopes: string[];
        code_challenge: string; expired: boolean; consumed_at: Date | null;
      }[]>`
        SELECT client_id, user_id, redirect_uri, scopes, code_challenge,
               (expires_at <= NOW()) AS expired, consumed_at
        FROM oauth_authorization_codes
        WHERE code_hash = ${sha256hex(code)}
        FOR UPDATE
        LIMIT 1
      `)[0];
      if (!r || r.consumed_at || r.expired) return null;
      if (r.client_id !== client.id) return null;
      if (r.redirect_uri !== redirect_uri) return null;
      if (!verifyChallenge(r.code_challenge, code_verifier)) return null;
      await tx`UPDATE oauth_authorization_codes SET consumed_at = NOW() WHERE code_hash = ${sha256hex(code)}`;
      return r;
    });
    if (!row) return c.json({ error: 'invalid_grant' }, 400);
    const at = await signAccessToken(env, {
      clientId: client.id, userId: row.user_id, scopes: row.scopes as any,
    });
    const rt = client.grant_types.includes('refresh_token')
      ? await issueRefreshToken(sql, env, { clientId: client.id, userId: row.user_id, scopes: row.scopes as any })
      : null;
    return c.json({
      access_token: at, token_type: 'Bearer',
      expires_in: Number.parseInt(env.OAUTH_ACCESS_TOKEN_TTL_SEC ?? '900', 10),
      refresh_token: rt?.raw, scope: row.scopes.join(' '),
    });
  }

  if (grant === 'refresh_token') {
    if (!client.grant_types.includes('refresh_token')) {
      return c.json({ error: 'unauthorized_client' }, 400);
    }
    const raw = form.refresh_token;
    if (!raw) return c.json({ error: 'invalid_request' }, 400);
    const res = await rotateRefreshToken(sql, raw);
    if (!res.ok) return c.json({ error: 'invalid_grant' }, 400);
    if (res.clientId !== client.id) return c.json({ error: 'invalid_grant' }, 400);
    const at = await signAccessToken(env, {
      clientId: client.id, userId: res.userId, scopes: res.scopes,
    });
    return c.json({
      access_token: at, token_type: 'Bearer',
      expires_in: Number.parseInt(env.OAUTH_ACCESS_TOKEN_TTL_SEC ?? '900', 10),
      refresh_token: res.raw, scope: res.scopes.join(' '),
    });
  }

  if (grant === 'client_credentials') {
    if (!client.grant_types.includes('client_credentials')) {
      return c.json({ error: 'unauthorized_client' }, 400);
    }
    const requested = (form.scope ?? '').split(' ').filter(Boolean);
    if (requested.length === 0) return c.json({ error: 'invalid_scope' }, 400);
    for (const s of requested) {
      if (!client.scopes.includes(s)) return c.json({ error: 'invalid_scope' }, 400);
    }
    const at = await signAccessToken(env, {
      clientId: client.id, userId: null, scopes: requested as any,
    });
    return c.json({
      access_token: at, token_type: 'Bearer',
      expires_in: Number.parseInt(env.OAUTH_ACCESS_TOKEN_TTL_SEC ?? '900', 10),
      scope: requested.join(' '),
    });
  }

  return c.json({ error: 'unsupported_grant_type' }, 400);
});
```

- [ ] **Step 4 — Run; expect PASS**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-endpoints.test.ts 2>&1
```

- [ ] **Step 5 — Commit**

```bash
git add apps/backend/src/oauth/server.ts apps/backend/tests/oauth-endpoints.test.ts
git commit -m "feat(oauth): /token endpoint — authorization_code + refresh_token + client_credentials grants"
```

---

## Task 10: /oauth/revoke + bearerGuard middleware

**Why:** RFC 7009 revocation, and the bearer middleware that gates `/api/mcp` and `/api/market/values`. Without the guard, the MCP server has no auth surface.

**Files:**
- Modify: `apps/backend/src/oauth/server.ts`
- Create: `apps/backend/src/oauth/guard.ts`
- Create: `apps/backend/tests/oauth-guard.test.ts`
- Append: `apps/backend/tests/oauth-endpoints.test.ts`

- [ ] **Step 1 — Write the failing tests**

`apps/backend/tests/oauth-guard.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { resetDb, getTestDb } from './helpers/db';
import { createOAuthClient } from '../src/oauth/clients';
import { signAccessToken, generateSigningKey } from '../src/oauth/tokens';
import { bearerGuard } from '../src/oauth/guard';

describe('bearerGuard', () => {
  let env: any;
  beforeAll(async () => {
    await resetDb();
    const key = await generateSigningKey();
    env = {
      OAUTH_ISSUER_URL: 'https://erp.test', OAUTH_SIGNING_KEY_CURRENT: key,
      OAUTH_ACCESS_TOKEN_TTL_SEC: '60',
    };
  });

  function buildApp(scopes: ('market:read'|'market:write')[]) {
    const app = new Hono<{ Bindings: any }>();
    app.use('*', bearerGuard({ scopes }));
    app.get('/ok', (c) => c.json({ ok: true }));
    return app;
  }

  it('401 without bearer + WWW-Authenticate header', async () => {
    const r = await buildApp(['market:read']).request('/ok', {}, env);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/resource_metadata=/);
  });

  it('401 with tampered signature', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const c = await createOAuthClient(sql, {
      name: 'gd', redirectUris: ['https://x/cb'],
      grantTypes: ['authorization_code'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const at = await signAccessToken(env, { clientId: c.clientId, userId: null, scopes: ['market:read'] });
    const tampered = at.slice(0, -4) + 'AAAA';
    const r = await buildApp(['market:read']).request('/ok', {
      headers: { authorization: `Bearer ${tampered}` },
    }, env);
    expect(r.status).toBe(401);
  });

  it('403 when token scope does not include required scope', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const c = await createOAuthClient(sql, {
      name: 'gd2', redirectUris: ['https://x/cb'],
      grantTypes: ['client_credentials'], scopes: ['market:read','market:write'],
      createdBy: u, public: false,
    });
    const at = await signAccessToken(env, { clientId: c.clientId, userId: null, scopes: ['market:read'] });
    const r = await buildApp(['market:write']).request('/ok', {
      headers: { authorization: `Bearer ${at}` },
    }, env);
    expect(r.status).toBe(403);
  });

  it('200 with valid scope and sets c.var.oauthCtx', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const c = await createOAuthClient(sql, {
      name: 'gd3', redirectUris: ['https://x/cb'],
      grantTypes: ['client_credentials'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const at = await signAccessToken(env, { clientId: c.clientId, userId: null, scopes: ['market:read'] });
    const r = await buildApp(['market:read']).request('/ok', {
      headers: { authorization: `Bearer ${at}` },
    }, env);
    expect(r.status).toBe(200);
  });
});
```

- [ ] **Step 2 — Run; expect FAIL**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-guard.test.ts 2>&1
```

- [ ] **Step 3 — Implement guard**

`apps/backend/src/oauth/guard.ts`:

```ts
import type { MiddlewareHandler } from 'hono';
import { verifyAccessToken } from './tokens';
import { protectedResourceMetadata } from './metadata';
import type { Env, OAuthCtx, OAuthScope } from '../types';

export function bearerGuard(opts: { scopes: OAuthScope[] }): MiddlewareHandler<{
  Bindings: Env;
  Variables: { oauthCtx: OAuthCtx };
}> {
  return async (c, next) => {
    const env = c.env as Env;
    const wwwAuth = `Bearer realm="recycle-erp", resource_metadata="${env.OAUTH_ISSUER_URL ?? ''}/.well-known/oauth-protected-resource"`;
    const header = c.req.header('authorization') ?? '';
    if (!header.toLowerCase().startsWith('bearer ')) {
      c.header('WWW-Authenticate', wwwAuth);
      return c.json({ error: 'unauthorized' }, 401);
    }
    const token = header.slice(7).trim();
    const claims = await verifyAccessToken(env, token);
    if (!claims) {
      c.header('WWW-Authenticate', wwwAuth);
      return c.json({ error: 'unauthorized' }, 401);
    }
    for (const need of opts.scopes) {
      if (!claims.scopes.includes(need)) {
        return c.json({ error: 'insufficient_scope', scope: opts.scopes.join(' ') }, 403);
      }
    }
    c.set('oauthCtx', {
      clientId: claims.cid, userId: claims.sub, scopes: claims.scopes, jti: claims.jti,
    });
    await next();
  };
}
```

- [ ] **Step 4 — Add /oauth/revoke + tests**

In `apps/backend/src/oauth/server.ts`, add:

```ts
import { revokeRefreshFamily } from './tokens';

oauth.post('/revoke', async (c) => {
  const form = await readFormBody(c);
  const creds = readClientCreds(c, form);
  if (!creds) return c.json({ error: 'invalid_client' }, 401);
  const sql = getDb(c.env);
  const client = await findOAuthClient(sql, creds.id);
  if (!client) return c.json({ error: 'invalid_client' }, 401);
  if (client.secret_hash && !(await verifyClientSecret(client, creds.secret ?? ''))) {
    return c.json({ error: 'invalid_client' }, 401);
  }
  const raw = form.token;
  if (!raw) return c.json({}, 200); // RFC 7009: unknown token is OK
  const row = (await sql<{ family_id: string; client_id: string }[]>`
    SELECT family_id, client_id FROM oauth_refresh_tokens
    WHERE token_hash = ${sha256hex(raw)} LIMIT 1
  `)[0];
  if (row && row.client_id === client.id) {
    await revokeRefreshFamily(sql, row.family_id);
  }
  return c.json({}, 200);
});
```

Append a revoke test in `apps/backend/tests/oauth-endpoints.test.ts`:

```ts
describe('/oauth/revoke', () => {
  it('revokes a refresh token family; subsequent rotate fails', async () => {
    // Build a token via authorization_code flow as in the happy-path test,
    // capture refresh_token, POST it to /oauth/revoke, then try /token
    // with grant_type=refresh_token → expect 400.
  });
});
```

(Implement the body fully; do not abbreviate.)

- [ ] **Step 5 — Run all OAuth tests; expect PASS**

```bash
pnpm --filter recycle-erp-backend test tests/oauth 2>&1
```

- [ ] **Step 6 — Commit**

```bash
git add apps/backend/src/oauth/guard.ts apps/backend/src/oauth/server.ts apps/backend/tests/oauth-guard.test.ts apps/backend/tests/oauth-endpoints.test.ts
git commit -m "feat(oauth): /revoke + bearerGuard middleware"
```

---

## Task 11: Extract `lib/market.ts` formatter (refactor; existing tests must still pass)

**Why:** The MCP tool and `GET /api/market` must return byte-identical shapes. Pulling the formatter out of `routes/market.ts` gates that.

**Files:**
- Create: `apps/backend/src/lib/market.ts`
- Modify: `apps/backend/src/routes/market.ts`
- Create: `apps/backend/tests/market-format.test.ts`

- [ ] **Step 1 — Write a failing test that pins the shape**

`apps/backend/tests/market-format.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { formatRefPrice } from '../src/lib/market';

describe('formatRefPrice', () => {
  beforeAll(async () => { await resetDb(); });

  it('maps a ref_prices row to the MarketValue DTO', async () => {
    const db = getTestDb();
    const row = (await db<any[]>`
      SELECT id, category, brand, capacity, type, classification, rank, speed,
             interface, form_factor, description, part_number, label, sub_label,
             target::float AS target, low_price::float AS low_price,
             high_price::float AS high_price, avg_sell::float AS avg_sell,
             trend, samples, source, stock, demand, history, updated_at,
             health::float AS health, rpm
      FROM ref_prices LIMIT 1
    `)[0];
    const v = formatRefPrice(row, 0.30);
    expect(v.id).toBe(row.id);
    expect(v.label).toBe(row.label);
    expect(v.formFactor).toBe(row.form_factor);
    expect(v.maxBuy).toBe(+(row.avg_sell * 0.70).toFixed(2));
    expect(v.updatedAt).toBe(row.updated_at.toISOString());
  });
});
```

- [ ] **Step 2 — Run; expect FAIL**

```bash
pnpm --filter recycle-erp-backend test tests/market-format.test.ts 2>&1
```

- [ ] **Step 3 — Implement formatter**

`apps/backend/src/lib/market.ts`:

```ts
export type MarketValueRow = {
  id: string;
  category: string;
  brand: string | null;
  capacity: string | null;
  type: string | null;
  classification: string | null;
  rank: string | null;
  speed: string | null;
  interface: string | null;
  form_factor: string | null;
  description: string | null;
  part_number: string | null;
  label: string;
  sub_label: string | null;
  target: number | null;
  low_price: number | null;
  high_price: number | null;
  avg_sell: number;
  trend: number | null;
  samples: number | null;
  source: string | null;
  stock: number | null;
  demand: number | null;
  history: unknown;
  updated_at: Date;
  health: number | null;
  rpm: number | null;
};

export type MarketValue = {
  id: string;
  category: string;
  brand: string | null;
  capacity: string | null;
  type: string | null;
  classification: string | null;
  rank: string | null;
  speed: string | null;
  interface: string | null;
  formFactor: string | null;
  description: string | null;
  partNumber: string | null;
  label: string;
  sub: string | null;
  target: number | null;
  low: number | null;
  high: number | null;
  avgSell: number;
  trend: number | null;
  samples: number | null;
  source: string | null;
  stock: number | null;
  demand: number | null;
  history: unknown;
  updatedAt: string;
  maxBuy: number;
  health: number | null;
  rpm: number | null;
};

export function formatRefPrice(r: MarketValueRow, targetMargin: number): MarketValue {
  return {
    id: r.id,
    category: r.category,
    brand: r.brand,
    capacity: r.capacity,
    type: r.type,
    classification: r.classification,
    rank: r.rank,
    speed: r.speed,
    interface: r.interface,
    formFactor: r.form_factor,
    description: r.description,
    partNumber: r.part_number,
    label: r.label,
    sub: r.sub_label,
    target: r.target,
    low: r.low_price,
    high: r.high_price,
    avgSell: r.avg_sell,
    trend: r.trend,
    samples: r.samples,
    source: r.source,
    stock: r.stock,
    demand: r.demand,
    history: r.history,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    maxBuy: +(r.avg_sell * (1 - targetMargin)).toFixed(2),
    health: r.health,
    rpm: r.rpm,
  };
}
```

- [ ] **Step 4 — Refactor `routes/market.ts` to use it**

In `apps/backend/src/routes/market.ts`, replace the inline `.map(r => ({ … }))` block with `rows.map(r => formatRefPrice(r, TARGET_MARGIN))`. Keep the response key as `items` for backwards compatibility.

- [ ] **Step 5 — Run all market tests; expect pass (existing + new)**

```bash
pnpm --filter recycle-erp-backend test tests/market 2>&1
```

- [ ] **Step 6 — Commit**

```bash
git add apps/backend/src/lib/market.ts apps/backend/src/routes/market.ts apps/backend/tests/market-format.test.ts
git commit -m "refactor(market): extract row→DTO formatter for reuse by MCP tools"
```

---

## Task 12: MCP server + read tools

**Why:** Wraps the formatter in two MCP tools and mounts them on `/api/mcp` behind `bearerGuard({ scopes: ['market:read'] })`.

**Files:**
- Create: `apps/backend/src/mcp/server.ts`
- Create: `apps/backend/src/mcp/tools/market.ts`
- Modify: `apps/backend/src/index.ts`
- Create: `apps/backend/tests/mcp-server.test.ts`

- [ ] **Step 1 — Write the failing tests**

`apps/backend/tests/mcp-server.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { createOAuthClient } from '../src/oauth/clients';
import { signAccessToken, generateSigningKey } from '../src/oauth/tokens';
import { api } from './helpers/app';

describe('MCP server /api/mcp', () => {
  let bearerRead: string;
  beforeAll(async () => {
    await resetDb();
    const key = await generateSigningKey();
    process.env.OAUTH_SIGNING_KEY_CURRENT = key;
    process.env.OAUTH_ISSUER_URL = 'http://localhost';
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const c = await createOAuthClient(sql, {
      name: 'mcp', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    bearerRead = await signAccessToken(process.env as any, {
      clientId: c.clientId, userId: null, scopes: ['market:read'],
    });
  });

  it('401 without bearer', async () => {
    const r = await api('POST', '/api/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      raw: true,
    });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/resource_metadata=/);
  });

  it('initialize returns expected serverInfo + capabilities', async () => {
    const r = await api('POST', '/api/mcp', {
      headers: { authorization: `Bearer ${bearerRead}` },
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
      raw: true,
    });
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.result.serverInfo.name).toBe('recycle-erp-market');
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it('tools/list returns list_market_values + get_market_value', async () => {
    const r = await api('POST', '/api/mcp', {
      headers: { authorization: `Bearer ${bearerRead}` },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      raw: true,
    });
    const names = (r.body as any).result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['get_market_value','list_market_values']);
  });

  it('tools/call list_market_values returns rows', async () => {
    const r = await api('POST', '/api/mcp', {
      headers: { authorization: `Bearer ${bearerRead}` },
      body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_market_values', arguments: { limit: 3 } } },
      raw: true,
    });
    const body = r.body as any;
    expect(body.result.isError).toBeFalsy();
    const text = body.result.content[0].text;
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    if (parsed.length > 0) {
      expect(typeof parsed[0].label).toBe('string');
      expect(typeof parsed[0].maxBuy).toBe('number');
    }
  });
});
```

- [ ] **Step 2 — Run; expect FAIL**

```bash
pnpm --filter recycle-erp-backend test tests/mcp-server.test.ts 2>&1
```

- [ ] **Step 3 — Implement tools**

`apps/backend/src/mcp/tools/market.ts`:

```ts
import type postgres from 'postgres';
import { formatRefPrice, type MarketValueRow } from '../../lib/market';
import { getWorkspaceSetting } from '../../lib/settings';

export const TOOL_DEFS = [
  {
    name: 'list_market_values',
    description: 'List current market-value records from ref_prices with optional category + substring filter.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        q: { type: 'string', description: 'substring match on label and part_number' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_market_value',
    description: 'Fetch one market-value record by id or partNumber.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        partNumber: { type: 'string' },
      },
      oneOf: [{ required: ['id'] }, { required: ['partNumber'] }],
      additionalProperties: false,
    },
  },
] as const;

export async function callListMarketValues(
  sql: postgres.Sql,
  args: { category?: string; q?: string; limit?: number },
) {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const q = args.q?.toLowerCase().trim();
  const rows = await sql<MarketValueRow[]>`
    SELECT id, category, brand, capacity, type, classification, rank, speed,
           interface, form_factor, description, part_number, label, sub_label,
           target::float AS target, low_price::float AS low_price,
           high_price::float AS high_price, avg_sell::float AS avg_sell,
           trend, samples, source, stock, demand, history, updated_at,
           health::float AS health, rpm
    FROM ref_prices
    WHERE (${args.category ?? null}::text IS NULL OR category = ${args.category ?? null})
      AND (
        ${q ?? null}::text IS NULL
        OR LOWER(label) LIKE '%' || ${q ?? ''} || '%'
        OR LOWER(COALESCE(part_number,'')) LIKE '%' || ${q ?? ''} || '%'
      )
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `;
  const margin = await getWorkspaceSetting(sql, 'target_margin', 0.30);
  return rows.map(r => formatRefPrice(r, margin));
}

export async function callGetMarketValue(
  sql: postgres.Sql,
  args: { id?: string; partNumber?: string },
) {
  if (!args.id && !args.partNumber) throw new Error('id or partNumber required');
  const rows = await sql<MarketValueRow[]>`
    SELECT id, category, brand, capacity, type, classification, rank, speed,
           interface, form_factor, description, part_number, label, sub_label,
           target::float AS target, low_price::float AS low_price,
           high_price::float AS high_price, avg_sell::float AS avg_sell,
           trend, samples, source, stock, demand, history, updated_at,
           health::float AS health, rpm
    FROM ref_prices
    WHERE (${args.id ?? null}::text IS NOT NULL AND id::text = ${args.id ?? null})
       OR (${args.partNumber ?? null}::text IS NOT NULL
           AND LOWER(COALESCE(part_number, '')) = LOWER(${args.partNumber ?? ''}))
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const margin = await getWorkspaceSetting(sql, 'target_margin', 0.30);
  return formatRefPrice(rows[0], margin);
}
```

`apps/backend/src/mcp/server.ts`:

```ts
// MCP HTTP adapter. We do not pull in the full Streamable HTTP transport from
// the SDK because we already speak HTTP through Hono — the protocol layer
// is JSON-RPC 2.0 on a single POST, which is trivial to handle directly.
// SSE upgrades (for server-initiated messages) are not used by the two read
// tools below; we accept GET as 405 for now.

import type { Context } from 'hono';
import { getDb } from '../db';
import { readPackageVersion } from '../lib/version';
import { TOOL_DEFS, callListMarketValues, callGetMarketValue } from './tools/market';
import type { Env } from '../types';

type JsonRpcReq = { jsonrpc: '2.0'; id: number | string; method: string; params?: Record<string, unknown> };

const SERVER_INFO = { name: 'recycle-erp-market', version: readPackageVersion() };
const CAPABILITIES = { tools: { listChanged: false } };

function rpcOk(id: number | string, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}
function rpcErr(id: number | string, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

export async function handleMcp(c: Context<{ Bindings: Env }>): Promise<Response> {
  let req: JsonRpcReq;
  try { req = await c.req.json() as JsonRpcReq; }
  catch { return c.json(rpcErr(0, -32700, 'parse error'), 400); }

  const sql = getDb(c.env);

  switch (req.method) {
    case 'initialize':
      return c.json(rpcOk(req.id, {
        protocolVersion: (req.params as any)?.protocolVersion ?? '2024-11-05',
        serverInfo: SERVER_INFO,
        capabilities: CAPABILITIES,
      }));
    case 'tools/list':
      return c.json(rpcOk(req.id, { tools: TOOL_DEFS }));
    case 'tools/call': {
      const { name, arguments: args = {} } = (req.params ?? {}) as { name?: string; arguments?: any };
      try {
        let payload: unknown;
        if (name === 'list_market_values') payload = await callListMarketValues(sql, args);
        else if (name === 'get_market_value') payload = await callGetMarketValue(sql, args);
        else return c.json(rpcErr(req.id, -32601, `unknown tool: ${name}`));
        return c.json(rpcOk(req.id, {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
        }));
      } catch (e) {
        return c.json(rpcErr(req.id, -32602, e instanceof Error ? e.message : 'invalid params'));
      }
    }
    default:
      return c.json(rpcErr(req.id, -32601, `unknown method: ${req.method}`));
  }
}
```

`apps/backend/src/lib/version.ts`:

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
  return pkg.version ?? '0.0.0';
}
```

- [ ] **Step 4 — Mount in index.ts**

```ts
import { handleMcp } from './mcp/server';
import { bearerGuard } from './oauth/guard';

app.use('/api/mcp', bearerGuard({ scopes: ['market:read'] }));
app.post('/api/mcp', (c) => handleMcp(c));
app.get('/api/mcp', (c) => c.json({ error: 'use POST for JSON-RPC' }, 405));
```

The MCP route must be excluded from `csrfGuard` (Bearer auth, no cookies). The existing `csrfGuard` skips safe methods + `/api/health` + `/api/public/*`; add `/api/mcp` and `/api/market/values` to that exempt set. Locate `csrfGuard` in `apps/backend/src/csrf.ts` and extend the exempt list explicitly.

- [ ] **Step 5 — Run mcp tests; expect pass**

```bash
pnpm --filter recycle-erp-backend test tests/mcp-server.test.ts 2>&1
```

- [ ] **Step 6 — Commit**

```bash
git add apps/backend/src/mcp apps/backend/src/lib/version.ts apps/backend/src/index.ts apps/backend/src/csrf.ts apps/backend/tests/mcp-server.test.ts
git commit -m "feat(mcp): JSON-RPC server with list_market_values + get_market_value behind bearerGuard"
```

---

## Task 13: Write endpoint POST /api/market/values

**Why:** The scraper push surface. Bearer-only (no cookie/CSRF). Per spec: batch ≤500, no upsert, atomic per request.

**Files:**
- Create: `apps/backend/src/lib/marketWrite.ts`
- Modify: `apps/backend/src/routes/market.ts`
- Modify: `apps/backend/src/index.ts`
- Create: `apps/backend/tests/market-write.test.ts`

- [ ] **Step 1 — Write the failing tests**

`apps/backend/tests/market-write.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { createOAuthClient } from '../src/oauth/clients';
import { signAccessToken, generateSigningKey } from '../src/oauth/tokens';
import { api } from './helpers/app';

describe('POST /api/market/values', () => {
  let writeBearer: string;
  let readBearer: string;
  let knownId: string;
  beforeAll(async () => {
    await resetDb();
    const key = await generateSigningKey();
    process.env.OAUTH_SIGNING_KEY_CURRENT = key;
    process.env.OAUTH_ISSUER_URL = 'http://localhost';
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const wc = await createOAuthClient(sql, {
      name: 'scraper', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['market:write'],
      createdBy: u, public: false,
    });
    const rc = await createOAuthClient(sql, {
      name: 'reader-only', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    writeBearer = await signAccessToken(process.env as any, {
      clientId: wc.clientId, userId: null, scopes: ['market:write'],
    });
    readBearer = await signAccessToken(process.env as any, {
      clientId: rc.clientId, userId: null, scopes: ['market:read'],
    });
    knownId = (await sql<{ id: string }[]>`SELECT id FROM ref_prices LIMIT 1`)[0].id;
  });

  it('401 without bearer', async () => {
    const r = await api('POST', '/api/market/values', { body: { values: [] } });
    expect(r.status).toBe(401);
  });

  it('403 with market:read-only bearer', async () => {
    const r = await api('POST', '/api/market/values', {
      headers: { authorization: `Bearer ${readBearer}` },
      body: { values: [] },
    });
    expect(r.status).toBe(403);
  });

  it('updates an existing row, appends history, recomputes trend', async () => {
    const sql = getTestDb();
    const before = (await sql<{ avg_sell: number; samples: number | null; history: unknown }[]>`
      SELECT avg_sell, samples, history FROM ref_prices WHERE id = ${knownId}
    `)[0];
    const r = await api('POST', '/api/market/values', {
      headers: { authorization: `Bearer ${writeBearer}` },
      body: {
        values: [{
          selector: { id: knownId },
          low: '100.00', high: '160.00', avgSell: '130.00',
          samples: 9, source: 'test-scraper',
        }],
      },
    });
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.updated).toBe(1);
    expect(body.notFound).toBe(0);
    expect(body.errors).toEqual([]);
    const after = (await sql<{ avg_sell: number; samples: number; trend: number | null; source: string; history: any }[]>`
      SELECT avg_sell, samples, trend, source, history FROM ref_prices WHERE id = ${knownId}
    `)[0];
    expect(after.avg_sell).toBe(130);
    expect(after.samples).toBe(9);
    expect(after.source).toBe('test-scraper');
    expect(Array.isArray(after.history)).toBe(true);
    expect(after.history.length).toBeGreaterThan((Array.isArray(before.history) ? before.history.length : 0));
  });

  it('reports notFound for unknown selectors', async () => {
    const r = await api('POST', '/api/market/values', {
      headers: { authorization: `Bearer ${writeBearer}` },
      body: {
        values: [{
          selector: { partNumber: 'NEVER-EXISTS-XYZ' },
          low: '1', high: '2', avgSell: '1.5', samples: 1, source: 'x',
        }],
      },
    });
    expect(r.status).toBe(200);
    expect((r.body as any).updated).toBe(0);
    expect((r.body as any).notFound).toBe(1);
  });

  it('records validation errors but processes other rows', async () => {
    const r = await api('POST', '/api/market/values', {
      headers: { authorization: `Bearer ${writeBearer}` },
      body: {
        values: [
          { selector: { id: knownId }, low: '5', high: '4', avgSell: '4.5', samples: 1, source: 'x' },
          { selector: { id: knownId }, low: '1', high: '2', avgSell: '1.5', samples: 1, source: 'y' },
        ],
      },
    });
    const body = r.body as any;
    expect(body.updated).toBe(1);
    expect(body.errors.length).toBe(1);
  });

  it('413 on >500 values', async () => {
    const values = Array.from({ length: 501 }, () => ({
      selector: { id: knownId },
      low: '1', high: '2', avgSell: '1.5', samples: 1, source: 'x',
    }));
    const r = await api('POST', '/api/market/values', {
      headers: { authorization: `Bearer ${writeBearer}` },
      body: { values },
    });
    expect(r.status).toBe(413);
  });
});
```

- [ ] **Step 2 — Run; expect FAIL**

```bash
pnpm --filter recycle-erp-backend test tests/market-write.test.ts 2>&1
```

- [ ] **Step 3 — Implement marketWrite + route**

`apps/backend/src/lib/marketWrite.ts`:

```ts
import type postgres from 'postgres';

export type WriteSelector = { id?: string; partNumber?: string };
export type WriteValue = {
  selector: WriteSelector;
  low: string;
  high: string;
  avgSell: string;
  samples: number;
  source: string;
};
export type WriteResult = {
  updated: number;
  notFound: number;
  errors: { selector: WriteSelector; error: string }[];
};

function parseNum(s: string): number | null {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export async function applyMarketWrites(
  sql: postgres.Sql,
  values: WriteValue[],
): Promise<WriteResult> {
  return sql.begin<WriteResult>(async (tx) => {
    const out: WriteResult = { updated: 0, notFound: 0, errors: [] };
    for (const v of values) {
      const low = parseNum(v.low), high = parseNum(v.high), avg = parseNum(v.avgSell);
      if (low === null || high === null || avg === null) {
        out.errors.push({ selector: v.selector, error: 'non-numeric low/high/avgSell' });
        continue;
      }
      if (low < 0 || high < 0 || avg < 0) {
        out.errors.push({ selector: v.selector, error: 'negative price' });
        continue;
      }
      if (!(low <= avg && avg <= high)) {
        out.errors.push({ selector: v.selector, error: 'low ≤ avgSell ≤ high required' });
        continue;
      }
      if (!Number.isInteger(v.samples) || v.samples < 0) {
        out.errors.push({ selector: v.selector, error: 'samples must be a non-negative integer' });
        continue;
      }
      const idRow = (await tx<{ id: string; prev_avg: number | null; history: unknown }[]>`
        SELECT id, avg_sell AS prev_avg, history
        FROM ref_prices
        WHERE (${v.selector.id ?? null}::text IS NOT NULL AND id::text = ${v.selector.id ?? null})
           OR (${v.selector.partNumber ?? null}::text IS NOT NULL
               AND LOWER(COALESCE(part_number,'')) = LOWER(${v.selector.partNumber ?? ''}))
        LIMIT 1
      `)[0];
      if (!idRow) { out.notFound++; continue; }
      const trend = idRow.prev_avg === null ? null : +(avg - idRow.prev_avg).toFixed(2);
      const newPoint = { ts: new Date().toISOString(), avg };
      await tx`
        UPDATE ref_prices SET
          low_price = ${low},
          high_price = ${high},
          avg_sell = ${avg},
          samples = ${v.samples},
          source = ${v.source},
          trend = ${trend},
          history = COALESCE(history, '[]'::jsonb) || ${JSON.stringify([newPoint])}::jsonb,
          updated_at = NOW()
        WHERE id = ${idRow.id}
      `;
      out.updated++;
    }
    return out;
  });
}
```

In `apps/backend/src/routes/market.ts`, add:

```ts
import { applyMarketWrites, type WriteValue } from '../lib/marketWrite';
import { bearerGuard } from '../oauth/guard';

market.post('/values', bearerGuard({ scopes: ['market:write'] }), async (c) => {
  const body = (await c.req.json().catch(() => null)) as null | { values?: WriteValue[] };
  if (!body || !Array.isArray(body.values)) return c.json({ error: 'invalid_request' }, 400);
  if (body.values.length > 500) {
    return c.json({ error: 'payload_too_large', hint: 'paginate to ≤500 rows' }, 413);
  }
  const sql = getDb(c.env);
  const result = await applyMarketWrites(sql, body.values);
  return c.json(result);
});
```

Important: the existing `app.use('/api/market/*', authMiddleware)` line in `index.ts` would intercept the bearer route. Adjust by moving the bearer guard inside the route (already done via `bearerGuard` arg above) AND skipping `authMiddleware` for `/api/market/values` explicitly:

In `apps/backend/src/index.ts`, replace:

```ts
app.use('/api/market/*', authMiddleware);
```

with:

```ts
app.use('/api/market/*', async (c, next) => {
  if (c.req.path === '/api/market/values') return next();
  return authMiddleware(c, next);
});
```

- [ ] **Step 4 — Run all tests in tests/market*; expect PASS**

```bash
pnpm --filter recycle-erp-backend test tests/market 2>&1
```

- [ ] **Step 5 — Commit**

```bash
git add apps/backend/src/lib/marketWrite.ts apps/backend/src/routes/market.ts apps/backend/src/index.ts apps/backend/tests/market-write.test.ts
git commit -m "feat(market): POST /api/market/values write endpoint (bearer market:write)"
```

---

## Task 14: Consent screen (frontend)

**Why:** The redirect target from `/oauth/authorize` lands on `/authorize?req=<handle>`. The page fetches the pending request, shows client name + scopes, and on approve calls `POST /api/oauth/authorize/consent`.

**Note on routing:** the existing OAuth endpoint is at `/oauth/authorize/consent`. From the SPA's perspective, that's a same-origin POST. CSRF middleware applies, so the SPA must send `X-Requested-By: recycle-erp` via the existing `apps/frontend/src/lib/api.ts` helper. The pending-request GET (`/oauth/authorize/pending/:req`) is cookie-authed (via `authMiddleware`) — also fine because the SPA carries the `at` cookie.

**Files:**
- Create: `apps/frontend/src/pages/Authorize.tsx`
- Modify: `apps/frontend/src/DesktopApp.tsx`
- Modify: `apps/frontend/src/lib/route.ts` (add `'authorize'` to the route union)

- [ ] **Step 1 — Add route**

Find the route discriminant in `apps/frontend/src/lib/route.ts`. Add `'authorize'` to the view union; map `/authorize` → that view in `parseRoute`. Verify the existing patterns by looking at how `'login'` is wired.

- [ ] **Step 2 — Create the consent component**

`apps/frontend/src/pages/Authorize.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../lib/api';

type Pending = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  state: string | null;
};

export function Authorize() {
  const params = new URLSearchParams(window.location.search);
  const req = params.get('req') ?? '';
  const [pending, setPending] = useState<Pending | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!req) { setErr('Missing request handle'); return; }
    apiGet(`/api/oauth/authorize/pending/${req}`)
      .then((p) => setPending(p as Pending))
      .catch((e: Error) => setErr(e.message));
  }, [req]);

  async function approve() {
    if (!pending) return;
    setBusy(true);
    try {
      // The /oauth/authorize/consent endpoint 302s to the redirect URI.
      // We let the browser follow that natively by navigating to a form-submit
      // (fetch follows redirects to JSON responses, not cross-origin URLs).
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/oauth/authorize/consent';
      const fields: Record<string, string> = {
        client_id: pending.clientId,
        redirect_uri: pending.redirectUri,
        scope: pending.scopes.join(' '),
        state: pending.state ?? '',
        code_challenge: pending.codeChallenge,
        code_challenge_method: 'S256',
      };
      // CSRF header isn't possible via classic form POST — use the JSON path:
      const res = await apiPost('/api/oauth/authorize/consent', fields, { followRedirect: false });
      const loc = res.headers.get('location');
      if (loc) window.location.href = loc;
      else setErr('Unexpected response from consent endpoint');
    } finally {
      setBusy(false);
    }
  }

  if (err) return <div className="p-8 max-w-md mx-auto text-red-600">{err}</div>;
  if (!pending) return <div className="p-8 max-w-md mx-auto">Loading…</div>;
  return (
    <div className="p-8 max-w-md mx-auto">
      <h1 className="text-xl font-semibold mb-2">Authorize {pending.clientName}</h1>
      <p className="text-sm text-gray-600 mb-4">This app is requesting access to:</p>
      <ul className="list-disc pl-5 mb-6">
        {pending.scopes.map(s => <li key={s} className="font-mono text-sm">{s}</li>)}
      </ul>
      <button
        className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50"
        onClick={approve}
        disabled={busy}
      >Approve</button>
    </div>
  );
}
```

The `apiPost` helper used above needs to support `followRedirect: false` and return the raw response. Inspect `apps/frontend/src/lib/api.ts` and either extend the existing signature or add a sibling helper `apiPostRaw(path, body)` that returns the `Response` object. Implementing-agent: pick whichever pattern matches the existing code style.

- [ ] **Step 3 — Wire the route in DesktopApp.tsx**

Locate the existing view switch (search for `<DesktopSettings`). Add:

```tsx
{view2 === 'authorize' && <Authorize />}
```

…and add the lazy import at the top: `import { Authorize } from './pages/Authorize';`. If the project's other pages use lazy imports, follow that pattern (`React.lazy(...)`); otherwise eager is fine.

- [ ] **Step 4 — Manual smoke test**

Run dev server and check that visiting `/authorize?req=missing` shows the error path.

```bash
pnpm dev
# (in another shell): curl -i http://localhost:5173/authorize?req=missing | head
```

- [ ] **Step 5 — Frontend typecheck + tests**

```bash
pnpm --filter recycle-erp-frontend typecheck
pnpm --filter recycle-erp-frontend test 2>&1
```

- [ ] **Step 6 — Commit**

```bash
git add apps/frontend/src/pages/Authorize.tsx apps/frontend/src/DesktopApp.tsx apps/frontend/src/lib/route.ts apps/frontend/src/lib/api.ts
git commit -m "feat(frontend): OAuth consent screen at /authorize"
```

---

## Task 15: Settings > Connectors tab

**Why:** Lets managers list and revoke registered OAuth clients, and create new service clients for the scraper. List uses an existing manager-only `/api/oauth/clients` endpoint (to be added in this task).

**Files:**
- Modify: `apps/backend/src/oauth/server.ts` — add `/clients` admin endpoints (cookie-authed, manager-only).
- Create: `apps/frontend/src/pages/desktop/DesktopSettingsConnectors.tsx`
- Modify: `apps/frontend/src/pages/desktop/DesktopSettings.tsx`

- [ ] **Step 1 — Add admin endpoints**

In `apps/backend/src/oauth/server.ts`, add a sub-app for admin under `/clients`, mounted via cookie auth + manager-role check:

```ts
import { authMiddleware } from '../auth';
import { listOAuthClients, createOAuthClient, revokeOAuthClient } from './clients';

export const oauthAdmin = new Hono<{ Bindings: Env; Variables: { user: User } }>()
  .use('*', authMiddleware)
  .use('*', async (c, next) => {
    if (c.var.user.role !== 'manager') return c.json({ error: 'forbidden' }, 403);
    return next();
  })
  .get('/', async (c) => {
    const rows = await listOAuthClients(getDb(c.env));
    return c.json({
      clients: rows.map(r => ({
        id: r.id, name: r.name, scopes: r.scopes, grantTypes: r.grant_types,
        redirectUris: r.redirect_uris, createdAt: r.created_at,
      })),
    });
  })
  .post('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as null | {
      name?: string; redirectUris?: string[]; grantTypes?: string[]; scopes?: string[]; public?: boolean;
    };
    if (!body?.name) return c.json({ error: 'name required' }, 400);
    const out = await createOAuthClient(getDb(c.env), {
      name: body.name,
      redirectUris: body.redirectUris ?? [],
      grantTypes: body.grantTypes ?? ['client_credentials'],
      scopes: body.scopes ?? ['market:read'],
      createdBy: c.var.user.id,
      public: body.public ?? false,
    });
    return c.json(out, 201);
  })
  .delete('/:id', async (c) => {
    await revokeOAuthClient(getDb(c.env), c.req.param('id'));
    return c.json({ ok: true });
  });
```

Mount in `index.ts`:

```ts
import oauthRoutes, { wellKnown, oauthAdmin } from './oauth/server';
app.route('/api/oauth/clients', oauthAdmin);
```

Add tests in `apps/backend/tests/oauth-endpoints.test.ts`:

```ts
describe('/api/oauth/clients (admin)', () => {
  it('403 for non-managers, 200 + list for managers, 201 on POST, 200 on DELETE', async () => {
    // Use loginAs(ALEX) for the manager (verify ALEX is manager in fixtures —
    // if not, pick the manager user from the existing test helpers).
  });
});
```

(Implement fully — do not abbreviate.)

- [ ] **Step 2 — Frontend Connectors panel**

`apps/frontend/src/pages/desktop/DesktopSettingsConnectors.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { apiGet, apiPost, apiDelete } from '../../lib/api';

type Client = {
  id: string; name: string; scopes: string[]; grantTypes: string[];
  redirectUris: string[]; createdAt: string;
};

export function DesktopSettingsConnectors() {
  const [clients, setClients] = useState<Client[] | null>(null);
  const [newName, setNewName] = useState('');
  const [newSecret, setNewSecret] = useState<string | null>(null);

  async function load() {
    const r = await apiGet<{ clients: Client[] }>('/api/oauth/clients');
    setClients(r.clients);
  }
  useEffect(() => { load(); }, []);

  async function createServiceClient() {
    if (!newName.trim()) return;
    const r = await apiPost<{ clientId: string; clientSecret: string }>(
      '/api/oauth/clients',
      {
        name: newName.trim(),
        grantTypes: ['client_credentials'],
        scopes: ['market:write'],
        public: false,
      },
    );
    setNewSecret(r.clientSecret);
    setNewName('');
    load();
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this connector? Any access tokens issued to it will stop working when they expire.')) return;
    await apiDelete(`/api/oauth/clients/${id}`);
    load();
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-lg font-semibold mb-2">Add a service client (scraper)</h2>
        <div className="flex gap-2">
          <input
            className="border rounded px-2 py-1 flex-1"
            placeholder="e.g. ebay-scraper-prod"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button onClick={createServiceClient} className="px-3 py-1 bg-blue-600 text-white rounded">Create</button>
        </div>
        {newSecret && (
          <div className="mt-3 p-3 bg-yellow-50 border border-yellow-300 rounded text-sm">
            <div className="font-medium">Client secret (shown ONCE — copy now):</div>
            <code className="block break-all">{newSecret}</code>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">Connectors</h2>
        <table className="w-full text-sm">
          <thead><tr><th align="left">Name</th><th align="left">Scopes</th><th align="left">Grants</th><th align="left">Created</th><th /></tr></thead>
          <tbody>
            {clients?.map(c => (
              <tr key={c.id} className="border-t">
                <td className="py-1">{c.name}</td>
                <td className="font-mono">{c.scopes.join(' ')}</td>
                <td className="font-mono">{c.grantTypes.join(' ')}</td>
                <td>{new Date(c.createdAt).toLocaleString()}</td>
                <td><button onClick={() => revoke(c.id)} className="text-red-600">Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

- [ ] **Step 3 — Wire into DesktopSettings**

Open `apps/frontend/src/pages/desktop/DesktopSettings.tsx`. Add a tab labelled "Connectors" (English) / "连接器" (Chinese — use `useT()` like the existing labels), and render `<DesktopSettingsConnectors />` when that tab is active. Follow the existing tab-state pattern in that file verbatim.

- [ ] **Step 4 — Typecheck + tests**

```bash
pnpm --filter recycle-erp-backend test tests/oauth-endpoints.test.ts 2>&1
pnpm --filter recycle-erp-frontend typecheck
```

- [ ] **Step 5 — Commit**

```bash
git add apps/backend/src/oauth/server.ts apps/backend/src/index.ts apps/backend/tests/oauth-endpoints.test.ts apps/frontend/src/pages/desktop/DesktopSettingsConnectors.tsx apps/frontend/src/pages/desktop/DesktopSettings.tsx
git commit -m "feat(settings): Connectors tab — list, create service clients, revoke"
```

---

## Task 16: README docs + .env.example sanity + full-suite green

**Why:** Final integration: documentation for connector setup + a single full-suite run to catch any interaction regressions.

**Files:**
- Modify: `README.md`
- Verify: `.env.example` matches what compose passes through (already done in Task 1, double-check).

- [ ] **Step 1 — Add README section**

Append to `README.md` (after the existing API section):

````markdown
## Market-value MCP

External LLM agents (Claude Code, Claude.ai connectors, etc.) can read
the market-value table at `/api/mcp` using OAuth 2.1 Bearer tokens. The
read scope is `market:read`. The write counterpart is the scraper push
endpoint `POST /api/market/values` (`market:write`).

### Set up a Claude Code MCP connector

1. **Settings → Connectors → Add a service client.** Pick a name; copy the
   client secret on the one-time screen.
2. Add to `~/.config/claude-code/mcp.json` (or your platform's equivalent):

   ```json
   {
     "mcpServers": {
       "recycle-erp-market": {
         "url": "http://localhost:8787/api/mcp",
         "auth": {
           "type": "oauth2",
           "discoveryUrl": "http://localhost:8787/.well-known/oauth-authorization-server",
           "clientId": "<paste from Settings>",
           "clientSecret": "<paste from Settings>",
           "scope": "market:read"
         }
       }
     }
   }
   ```

### Scraper push

```sh
curl -X POST http://localhost:8787/api/market/values \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"values":[{"selector":{"partNumber":"M393A4K40DB2-CWE"},
        "low":"120","high":"180","avgSell":"145","samples":12,
        "source":"ebay-sold-30d"}]}'
```

### Generate the OAuth signing key

```sh
node -e "import('jose').then(async j => {
  const {privateKey} = await j.generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const pem = await j.exportPKCS8(privateKey);
  process.stdout.write(Buffer.from(pem).toString('base64'));
})"
```

Paste the output into `.env` as `OAUTH_SIGNING_KEY_CURRENT`. To rotate
without breaking outstanding access tokens, move the current key to
`OAUTH_SIGNING_KEY_PREVIOUS` first, then write a new value to
`OAUTH_SIGNING_KEY_CURRENT`.
````

- [ ] **Step 2 — Full test run**

```bash
pnpm --filter recycle-erp-backend test 2>&1 | tail -30
pnpm --filter recycle-erp-frontend test 2>&1 | tail -10
pnpm -r typecheck
```

Expected: all green.

- [ ] **Step 3 — Commit**

```bash
git add README.md
git commit -m "docs: market-value MCP setup + scraper push usage"
```

---

## Self-review

**Spec coverage:**
- §Architecture → file map + tasks 2, 6, 12, 13.
- §OAuth tables → task 2 (with `oauth_pending_consent` added during task 8).
- §Tokens (Ed25519 + key ring) → task 5.
- §Scopes (closed set) → enforced in clients (task 3), guard (task 10), tools (task 12), write endpoint (task 13).
- §Endpoints (discovery, register, authorize, consent, token, revoke) → tasks 6, 7, 8, 9, 10.
- §Flows (auth_code+PKCE + client_credentials) → tasks 8, 9.
- §bearerGuard → task 10.
- §Settings UI Connectors → task 15.
- §MCP transport (Streamable HTTP) — design called for SDK's Streamable HTTP; task 12 implements JSON-RPC directly over Hono POST and returns 405 on GET (no SSE upgrade in v1 since no server-initiated messages exist for these two tools). This is a controlled simplification documented in the code comment; revisit if a future tool emits notifications.
- §MCP tools list_market_values, get_market_value → task 12.
- §`MarketValue` shape → task 11 (formatter pin), reused by task 12.
- §Write endpoint → task 13.
- §Cap of 500, no Idempotency-Key, audit via source/cid → task 13.
- §Observability counters — NOT in any task. **Add a follow-up task** if needed; deferred from v1 to keep scope. Marking as a known gap.
- §Env vars → task 1.
- §Tests (OAuth, MCP, write) → tasks 2, 3, 5, 6, 7, 8, 9, 10, 12, 13.
- §Rollout order → matches task order.

**Known gap:** prom-client counters from §Observability are not implemented. They're additive and can land in a follow-up; the spec calls them out but no behavior depends on them.

**Placeholder scan:** Three tests in task 9 ("rejects code reuse", "rejects wrong code_verifier", "refresh_token grant rotates"), one in task 10 ("revokes a refresh token family"), and one in task 15 ("403 for non-managers …") are described with the setup pattern but not fully spelled out. The implementing agent must replicate the full happy-path setup from the same test file (no abbreviation). Flagged inline.

**Type consistency:** `MarketValue` (`lib/market.ts`), `OAuthCtx` / `OAuthScope` (`types.ts`), `AccessClaims` (`oauth/tokens.ts`), `WriteValue`/`WriteSelector`/`WriteResult` (`lib/marketWrite.ts`), `OAuthClientRow` (`oauth/clients.ts`) — all unique names, no collisions, consistent between definition site and consumer.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-22-market-value-mcp.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
