# Sell-Order-Draft MCP Service — Design

**Date:** 2026-06-08
**Status:** Proposed (awaiting spec review)
**Scope:** Add a dedicated MCP capability for creating sell-order **drafts**,
gated by new `sellorder:read` / `sellorder:write` OAuth scopes, on the existing
`/api/mcp` JSON-RPC endpoint.

## Goal

Let an authorized MCP client (e.g. an AI agent) create sell-order **drafts**
end-to-end: discover sellable stock, then create a `Draft` sell order whose
lines reference that stock. The capability is isolated behind dedicated scopes
so a token granted only `sellorder:*` cannot touch the existing market tools,
and vice-versa.

Non-goals: editing/advancing sell orders, status transitions, shipping,
invoicing, customer management. Drafts are created for later human review.

## Context (existing code)

- **MCP endpoint:** `POST /api/mcp` (JSON-RPC 2.0 over HTTP), mounted in
  `apps/backend/src/index.ts:171-174`. Base-gated today by
  `bearerGuard({ scopes: ['market:read'] })`.
- **MCP handler:** `apps/backend/src/mcp/server.ts` — `initialize`,
  `tools/list`, `tools/call`. Per-tool scope check already used for
  `set_market_price` (`mcp/server.ts:51-64`).
- **Tool defs:** `apps/backend/src/mcp/tools/market.ts` (`TOOL_DEFS`).
- **Scopes:** `apps/backend/src/oauth/metadata.ts:8`
  (`SCOPES = ['market:read','market:write']`).
- **Authorize gating:** non-managers have write scopes stripped via
  `dropWriteUnlessManager` in `apps/backend/src/oauth/server.ts:143`.
- **Sell-order create:** `POST /api/sell-orders` in
  `apps/backend/src/routes/sellOrders.ts:377-474` (manager-only). Flow:
  resolve FX → `sql.begin` → `validateSellLines` (FOR UPDATE) →
  `nextHumanId('SO','SO')` → insert `sell_orders` (`status='Draft'`) +
  `sell_order_lines` → `writeSellOrderEvent('created', …)`.
- **Sellability predicate:** `validateSellLines` (`sellOrders.ts:44-77`) —
  inventory line exists, status in (`Reviewing`,`Done`), qty available, not
  consumed by another open sell order.
- **OAuth context** available to tools: `c.get('oauthCtx')` →
  `{ clientId, userId, scopes, jti }` (`types.ts:101-106`).
- **Default MCP customer (already seeded):** id
  `f30f98bc-09c7-4108-b083-c7d69cc9968c`, name `MCP`.

## Architecture

### Scopes

Add two scopes to `SCOPES` in `oauth/metadata.ts`:

- `sellorder:read` — discover sellable inventory.
- `sellorder:write` — create a sell-order draft.

Mirrors the existing `market:read` / `market:write` split. `sellorder:write`
is manager-gated in `/oauth/authorize` (extend `dropWriteUnlessManager` to drop
`sellorder:write` for non-managers, exactly as it drops `market:write`).
`sellorder:read` is grantable to any consented user and to
client-credentials clients.

### Endpoint guard (refactor, behavior-preserving for market)

The mount guard requires only a **valid bearer token** (verified
signature/issuer/audience), not a specific scope. Scope enforcement moves into
per-tool dispatch:

- `list_market_values` → requires `market:read`
- `set_market_price` → requires `market:write` (already checks this)
- `search_sellable_inventory` → requires `sellorder:read`
- `create_sell_order_draft` → requires `sellorder:write`

This lets a token bearing only `sellorder:*` reach the endpoint. A token with
no recognized scope, or missing the specific tool's scope, gets
`-32001 insufficient_scope`.

`tools/list` **filters by the caller's granted scopes** — a `sellorder:*`-only
token sees only the two sell-order tools; a `market:*`-only token sees only the
market tools. This is what isolates the "service" without adding a second HTTP
route.

### Tools

#### `search_sellable_inventory` — scope `sellorder:read`

Input schema:
```jsonc
{
  "type": "object",
  "properties": {
    "query":       { "type": "string",  "description": "Match label / part number / category (case-insensitive)" },
    "warehouseId": { "type": "string",  "description": "Optional warehouse filter" },
    "limit":       { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 }
  },
  "additionalProperties": false
}
```

Returns an array of currently-sellable stock lines:
```jsonc
[{
  "inventoryId":   "<order_lines.id>",
  "category":      "SSD",
  "label":         "…",
  "subLabel":      "…|null",
  "partNumber":    "…|null",
  "condition":     "…|null",
  "warehouseId":   "…|null",
  "warehouseName": "…|null",
  "availableQty":  3,
  "referencePrice": 42.00   // market last_price by part number, if any; advisory only
}]
```

"Sellable" uses the **same predicate** as `validateSellLines`: `order_lines`
with status in (`Reviewing`,`Done`) and `availableQty > 0` after subtracting qty
already committed to open (non-closed/non-archived) sell orders — so the agent
can never surface a line that `create_sell_order_draft` will then reject.
`referencePrice` is purely advisory; the agent still sets each line's price.

#### `create_sell_order_draft` — scope `sellorder:write`

Input schema:
```jsonc
{
  "type": "object",
  "properties": {
    "customerId": { "type": "string", "description": "Defaults to the MCP customer if omitted" },
    "currency":   { "type": "string", "enum": ["USD","CNY"], "default": "USD" },
    "notes":      { "type": "string", "maxLength": 2000 },
    "lines": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "properties": {
          "inventoryId": { "type": "string" },
          "qty":         { "type": "integer", "minimum": 1 },
          "unitPrice":   { "type": "number",  "minimum": 0, "description": "In `currency`" }
        },
        "required": ["inventoryId","qty","unitPrice"],
        "additionalProperties": false
      }
    }
  },
  "required": ["lines"],
  "additionalProperties": false
}
```

- Every line **must** reference real sellable stock via `inventoryId`
  (schema-required). Free-form lines are rejected by this tool even though the
  underlying route permits them.
- `category` / `label` / `subLabel` / `partNumber` / `condition` /
  `warehouseId` are **derived server-side** from the referenced inventory line —
  the agent cannot forge descriptive fields.
- `customerId` defaults to the MCP customer (see below).

Returns:
```jsonc
{ "id": "SO-4001", "status": "Draft", "customerId": "…", "lineCount": 2, "currency": "USD" }
```

### Shared service (no parallel logic)

Extract the transactional core of `POST /api/sell-orders`
(`sellOrders.ts:377-474`) into
`apps/backend/src/services/sellOrderCreate.ts`:

```ts
createSellOrderDraft(tx, input, ctx): Promise<{ id: string; customerId: string; lineCount: number; currency: string }>
```

Flow (unchanged): resolve FX (before tx) → `validateSellLines` →
`nextHumanId('SO','SO')` → insert `sell_orders` (`status='Draft'`) +
`sell_order_lines` → `writeSellOrderEvent('created', { source, … })`.

- The HTTP route calls it (keeping its **manager role-check**).
- The MCP `create_sell_order_draft` handler calls it (keeping its
  **scope-check**).
- Audit `source` = `mcp:<clientId>` for MCP-created drafts vs `manager` for the
  route, so the two origins are distinguishable in `sell_order_events`.

The service keeps `inventoryId` **optional** in its line type (the route still
allows free-form lines); only the MCP tool's input schema requires it. This
preserves route behavior exactly while letting the MCP tool be stricter.

For inventory-linked MCP lines, the service derives descriptive columns
(`category`/`label`/etc.) from the referenced `order_lines` row rather than
trusting caller-supplied values.

### Default customer

Drafts default to the MCP customer
(`f30f98bc-09c7-4108-b083-c7d69cc9968c`). Stored as a backend setting
`mcp.sellOrderCustomerId` (default = that UUID) via `lib/settings.ts` so it is
reconfigurable without a code change; `create_sell_order_draft` accepts an
optional `customerId` to override per-call.

## Error handling

- Missing/invalid bearer token → endpoint guard returns 401.
- Valid token, wrong/absent tool scope → `-32001 insufficient_scope: <scope> required`.
- Unknown `inventoryId`, non-sellable stock, or oversell → `validateSellLines`
  error surfaced as `-32602` with its message (same wording as the route).
- Unknown/invalid `customerId` override → `-32602`.
- All writes inside a single `sql.begin`; any failure rolls back the whole draft.

## Testing (integration, real Postgres)

Mirror existing MCP + sell-order test style (`pool: 'forks'`,
`fileParallelism: false`):

1. **Scope enforcement:** no-scope token → 403/`insufficient_scope`;
   `sellorder:read`-only token can search but not create; `sellorder:write`
   token can create.
2. **`tools/list` filtering:** `sellorder:*` token sees only the two
   sell-order tools; market token unchanged.
3. **`search_sellable_inventory`:** excludes non-`Reviewing`/`Done` stock and
   stock already committed to an open sell order; respects `query`/`warehouse`/
   `limit`; surfaces `referencePrice` when a market price exists.
4. **`create_sell_order_draft` happy path:** creates `Draft` header + lines +
   `created` event with `source: mcp:*`; descriptive columns derived from the
   inventory line; returns `SO-####`.
5. **Rejections:** bad `inventoryId`, oversell, non-manager consent cannot get
   `sellorder:write`.
6. **Regression:** existing market MCP tests stay green after the base-guard
   refactor.

## Decisions locked during brainstorming

- Customer: **default to the MCP customer**, override allowed.
- Lines: **inventory-linked only** for the MCP tool (every line needs a valid
  `inventoryId`).
- Scopes: **`sellorder:read` + `sellorder:write`** (two scopes, mirroring
  market).
- Endpoint: **one shared `/api/mcp`** with relaxed base guard + per-tool scope
  enforcement + `tools/list` scope-filtering (no second HTTP route).

## Open points for spec review

- Default-customer-as-setting vs hardcoded constant (proposed: setting).
- Whether `referencePrice` in search results is worth the extra market lookup
  (proposed: include, advisory).
