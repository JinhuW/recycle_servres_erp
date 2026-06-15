# Connector scopes: checkbox multi-select

**Date:** 2026-06-15
**Status:** Approved, pending implementation

## Problem

The Settings → Connectors tab mints OAuth `client_credentials` service clients
(`DesktopSettingsConnectors.tsx`). Scope selection is a **single-select
dropdown** offering two hard-coded bundles:

- `market` → `['market:write']`
- `sellorder` → `['sellorder:read', 'sellorder:write']`

A manager cannot mint one client that holds, say, `market:read` +
`sellorder:write`, even though the backend already supports arbitrary scope
combinations. The dropdown is the only limiter.

## Goal

Replace the single-select dropdown with a **checkbox group** that exposes the
four grantable scopes individually and allows any combination (multi-select).

## Scope set (authoritative — backend `VALID_SCOPES`)

`oauth/server.ts:506` and `oauth/metadata.ts:8` define exactly four:

| Scope             | Friendly label              |
|-------------------|-----------------------------|
| `market:read`     | Read market prices          |
| `market:write`    | Write market prices         |
| `sellorder:read`  | Search sellable inventory   |
| `sellorder:write` | Create sell-order drafts    |

## Frontend changes — `DesktopSettingsConnectors.tsx`

1. **State:** replace
   `const [newScope, setNewScope] = useState<'market' | 'sellorder'>('market')`
   with `const [newScopes, setNewScopes] = useState<string[]>(['market:read'])`.
   Default `market:read` checked (safe read-only default).

2. **UI:** replace the `<select>` (lines ~179–188) with a checkbox group — one
   labeled checkbox per scope, rendered from a local ordered constant so label
   order is stable. Toggling adds/removes the scope from `newScopes`.

3. **Submit:** send `scopes: newScopes` directly (drop the
   `newScope === 'sellorder' ? … : …` ternary at line ~65).

4. **Validation:** disable the **Create** button when `newScopes.length === 0`
   (in addition to the existing name-required guard). The backend defaults an
   empty array to `['market:read']`, but the UI must not allow a no-scope
   submit.

## i18n — `lib/i18n.tsx`

Replace the two bundle keys (`connectorsScopeMarket`, `connectorsScopeSellOrder`)
with four granular label keys plus a group heading, in **both EN and ZH** (parity
convention):

- `connectorsScopeMarketRead`     — "Read market prices" / "读取市场价格"
- `connectorsScopeMarketWrite`    — "Write market prices" / "写入市场价格"
- `connectorsScopeSellOrderRead`  — "Search sellable inventory" / "搜索可售库存"
- `connectorsScopeSellOrderWrite` — "Create sell-order drafts" / "创建销售订单草稿"
- `connectorsScopesHeading`       — "Scopes" / "权限范围"

(Final ZH wording to match existing tone; placeholders above.)

## Backend — no logic change, add a regression test

The backend already handles multi-scope clients end-to-end:

- **Create** (`POST /api/oauth/clients`, `server.ts:537`): accepts
  `scopes: string[]`, validates each element against `VALID_SCOPES`, persists the
  full array (`clients.ts:44`, Postgres `text[]`).
- **Grant** (`client_credentials`, `server.ts:415`): consumer requests a
  space-separated `scope`; each must be a subset of `client.scopes`; the issued
  access token carries **all** requested scopes.
- **MCP `tools/list`** filters tools by the per-tool scope map
  (`mcp/server.ts:26-30`) against the token's scopes — multiple scopes unlock
  multiple tools.

To lock this so it can't silently regress, add a backend integration test
(extend `apps/backend/tests/oauth-clients.test.ts` rather than a new file):

1. Mint a client with `['market:read', 'market:write', 'sellorder:write']` via
   `POST /api/oauth/clients`; assert the persisted client carries all three.
2. Exercise the `client_credentials` token grant requesting all three; assert the
   returned `scope` string and the JWT `scopes` claim contain all three.
3. Assert a grant request for a scope the client does **not** hold returns
   `invalid_scope`.

## Testing

- **Backend:** the integration test above
  (`cd apps/backend && npx vitest run tests/oauth-clients.test.ts`).
- **Frontend:** UI behavior; verify by visiting Settings → Connectors and minting
  a client with multiple boxes checked, confirming the new client row lists all
  selected scopes. No new pure helper to unit-test.

## Out of scope

- No change to the OAuth interactive consent flow (`Authorize.tsx`) — the
  `market:write` manager-gating there is unaffected; this surface is already
  manager-only.
- No new scopes; the four-scope set is unchanged.
