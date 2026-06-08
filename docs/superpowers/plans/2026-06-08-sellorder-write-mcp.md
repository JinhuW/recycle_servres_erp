# Sell-Order-Draft MCP Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated MCP capability for creating sell-order **drafts** — two tools (`search_sellable_inventory`, `create_sell_order_draft`) gated by new `sellorder:read` / `sellorder:write` OAuth scopes — on the existing `/api/mcp` JSON-RPC endpoint.

**Architecture:** Add two scopes mirroring the `market:read`/`market:write` split. Relax the `/api/mcp` mount guard to require only a valid bearer token and move scope enforcement into a per-tool scope map (which also drives `tools/list` filtering, so a `sellorder:*` token sees only the sell-order tools). The create tool reuses a shared `createSellOrderDraft` service extracted from `POST /api/sell-orders` (no parallel logic). Drafts default to a seeded "MCP" customer. Descriptive line fields (label/sub-label/part-number/warehouse/condition) are derived server-side from the referenced inventory line — the agent supplies only `inventoryId`, `qty`, `unitPrice`.

**Tech Stack:** Hono + `@hono/node-server`, postgres.js (`sql.begin` transactions), JSON-RPC 2.0 over HTTP, Vitest integration tests against real Postgres. Spec: `docs/superpowers/specs/2026-06-08-sellorder-write-mcp-design.md`.

---

## File Structure

**Backend — create:**
- `apps/backend/migrations/0067_mcp_sell_order_customer.sql` — seed the MCP customer + `mcp.sellOrderCustomerId` setting.
- `apps/backend/src/lib/inventoryLabel.ts` — server-side mirror of the desktop `itemLabel`/`itemSpec` label derivation.
- `apps/backend/src/services/sellOrderCreate.ts` — shared `createSellOrderDraft` + the moved `validateSellLines`.
- `apps/backend/src/mcp/tools/sellOrders.ts` — tool defs + `callSearchSellableInventory` + `callCreateSellOrderDraft`.
- `apps/backend/tests/inventoryLabel.test.ts`, `apps/backend/tests/mcp-sell-orders.test.ts`.

**Backend — modify:**
- `apps/backend/src/types.ts` — extend `OAuthScope`.
- `apps/backend/src/oauth/metadata.ts` — extend `SCOPES`.
- `apps/backend/src/oauth/server.ts` — `KNOWN_SCOPES`, `dropWriteUnlessManager`, admin `VALID_SCOPES`.
- `apps/backend/src/index.ts` — relax `/api/mcp` mount guard.
- `apps/backend/src/mcp/server.ts` — scope-map dispatch + `tools/list` filtering.
- `apps/backend/src/routes/sellOrders.ts` — import the moved `validateSellLines`; route POST delegates to the service.
- `apps/backend/tests/mcp-server.test.ts` — update `tools/list` expectation for scope filtering.

**Frontend — modify:**
- `apps/frontend/src/pages/desktop/DesktopSettingsConnectors.tsx` — scope choice when minting a service client.
- `apps/frontend/src/lib/i18n.tsx` — strings for the scope choice (EN + ZH).

---

## Task 1: Add `sellorder:read` / `sellorder:write` OAuth scopes

**Files:**
- Modify: `apps/backend/src/types.ts:99`
- Modify: `apps/backend/src/oauth/metadata.ts:8`
- Modify: `apps/backend/src/oauth/server.ts:17`, `:21-22`, `:507`
- Test: `apps/backend/tests/oauth-endpoints.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/backend/tests/oauth-endpoints.test.ts` (inside the top-level `describe`, alongside the other metadata assertions — match the existing style of that file for how `api` is called):

```ts
it('advertises the sell-order scopes in AS metadata', async () => {
  const r = await api('GET', '/.well-known/oauth-authorization-server');
  expect(r.status).toBe(200);
  const scopes = (r.body as any).scopes_supported as string[];
  expect(scopes).toContain('sellorder:read');
  expect(scopes).toContain('sellorder:write');
  expect(scopes).toContain('market:read'); // unchanged
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/oauth-endpoints.test.ts`
Expected: FAIL — `scopes_supported` does not contain `sellorder:read`.

- [ ] **Step 3: Extend the scope union (`types.ts:99`)**

```ts
export type OAuthScope =
  | 'market:read'
  | 'market:write'
  | 'sellorder:read'
  | 'sellorder:write';
```

- [ ] **Step 4: Extend the advertised scope set (`metadata.ts:8`)**

```ts
const SCOPES = ['market:read', 'market:write', 'sellorder:read', 'sellorder:write'] as const;
```

- [ ] **Step 5: Extend DCR + consent gating + admin validation (`oauth/server.ts`)**

Replace `KNOWN_SCOPES` (line 17):

```ts
const KNOWN_SCOPES = new Set<string>(['market:read', 'market:write', 'sellorder:read', 'sellorder:write']);
```

Replace `dropWriteUnlessManager` (lines 21-22) so BOTH write scopes are manager-gated through the interactive flow:

```ts
// :write scopes through the interactive code flow are reserved for managers; a
// non-manager's consent yields a read-only grant. Service clients still get
// write via the admin-minted client_credentials path.
const WRITE_SCOPES = new Set(['market:write', 'sellorder:write']);
const dropWriteUnlessManager = (scopes: string[], role: string | undefined): string[] =>
  role === 'manager' ? scopes : scopes.filter(s => !WRITE_SCOPES.has(s));
```

Replace the admin `VALID_SCOPES` (line 507):

```ts
const VALID_SCOPES = ['market:read', 'market:write', 'sellorder:read', 'sellorder:write'] as const;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/backend && npx vitest run tests/oauth-endpoints.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `cd apps/backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/types.ts apps/backend/src/oauth/metadata.ts apps/backend/src/oauth/server.ts apps/backend/tests/oauth-endpoints.test.ts
git commit -m "feat(oauth): add sellorder:read/sellorder:write scopes"
```

---

## Task 2: Seed the MCP customer + default-customer setting (migration 0067)

**Why:** `create_sell_order_draft` defaults `customer_id` to the MCP customer. That customer must exist in every environment (the FK on `sell_orders.customer_id` is `NOT NULL REFERENCES customers(id)`), so the migration seeds it with the same fixed UUID the production DB already uses (`ON CONFLICT DO NOTHING` keeps it idempotent).

**Files:**
- Create: `apps/backend/migrations/0067_mcp_sell_order_customer.sql`
- Test: `apps/backend/tests/mcp-sell-orders.test.ts` (new file — first assertion only; the rest is added in Tasks 6-7)

- [ ] **Step 1: Write the migration**

Create `apps/backend/migrations/0067_mcp_sell_order_customer.sql`:

```sql
-- Canonical customer that MCP-created sell-order drafts are attributed to by
-- default. Fixed UUID so prod (where it already exists) and fresh/test DBs
-- converge on the same row. The default is also recorded as a workspace
-- setting so it is reconfigurable without a code change (create_sell_order_draft
-- reads mcp.sellOrderCustomerId, falling back to this id).
INSERT INTO customers (id, name, active)
VALUES ('f30f98bc-09c7-4108-b083-c7d69cc9968c', 'MCP', TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspace_settings (key, value) VALUES
  ('mcp.sellOrderCustomerId', '"f30f98bc-09c7-4108-b083-c7d69cc9968c"'::jsonb)
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 2: Write the failing test**

Create `apps/backend/tests/mcp-sell-orders.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';

describe('MCP sell-order migration seed', () => {
  beforeAll(async () => { await resetDb(); });

  it('seeds the MCP customer and the default-customer setting', async () => {
    const sql = getTestDb();
    const cust = (await sql<{ name: string }[]>`
      SELECT name FROM customers WHERE id = 'f30f98bc-09c7-4108-b083-c7d69cc9968c'
    `)[0];
    expect(cust?.name).toBe('MCP');
    const setting = (await sql<{ value: string }[]>`
      SELECT value FROM workspace_settings WHERE key = 'mcp.sellOrderCustomerId'
    `)[0];
    expect(setting?.value).toBe('f30f98bc-09c7-4108-b083-c7d69cc9968c');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/mcp-sell-orders.test.ts`
Expected: FAIL — customer/setting absent (`resetDb` reapplies migrations; if it does not pick up 0067 yet, the row is missing).

- [ ] **Step 4: Confirm `resetDb` applies the new migration**

`resetDb()` rebuilds from `migrations/` (see `tests/helpers/db.ts`). No code change needed — the new numbered file is picked up automatically on the next run.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/backend && npx vitest run tests/mcp-sell-orders.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/migrations/0067_mcp_sell_order_customer.sql apps/backend/tests/mcp-sell-orders.test.ts
git commit -m "feat(mcp): seed MCP sell-order customer + default-customer setting"
```

---

## Task 3: Server-side inventory label helper

**Why:** `order_lines` has no `label` column — the desktop builds the display label/sub-label from attribute columns (`itemLabel`/`itemSpec` in `DesktopInventory.tsx:406-415`). Both MCP tools must produce the SAME string the desktop would, so the agent's view equals the stored snapshot. This helper is the single source.

**Files:**
- Create: `apps/backend/src/lib/inventoryLabel.ts`
- Test: `apps/backend/tests/inventoryLabel.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/inventoryLabel.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { inventoryLabel, inventorySpec, type InventoryAttrs } from '../src/lib/inventoryLabel';

const base: InventoryAttrs = {
  category: 'RAM', brand: null, capacity: null, generation: null, type: null,
  classification: null, rank: null, speed: null, interface: null,
  form_factor: null, description: null, condition: null, health: null, rpm: null,
};

describe('inventoryLabel', () => {
  it('RAM joins brand + capacity + generation', () => {
    expect(inventoryLabel({ ...base, category: 'RAM', brand: 'Samsung', capacity: '32GB', generation: 'DDR4' }))
      .toBe('Samsung 32GB DDR4');
  });
  it('SSD joins brand + capacity', () => {
    expect(inventoryLabel({ ...base, category: 'SSD', brand: 'Intel', capacity: '960GB' }))
      .toBe('Intel 960GB');
  });
  it('Other falls back to description', () => {
    expect(inventoryLabel({ ...base, category: 'Other', description: 'NIC card' }))
      .toBe('NIC card');
  });
});

describe('inventorySpec', () => {
  it('RAM joins classification · rank · speedMHz', () => {
    expect(inventorySpec({ ...base, category: 'RAM', classification: 'RDIMM', rank: '2Rx4', speed: '3200' }))
      .toBe('RDIMM · 2Rx4 · 3200MHz');
  });
  it('SSD joins interface · form · health%', () => {
    expect(inventorySpec({ ...base, category: 'SSD', interface: 'NVMe', form_factor: 'M.2', health: 98 }))
      .toBe('NVMe · M.2 · 98%');
  });
  it('returns null when nothing composes', () => {
    expect(inventorySpec({ ...base, category: 'RAM' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/inventoryLabel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `apps/backend/src/lib/inventoryLabel.ts`:

```ts
// Server-side mirror of the desktop inventory label helpers
// (itemLabel / itemSpec in apps/frontend/src/pages/desktop/DesktopInventory.tsx).
// order_lines has no label column — the display string is composed from the
// attribute columns. The search_sellable_inventory MCP tool and
// createSellOrderDraft both derive the snapshot label here, so what the agent
// sees is exactly what gets stored on the sell_order_line.

export type InventoryAttrs = {
  category: string;
  brand: string | null;
  capacity: string | null;
  generation: string | null;
  type: string | null;
  classification: string | null;
  rank: string | null;
  speed: string | null;
  interface: string | null;
  form_factor: string | null;
  description: string | null;
  condition: string | null;
  health: number | null;
  rpm: number | null;
};

export function inventoryLabel(r: InventoryAttrs): string {
  switch (r.category) {
    case 'RAM': return `${r.brand ?? ''} ${r.capacity ?? ''} ${r.generation ?? ''}`.trim();
    case 'SSD': return `${r.brand ?? ''} ${r.capacity ?? ''}`.trim();
    case 'HDD': return `${r.brand ?? ''} ${r.capacity ?? ''}`.trim();
    default:    return r.description ?? '';
  }
}

export function inventorySpec(r: InventoryAttrs): string | null {
  let parts: Array<string | false | null | undefined>;
  switch (r.category) {
    case 'RAM': parts = [r.classification, r.rank, r.speed && `${r.speed}MHz`]; break;
    case 'SSD': parts = [r.interface, r.form_factor, r.health != null && `${r.health}%`]; break;
    case 'HDD': parts = [r.interface, r.form_factor, r.rpm && `${r.rpm}rpm`, r.health != null && `${r.health}%`]; break;
    default:    return r.condition ?? null;
  }
  const spec = parts.filter(Boolean).join(' · ');
  return spec || null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && npx vitest run tests/inventoryLabel.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/lib/inventoryLabel.ts apps/backend/tests/inventoryLabel.test.ts
git commit -m "feat(mcp): server-side inventory label/spec helper"
```

---

## Task 4: Extract the shared `createSellOrderDraft` service

**Why:** The MCP create tool must reuse the exact draft-creation path (FX snapshot, lock-and-validate, id allocation, audit event) — no parallel logic. Move `validateSellLines` and the create transaction out of the route into a service both the route and the tool call. `validateSellLines` is also used by the PATCH handler (`sellOrders.ts:586`), so it must be exported and imported back, not duplicated.

**Files:**
- Create: `apps/backend/src/services/sellOrderCreate.ts`
- Modify: `apps/backend/src/routes/sellOrders.ts:34-77` (remove local `validateSellLines`, import it), `:377-474` (POST delegates to the service)
- Test: existing `apps/backend/tests/sell-orders.test.ts`, `sell-order-currency.test.ts`, `sellOrders.events.test.ts` must stay green.

- [ ] **Step 1: Create the service (move `validateSellLines`, add `createSellOrderDraft`)**

Create `apps/backend/src/services/sellOrderCreate.ts`:

```ts
import type postgres from 'postgres';
import type { Sql } from 'postgres';
import { nextHumanId } from '../lib/id-seq';
import { writeSellOrderEvent } from './sellOrderAudit';
import {
  convertToUsd, getLatestRateToUsd, type SupportedCurrency,
} from '../lib/fx';

export type SellLine = { inventoryId?: string | null; qty: number };

// Validate every inventory-backed line of a sell order. MUST run inside the
// caller's transaction: each source row is locked FOR UPDATE so a concurrent
// sell order cannot pass the same qty/sellability check and oversell (TOCTOU).
// Also enforces the one-active-sell-order-per-line invariant. `excludeOrderId`
// is the sell order being edited (so a PATCH may keep its own already-committed
// lines); null for a brand-new order. Returns a human error string, or null
// when every line is sellable.
export async function validateSellLines(
  tx: postgres.TransactionSql,
  lines: SellLine[],
  excludeOrderId: string | null,
): Promise<string | null> {
  const demand = new Map<string, number>();
  for (const l of lines) {
    if (!l.inventoryId) continue; // manual line — nothing to reserve
    demand.set(l.inventoryId, (demand.get(l.inventoryId) ?? 0) + l.qty);
  }
  for (const [inventoryId, qty] of demand) {
    const inv = (await tx<{ qty: number; status: string }[]>`
      SELECT qty, status FROM order_lines WHERE id = ${inventoryId} LIMIT 1 FOR UPDATE
    `)[0];
    if (!inv) return `inventory line ${inventoryId} not found`;
    if (inv.status !== 'Reviewing' && inv.status !== 'Done')
      return `inventory line not sellable (status=${inv.status})`;
    if (qty > inv.qty) return `qty ${qty} exceeds inventory available ${inv.qty}`;
    const taken = (await tx<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM sell_order_lines sol
      JOIN sell_orders so ON so.id = sol.sell_order_id
      WHERE sol.inventory_id = ${inventoryId}
        AND so.status NOT IN ('Done', 'Closed')
        AND (${excludeOrderId}::text IS NULL OR so.id <> ${excludeOrderId}::text)
    `)[0];
    if (taken.n > 0) return `inventory line ${inventoryId} is already on an open sell order`;
  }
  return null;
}

export type DraftLineInput = {
  inventoryId?: string | null;
  category: string;
  label: string;
  subLabel?: string | null;
  partNumber?: string | null;
  qty: number;
  unitPrice: number;            // NATIVE currency
  warehouseId?: string | null;
  condition?: string | null;
};

export type CreateDraftInput = {
  customerId: string;
  currency: SupportedCurrency;
  notes?: string | null;
  lines: DraftLineInput[];
  actorUserId: string | null;   // null for client_credentials MCP clients
  source: string;               // 'manager' | `mcp:<clientId>`
};

export type CreateDraftResult =
  | { ok: true; id: string; customerId: string; lineCount: number; currency: SupportedCurrency }
  | { ok: false; error: string };

// Shared draft-creation path used by POST /api/sell-orders and the
// create_sell_order_draft MCP tool. Resolves the FX snapshot BEFORE opening the
// transaction (getLatestRateToUsd may do an outbound fetch on a cold cache;
// holding the id-counter + inventory locks across it would serialize all
// sell-order creation). Allocates the id, lock-validates lines, inserts the
// header + lines + a 'created' audit event, all atomically.
export async function createSellOrderDraft(
  sql: Sql,
  input: CreateDraftInput,
): Promise<CreateDraftResult> {
  const isNonUsd = input.currency !== 'USD';
  const fx = await getLatestRateToUsd(sql, input.currency);

  let nextId!: string;
  let outcome: CreateDraftResult = { ok: true, id: '', customerId: input.customerId, lineCount: input.lines.length, currency: input.currency };

  await sql.begin(async (tx) => {
    nextId = await nextHumanId(tx, 'SO', 'SO');
    const err = await validateSellLines(tx, input.lines, null);
    if (err) { outcome = { ok: false, error: err }; return; } // roll back — nothing written
    await tx`
      INSERT INTO sell_orders (id, customer_id, status, notes, created_by,
                               currency_code, fx_rate_to_usd, fx_source)
      VALUES (${nextId}, ${input.customerId}, 'Draft', ${input.notes ?? null}, ${input.actorUserId},
              ${input.currency}, ${fx.rate}, ${fx.source})
    `;
    for (let i = 0; i < input.lines.length; i++) {
      const l = input.lines[i];
      const unitPriceUsd = isNonUsd ? convertToUsd(l.unitPrice, fx.rate) : l.unitPrice;
      await tx`
        INSERT INTO sell_order_lines
          (sell_order_id, inventory_id, category, label, sub_label, part_number,
           qty, unit_price, warehouse_id, condition, position,
           source_currency, source_unit_price, source_fx_rate_to_usd)
        VALUES
          (${nextId}, ${l.inventoryId ?? null}, ${l.category}, ${l.label},
           ${l.subLabel ?? null}, ${l.partNumber ?? null},
           ${l.qty}, ${unitPriceUsd},
           ${l.warehouseId ?? null}, ${l.condition ?? null}, ${i},
           ${isNonUsd ? input.currency : null},
           ${isNonUsd ? l.unitPrice : null},
           ${isNonUsd ? fx.rate : null})
      `;
    }
    await writeSellOrderEvent(tx, nextId, input.actorUserId, 'created', {
      source: input.source,
      status: 'Draft',
      lineCount: input.lines.length,
      customerId: input.customerId,
      currency: input.currency,
      fxRateToUsd: fx.rate,
      fxSource: fx.source,
    });
  });

  if (!outcome.ok) return outcome;
  return { ok: true, id: nextId, customerId: input.customerId, lineCount: input.lines.length, currency: input.currency };
}
```

- [ ] **Step 2: Update the route to import the moved validator and delegate**

In `apps/backend/src/routes/sellOrders.ts`:

Delete the local `type SellLine` (line 34) and the entire local `validateSellLines` function (lines 36-77). Add to the import block near the top (next to the other service imports at lines 11-14):

```ts
import { validateSellLines, createSellOrderDraft } from '../services/sellOrderCreate';
```

Replace the POST handler body from the FX-resolution comment through the `return c.json({ ok: true, id: nextId }, 201);` (lines 416-473) with a delegation to the service:

```ts
  const result = await createSellOrderDraft(sql, {
    customerId: body.customerId,
    currency,
    notes: body.notes ?? null,
    lines: body.lines,
    actorUserId: u.id,
    source: 'manager',
  });
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true, id: result.id }, 201);
```

Leave the PATCH handler's `validateSellLines(tx, body.lines, id)` call (now line ~586) untouched — it resolves to the imported function.

- [ ] **Step 3: Typecheck**

Run: `cd apps/backend && npx tsc --noEmit`
Expected: no errors. (`body.lines` is `LineIn[]`, structurally assignable to `DraftLineInput[]`.)

- [ ] **Step 4: Run the affected suites to verify no regression**

Run: `cd apps/backend && npx vitest run tests/sell-orders.test.ts tests/sell-order-currency.test.ts tests/sellOrders.events.test.ts tests/sell-done-race.test.ts`
Expected: PASS — behavior is unchanged; the `created` event still records `source: 'manager'`, USD + CNY paths still snapshot FX, oversell/duplicate-line guards still fire.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/sellOrderCreate.ts apps/backend/src/routes/sellOrders.ts
git commit -m "refactor(sell-orders): extract shared createSellOrderDraft service"
```

---

## Task 5: Relax the MCP mount guard + scope-map dispatch with `tools/list` filtering

**Why:** Today `/api/mcp` is mounted behind `bearerGuard({ scopes: ['market:read'] })`, so a `sellorder:*`-only token is rejected before reaching the handler. Require only a valid token at the mount and enforce per-tool scopes inside the handler via a single scope map, which also drives `tools/list` filtering so each token sees only the tools it can call.

**Files:**
- Modify: `apps/backend/src/index.ts:173`
- Modify: `apps/backend/src/mcp/server.ts`
- Test: `apps/backend/tests/mcp-server.test.ts:50-57` (update expectation)

- [ ] **Step 1: Update the existing `tools/list` test to expect scope filtering**

In `apps/backend/tests/mcp-server.test.ts`, replace the test at lines 50-57 with two cases — a read-only token sees only the read tools, and add a write-capable token that sees `set_market_price`:

```ts
it('tools/list filters by granted scope (read-only token: read tools only)', async () => {
  const r = await api('POST', '/api/mcp', {
    headers: { authorization: `Bearer ${bearerRead}` },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  });
  const names = (r.body as any).result.tools.map((t: any) => t.name).sort();
  expect(names).toEqual(['get_market_value', 'list_market_values']);
});
```

(The write-capable visibility is already covered by the `MCP set_market_price tool` describe block, whose write token can call it. No further change needed in this file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/mcp-server.test.ts`
Expected: FAIL — current `tools/list` returns all three tools unfiltered, so the read-only expectation `['get_market_value','list_market_values']` does not match.

- [ ] **Step 3: Relax the mount guard (`index.ts:173`)**

```ts
app.use('/api/mcp', bearerGuard({ scopes: [] }));
```

(`bearerGuard` still verifies the token signature/issuer/audience and populates `oauthCtx`; an empty `scopes` array means no specific scope is required at the mount — per-tool checks take over.)

- [ ] **Step 4: Rewrite `mcp/server.ts` dispatch around a scope map**

Replace the imports + `tools/list` + `tools/call` sections of `apps/backend/src/mcp/server.ts`. Full updated file:

```ts
// MCP HTTP adapter. We speak JSON-RPC 2.0 directly over a single POST endpoint
// instead of pulling in the SDK's Streamable HTTP transport, since the tools
// don't emit server-initiated messages (no SSE upgrade needed).

import type { Context } from 'hono';
import { getDb } from '../db';
import { readPackageVersion } from '../lib/version';
import { TOOL_DEFS, callListMarketValues, callGetMarketValue, callSetMarketPrice } from './tools/market';
import {
  SELL_ORDER_TOOL_DEFS, callSearchSellableInventory, callCreateSellOrderDraft,
} from './tools/sellOrders';
import type { OAuthCtx, OAuthScope, Env } from '../types';
import { mcpToolCallsTotal } from '../metrics';

type JsonRpcReq = { jsonrpc: '2.0'; id: number | string; method: string; params?: Record<string, unknown> };

const SERVER_INFO = { name: 'recycle-erp-mcp', version: readPackageVersion() };
const CAPABILITIES = { tools: { listChanged: false } };

const ALL_TOOLS = [...TOOL_DEFS, ...SELL_ORDER_TOOL_DEFS];

// Single source of truth for which scope each tool requires. Drives both
// tools/list visibility and the tools/call gate, so a token only ever sees and
// invokes the tools its scopes permit.
const TOOL_SCOPES: Record<string, OAuthScope> = {
  list_market_values: 'market:read',
  get_market_value: 'market:read',
  set_market_price: 'market:write',
  search_sellable_inventory: 'sellorder:read',
  create_sell_order_draft: 'sellorder:write',
};

function rpcOk(id: number | string, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}
function rpcErr(id: number | string | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

export async function handleMcp(c: Context<{ Bindings: Env; Variables: any }>): Promise<Response> {
  let req: JsonRpcReq;
  try { req = await c.req.json() as JsonRpcReq; }
  catch { return c.json(rpcErr(null, -32700, 'parse error')); }

  const sql = getDb(c.env);
  const ctx = c.get('oauthCtx') as OAuthCtx | undefined;
  const granted = new Set(ctx?.scopes ?? []);

  switch (req.method) {
    case 'initialize':
      return c.json(rpcOk(req.id, {
        protocolVersion: (req.params as any)?.protocolVersion ?? '2024-11-05',
        serverInfo: SERVER_INFO,
        capabilities: CAPABILITIES,
      }));
    case 'tools/list':
      return c.json(rpcOk(req.id, {
        tools: ALL_TOOLS.filter(t => granted.has(TOOL_SCOPES[t.name])),
      }));
    case 'tools/call': {
      const { name, arguments: args = {} } = (req.params ?? {}) as { name?: string; arguments?: any };
      const toolLabel = name ?? 'unknown';
      try {
        const required = name ? TOOL_SCOPES[name] : undefined;
        if (!name || !required) {
          mcpToolCallsTotal.inc({ tool: toolLabel, status: 'error' });
          return c.json(rpcErr(req.id, -32601, `unknown tool: ${name}`));
        }
        if (!granted.has(required)) {
          mcpToolCallsTotal.inc({ tool: toolLabel, status: 'error' });
          return c.json(rpcErr(req.id, -32001, `insufficient_scope: ${required} required`));
        }
        let payload: unknown;
        if (name === 'list_market_values') payload = await callListMarketValues(sql, args);
        else if (name === 'get_market_value') payload = await callGetMarketValue(sql, args);
        else if (name === 'set_market_price') {
          payload = await callSetMarketPrice(sql, args, {
            source: `mcp:${ctx!.clientId}`, actorUserId: ctx!.userId,
          });
        }
        else if (name === 'search_sellable_inventory') payload = await callSearchSellableInventory(sql, args);
        else if (name === 'create_sell_order_draft') {
          payload = await callCreateSellOrderDraft(sql, args, {
            source: `mcp:${ctx!.clientId}`, actorUserId: ctx!.userId,
          });
        }
        mcpToolCallsTotal.inc({ tool: toolLabel, status: 'ok' });
        return c.json(rpcOk(req.id, {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
        }));
      } catch (e) {
        mcpToolCallsTotal.inc({ tool: toolLabel, status: 'error' });
        return c.json(rpcErr(req.id, -32602, e instanceof Error ? e.message : 'invalid params'));
      }
    }
    default:
      return c.json(rpcErr(req.id, -32601, `unknown method: ${req.method}`));
  }
}
```

> Note: this imports `./tools/sellOrders`, created in Task 6. To keep the build green between tasks, do Task 6 Step 3 (create the tool module with both functions) before running the full typecheck here. If you prefer to keep each task independently green, implement Task 6 first, then Task 5 — the two are mutually dependent at the import line only.

- [ ] **Step 5: Add a stub so this task typechecks in isolation (optional ordering aid)**

If implementing Task 5 before Task 6, create a minimal `apps/backend/src/mcp/tools/sellOrders.ts` exporting `SELL_ORDER_TOOL_DEFS = [] as const` and `callSearchSellableInventory`/`callCreateSellOrderDraft` throwing `new Error('not implemented')`, then flesh it out in Task 6. Otherwise skip this step.

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/backend && npx vitest run tests/mcp-server.test.ts`
Expected: PASS — read-only token sees exactly the two read tools; write token still calls `set_market_price`.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/index.ts apps/backend/src/mcp/server.ts apps/backend/tests/mcp-server.test.ts
git commit -m "feat(mcp): per-tool scope gate + tools/list scope filtering"
```

---

## Task 6: Implement `search_sellable_inventory`

**Files:**
- Create/extend: `apps/backend/src/mcp/tools/sellOrders.ts`
- Test: `apps/backend/tests/mcp-sell-orders.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/backend/tests/mcp-sell-orders.test.ts`. Add imports at the top of the file (next to the existing ones):

```ts
import { createOAuthClient } from '../src/oauth/clients';
import { signAccessToken, generateSigningKey } from '../src/oauth/tokens';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
```

Then add a new describe block:

```ts
describe('MCP search_sellable_inventory', () => {
  let bearerRead: string;
  let bearerNone: string;
  beforeAll(async () => {
    await resetDb();
    const key = await generateSigningKey();
    process.env.__TEST_OAUTH_KEY__ = key;
    process.env.OAUTH_ISSUER_URL = 'http://localhost:8787';
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const env = {
      OAUTH_ISSUER_URL: 'http://localhost:8787',
      OAUTH_SIGNING_KEY_CURRENT: key,
      OAUTH_ACCESS_TOKEN_TTL_SEC: '900',
    } as any;
    const rc = await createOAuthClient(sql, {
      name: 'so-reader', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['sellorder:read'],
      createdBy: u, public: false,
    });
    const nc = await createOAuthClient(sql, {
      name: 'market-only', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    bearerRead = await signAccessToken(env, { clientId: rc.clientId, userId: null, scopes: ['sellorder:read'] });
    bearerNone = await signAccessToken(env, { clientId: nc.clientId, userId: null, scopes: ['market:read'] });
  });

  const call = (bearer: string, args: unknown, id = 1) =>
    api('POST', '/api/mcp', {
      headers: { authorization: `Bearer ${bearer}` },
      body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search_sellable_inventory', arguments: args } },
    });

  it('lists sellable lines with a derived label and availableQty', async () => {
    const r = await call(bearerRead, { limit: 5 });
    const body = r.body as any;
    expect(body.error).toBeUndefined();
    const rows = JSON.parse(body.result.content[0].text);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(typeof rows[0].inventoryId).toBe('string');
    expect(typeof rows[0].label).toBe('string');
    expect(typeof rows[0].availableQty).toBe('number');
  });

  it('excludes lines already on an open sell order', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    // Put the line on a fresh draft sell order via the manager route.
    const customerId = (await api<{ items: { id: string }[] }>('GET', '/api/customers', { token })).body.items[0].id;
    const created = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', qty: 1, unitPrice: line.sell_price }] },
    });
    expect(created.status).toBe(201);
    const r = await call(bearerRead, { limit: 200 });
    const rows = JSON.parse((r.body as any).result.content[0].text);
    expect(rows.some((x: any) => x.inventoryId === line.id)).toBe(false);
  });

  it('refuses a token without sellorder:read', async () => {
    const r = await call(bearerNone, { limit: 5 });
    const body = r.body as any;
    expect(body.result).toBeUndefined();
    expect(body.error.message).toMatch(/insufficient_scope/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/mcp-sell-orders.test.ts`
Expected: FAIL — tool not implemented (unknown tool / not implemented).

- [ ] **Step 3: Implement the tool module (defs + search)**

Create (or replace the Task-5 stub) `apps/backend/src/mcp/tools/sellOrders.ts`:

```ts
import type postgres from 'postgres';
import { inventoryLabel, inventorySpec, type InventoryAttrs } from '../../lib/inventoryLabel';

export const SELL_ORDER_TOOL_DEFS = [
  {
    name: 'search_sellable_inventory',
    description:
      'Read-only. List inventory lines that can currently be put on a sell order — status Reviewing or Done and ' +
      'not already committed to an open sell order — newest first. Use this to find the inventoryId values that ' +
      'create_sell_order_draft requires. Each row includes: inventoryId (pass this to create_sell_order_draft), ' +
      'category, label and subLabel (the display name the draft will store), partNumber, condition, warehouseId ' +
      'and warehouseName, availableQty (the full sellable quantity of the line), and sellPrice (the price already ' +
      'assigned to the line, in USD — advisory; you still choose each line\'s unitPrice). Filter with query ' +
      '(matches brand / part number / description / category) and warehouseId. Requires the sellorder:read scope.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'case-insensitive match against brand, part number, description, category' },
        warehouseId: { type: 'string', description: 'optional warehouse id filter (e.g. "WH-LA1")' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'max rows to return (1-100, default 20)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'create_sell_order_draft',
    description:
      'Write. Create a Draft sell order from inventory lines. Every line MUST reference a real sellable line by ' +
      'inventoryId (get them from search_sellable_inventory) plus a qty (>0) and unitPrice (>=0, in the order ' +
      'currency). Descriptive fields (category, label, part number, warehouse, condition) are taken from the ' +
      'referenced inventory line — do not supply them. customerId defaults to the MCP customer when omitted. ' +
      'currency is USD (default) or CNY; unitPrice is the native price and is converted to USD on store. On ' +
      'success returns { id, status, customerId, lineCount, currency }. Errors (insufficient stock, an ' +
      'inventoryId that is unknown or already on an open sell order, an unknown customerId) are returned as the ' +
      'JSON-RPC error message. Requires the sellorder:write scope (a sellorder:read-only token is rejected).',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string', description: 'customer UUID; defaults to the MCP customer if omitted' },
        currency: { type: 'string', enum: ['USD', 'CNY'], default: 'USD', description: 'order currency (default USD)' },
        notes: { type: 'string', maxLength: 2000, description: 'optional order-level note' },
        lines: {
          type: 'array',
          minItems: 1,
          description: 'at least one line; each references a sellable inventory line',
          items: {
            type: 'object',
            properties: {
              inventoryId: { type: 'string', description: 'id from search_sellable_inventory' },
              qty: { type: 'integer', minimum: 1, description: 'quantity to sell (>0, <= availableQty)' },
              unitPrice: { type: 'number', minimum: 0, description: 'price per unit in the order currency (>=0)' },
            },
            required: ['inventoryId', 'qty', 'unitPrice'],
            additionalProperties: false,
          },
        },
      },
      required: ['lines'],
      additionalProperties: false,
    },
  },
] as const;

type SellableRow = InventoryAttrs & {
  id: string;
  part_number: string | null;
  qty: number;
  sell_price: number | null;
  warehouse_id: string | null;
  warehouse_short: string | null;
};

export async function callSearchSellableInventory(
  sql: postgres.Sql,
  args: { query?: string; warehouseId?: string; limit?: number },
) {
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const q = args.query?.toLowerCase().trim() || null;
  const wh = args.warehouseId?.trim() || null;
  const rows = await sql<SellableRow[]>`
    SELECT l.id, l.category, l.brand, l.capacity, l.generation, l.type,
           l.classification, l.rank, l.speed, l.interface, l.form_factor,
           l.description, l.part_number, l.condition, l.qty,
           l.sell_price::float AS sell_price,
           l.health::float AS health, l.rpm,
           COALESCE(l.warehouse_id, o.warehouse_id) AS warehouse_id,
           w.short AS warehouse_short
    FROM order_lines l
    JOIN orders o ON o.id = l.order_id
    LEFT JOIN warehouses w ON w.id = COALESCE(l.warehouse_id, o.warehouse_id)
    WHERE l.status IN ('Reviewing', 'Done')
      AND NOT EXISTS (
        SELECT 1 FROM sell_order_lines sol
        JOIN sell_orders so ON so.id = sol.sell_order_id
        WHERE sol.inventory_id = l.id AND so.status NOT IN ('Done', 'Closed')
      )
      AND (${q}::text IS NULL
           OR LOWER(COALESCE(l.brand,'')) LIKE '%' || ${q ?? ''} || '%'
           OR LOWER(COALESCE(l.part_number,'')) LIKE '%' || ${q ?? ''} || '%'
           OR LOWER(COALESCE(l.description,'')) LIKE '%' || ${q ?? ''} || '%'
           OR LOWER(l.category) LIKE '%' || ${q ?? ''} || '%')
      AND (${wh}::text IS NULL OR COALESCE(l.warehouse_id, o.warehouse_id) = ${wh})
    ORDER BY l.created_at DESC
    LIMIT ${limit}
  `;
  return rows.map(r => ({
    inventoryId: r.id,
    category: r.category,
    label: inventoryLabel(r) || r.id.slice(0, 8),
    subLabel: inventorySpec(r),
    partNumber: r.part_number,
    condition: r.condition,
    warehouseId: r.warehouse_id,
    warehouseName: r.warehouse_short,
    availableQty: r.qty,
    sellPrice: r.sell_price,
  }));
}

// callCreateSellOrderDraft is added in Task 7.
export async function callCreateSellOrderDraft(
  _sql: postgres.Sql,
  _args: unknown,
  _ctx: { source: string; actorUserId: string | null },
): Promise<unknown> {
  throw new Error('not implemented');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && npx vitest run tests/mcp-sell-orders.test.ts`
Expected: PASS for the `search_sellable_inventory` block (the migration-seed test from Task 2 still passes).

- [ ] **Step 5: Typecheck**

Run: `cd apps/backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/mcp/tools/sellOrders.ts apps/backend/tests/mcp-sell-orders.test.ts
git commit -m "feat(mcp): search_sellable_inventory tool"
```

---

## Task 7: Implement `create_sell_order_draft`

**Files:**
- Modify: `apps/backend/src/mcp/tools/sellOrders.ts` (replace the `callCreateSellOrderDraft` stub)
- Test: `apps/backend/tests/mcp-sell-orders.test.ts`

- [ ] **Step 1: Write the failing test**

Append a describe block to `apps/backend/tests/mcp-sell-orders.test.ts`:

```ts
describe('MCP create_sell_order_draft', () => {
  let bearerWrite: string;
  let bearerRead: string;
  beforeAll(async () => {
    await resetDb();
    const key = await generateSigningKey();
    process.env.__TEST_OAUTH_KEY__ = key;
    process.env.OAUTH_ISSUER_URL = 'http://localhost:8787';
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const env = {
      OAUTH_ISSUER_URL: 'http://localhost:8787',
      OAUTH_SIGNING_KEY_CURRENT: key,
      OAUTH_ACCESS_TOKEN_TTL_SEC: '900',
    } as any;
    const wc = await createOAuthClient(sql, {
      name: 'so-writer', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['sellorder:read', 'sellorder:write'],
      createdBy: u, public: false,
    });
    const rc = await createOAuthClient(sql, {
      name: 'so-reader2', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['sellorder:read'],
      createdBy: u, public: false,
    });
    bearerWrite = await signAccessToken(env, { clientId: wc.clientId, userId: null, scopes: ['sellorder:read', 'sellorder:write'] });
    bearerRead = await signAccessToken(env, { clientId: rc.clientId, userId: null, scopes: ['sellorder:read'] });
  });

  const create = (bearer: string, args: unknown, id = 1) =>
    api('POST', '/api/mcp', {
      headers: { authorization: `Bearer ${bearer}` },
      body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'create_sell_order_draft', arguments: args } },
    });

  async function aFreeLineId(): Promise<{ id: string; sellPrice: number }> {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    return { id: line.id, sellPrice: line.sell_price };
  }

  it('creates a Draft for the default MCP customer with a derived label', async () => {
    const sql = getTestDb();
    const { id: invId } = await aFreeLineId();
    const r = await create(bearerWrite, { lines: [{ inventoryId: invId, qty: 1, unitPrice: 50 }] });
    const body = r.body as any;
    expect(body.error).toBeUndefined();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.status).toBe('Draft');
    expect(payload.id).toMatch(/^SO-/);
    expect(payload.customerId).toBe('f30f98bc-09c7-4108-b083-c7d69cc9968c');

    const so = (await sql<{ status: string; customer_id: string }[]>`
      SELECT status, customer_id FROM sell_orders WHERE id = ${payload.id}
    `)[0];
    expect(so.status).toBe('Draft');
    expect(so.customer_id).toBe('f30f98bc-09c7-4108-b083-c7d69cc9968c');

    const sol = (await sql<{ inventory_id: string; label: string; unit_price: number }[]>`
      SELECT inventory_id, label, unit_price::float AS unit_price FROM sell_order_lines WHERE sell_order_id = ${payload.id}
    `)[0];
    expect(sol.inventory_id).toBe(invId);
    expect(sol.label.length).toBeGreaterThan(0);          // derived server-side
    expect(sol.unit_price).toBe(50);

    const ev = (await sql<{ detail: { source: string } }[]>`
      SELECT detail FROM sell_order_events WHERE sell_order_id = ${payload.id} AND kind = 'created'
    `)[0];
    expect(ev.detail.source).toMatch(/^mcp:/);            // distinguishable origin
  });

  it('refuses a sellorder:read-only token with insufficient_scope', async () => {
    const { id: invId } = await aFreeLineId();
    const r = await create(bearerRead, { lines: [{ inventoryId: invId, qty: 1, unitPrice: 50 }] });
    const body = r.body as any;
    expect(body.result).toBeUndefined();
    expect(body.error.message).toMatch(/insufficient_scope/);
  });

  it('rejects an unknown inventoryId', async () => {
    const r = await create(bearerWrite, { lines: [{ inventoryId: '00000000-0000-0000-0000-000000000000', qty: 1, unitPrice: 10 }] });
    expect((r.body as any).error.message).toMatch(/not found/);
  });

  it('rejects oversell beyond available qty', async () => {
    const { id: invId } = await aFreeLineId();
    const r = await create(bearerWrite, { lines: [{ inventoryId: invId, qty: 999999, unitPrice: 10 }] });
    expect((r.body as any).error.message).toMatch(/exceeds inventory available/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/mcp-sell-orders.test.ts`
Expected: FAIL — `callCreateSellOrderDraft` throws `not implemented`.

- [ ] **Step 3: Replace the `callCreateSellOrderDraft` stub**

In `apps/backend/src/mcp/tools/sellOrders.ts`, add imports at the top:

```ts
import { getWorkspaceSetting } from '../../lib/settings';
import { isSupportedCurrency, type SupportedCurrency } from '../../lib/fx';
import { createSellOrderDraft, type DraftLineInput } from '../../services/sellOrderCreate';
```

Replace the stub `callCreateSellOrderDraft` with:

```ts
const DEFAULT_MCP_CUSTOMER = 'f30f98bc-09c7-4108-b083-c7d69cc9968c';

type CreateArgs = {
  customerId?: string;
  currency?: string;
  notes?: string;
  lines?: Array<{ inventoryId?: string; qty?: number; unitPrice?: number }>;
};

export async function callCreateSellOrderDraft(
  sql: postgres.Sql,
  args: CreateArgs,
  ctx: { source: string; actorUserId: string | null },
) {
  const lines = Array.isArray(args.lines) ? args.lines : [];
  if (lines.length === 0) throw new Error('at least one line required');

  const currency: SupportedCurrency = args.currency === undefined ? 'USD' : (args.currency as SupportedCurrency);
  if (!isSupportedCurrency(currency)) throw new Error('unsupported currency');

  // Validate the agent-supplied numerics up front with clean messages (the
  // sell_order_lines CHECK would otherwise surface as a generic 500).
  for (const l of lines) {
    if (!l.inventoryId) throw new Error('each line requires an inventoryId');
    if (!Number.isInteger(l.qty) || (l.qty as number) <= 0) throw new Error('qty must be a positive integer');
    if (!Number.isFinite(l.unitPrice) || (l.unitPrice as number) < 0) throw new Error('unitPrice must be >= 0');
  }

  // Derive descriptive fields from the referenced inventory lines — the agent
  // supplies only ids/qty/price, never the label/category snapshot. A plain
  // read here; createSellOrderDraft re-locks and re-validates sellability/qty
  // inside its transaction (authoritative).
  const ids = lines.map(l => l.inventoryId as string);
  const invRows = await sql<Array<InventoryAttrs & {
    id: string; part_number: string | null; warehouse_id: string | null;
  }>>`
    SELECT l.id, l.category, l.brand, l.capacity, l.generation, l.type,
           l.classification, l.rank, l.speed, l.interface, l.form_factor,
           l.description, l.part_number, l.condition,
           l.health::float AS health, l.rpm,
           COALESCE(l.warehouse_id, o.warehouse_id) AS warehouse_id
    FROM order_lines l
    JOIN orders o ON o.id = l.order_id
    WHERE l.id = ANY(${ids}::uuid[])
  `;
  const byId = new Map(invRows.map(r => [r.id, r]));

  const draftLines: DraftLineInput[] = lines.map(l => {
    const inv = byId.get(l.inventoryId as string);
    if (!inv) throw new Error(`inventory line ${l.inventoryId} not found`);
    return {
      inventoryId: inv.id,
      category: inv.category,
      label: inventoryLabel(inv) || inv.id.slice(0, 8),
      subLabel: inventorySpec(inv),
      partNumber: inv.part_number,
      qty: l.qty as number,
      unitPrice: l.unitPrice as number,
      warehouseId: inv.warehouse_id,
      condition: inv.condition,
    };
  });

  const customerId = args.customerId?.trim()
    || await getWorkspaceSetting<string>(sql, 'mcp.sellOrderCustomerId', DEFAULT_MCP_CUSTOMER);

  const result = await createSellOrderDraft(sql, {
    customerId,
    currency,
    notes: args.notes ?? null,
    lines: draftLines,
    actorUserId: ctx.actorUserId,
    source: ctx.source,
  });
  if (!result.ok) throw new Error(result.error);
  return { id: result.id, status: 'Draft', customerId: result.customerId, lineCount: result.lineCount, currency: result.currency };
}
```

Note: the `InventoryAttrs` type is already imported in this file (Task 6). Keep the `import type postgres from 'postgres';` line.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/backend && npx vitest run tests/mcp-sell-orders.test.ts`
Expected: PASS — all create cases plus the earlier search + migration blocks.

- [ ] **Step 5: Typecheck**

Run: `cd apps/backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the MCP + sell-order suites together (regression)**

Run: `cd apps/backend && npx vitest run tests/mcp-server.test.ts tests/mcp-sell-orders.test.ts tests/sell-orders.test.ts tests/sell-order-currency.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/mcp/tools/sellOrders.ts apps/backend/tests/mcp-sell-orders.test.ts
git commit -m "feat(mcp): create_sell_order_draft tool"
```

---

## Task 8: Connectors UI — let a manager mint a sell-order client

**Why:** A dedicated `sellorder:*` token is issued via the client_credentials path, minted by a manager in Settings → Connectors. The form currently hardcodes `scopes: ['market:write']`; add a scope choice so the manager can mint either a market-price client or a sell-order-draft client.

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSettingsConnectors.tsx:54-76`
- Modify: `apps/frontend/src/lib/i18n.tsx` (EN `connectorsAddServiceSub` ~line 598, ZH ~line 1846; add two scope-label keys)

- [ ] **Step 1: Add a scope choice to the create form**

In `DesktopSettingsConnectors.tsx`, add state near the other `useState` hooks (e.g. beside `newName`):

```tsx
const [newScope, setNewScope] = useState<'market' | 'sellorder'>('market');
```

In `createServiceClient`, replace the hardcoded `scopes: ['market:write']` (line 64) with:

```tsx
scopes: newScope === 'sellorder' ? ['sellorder:read', 'sellorder:write'] : ['market:write'],
```

Add a selector to the form markup, just above the create button (match the surrounding desktop control styling; `useT()` is already in scope as `t`):

```tsx
<label className="so-label">{t('connectorsScopeLabel')}</label>
<select value={newScope} onChange={e => setNewScope(e.target.value as 'market' | 'sellorder')}>
  <option value="market">{t('connectorsScopeMarket')}</option>
  <option value="sellorder">{t('connectorsScopeSellOrder')}</option>
</select>
```

- [ ] **Step 2: Add i18n strings (EN + ZH)**

In `apps/frontend/src/lib/i18n.tsx`, in the EN block near `connectorsAddServiceSub` (~line 598) add:

```ts
connectorsScopeLabel: 'Scope',
connectorsScopeMarket: 'Market price writer (market:write)',
connectorsScopeSellOrder: 'Sell-order draft creator (sellorder:read + sellorder:write)',
```

And the matching ZH block (~line 1846):

```ts
connectorsScopeLabel: '权限范围',
connectorsScopeMarket: '市场价格写入 (market:write)',
connectorsScopeSellOrder: '销售订单草稿创建 (sellorder:read + sellorder:write)',
```

Also update `connectorsAddServiceSub` (both locales) so it no longer claims the client is always market:write — e.g. EN: `'Mints a confidential client_credentials client with the scope you choose below.'`; ZH: `'创建一个机密 client_credentials 客户端，权限范围由下方选择。'`

- [ ] **Step 3: Typecheck + build the frontend**

Run: `cd apps/frontend && npx tsc --noEmit`
Expected: no errors (every `t('…')` key used exists in both locales).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSettingsConnectors.tsx apps/frontend/src/lib/i18n.tsx
git commit -m "feat(connectors): mint sell-order MCP service clients"
```

---

## Task 9: Full verification + release

**Files:**
- Modify: `CHANGELOG.md` / version (via `scripts/release.sh`)

- [ ] **Step 1: Workspace typecheck**

Run: `pnpm typecheck`
Expected: no errors across backend + frontend + shared.

- [ ] **Step 2: Run the full backend MCP + sell-order regression**

Run: `cd apps/backend && npx vitest run tests/mcp-server.test.ts tests/mcp-sell-orders.test.ts tests/inventoryLabel.test.ts tests/oauth-endpoints.test.ts tests/sell-orders.test.ts tests/sell-order-currency.test.ts tests/sellOrders.events.test.ts`
Expected: all PASS.

- [ ] **Step 3: Cut the release**

Per repo convention each change ships as its own SemVer release. Run the release script (minor bump — this adds a feature):

```bash
./scripts/release.sh minor
```

Expected: `package.json` version bumped, `CHANGELOG.md` regenerated with the sell-order-MCP entry, tag created, versioned docker images built. Verify the `OPENROUTER_API_KEY` note is irrelevant here (no OCR change).

- [ ] **Step 4: Push**

```bash
git push origin main --follow-tags
```

(The pre-push hook runs the changelog gate + `pnpm audit` on lockfile change + the static security scan — expect it to pass since no deps changed.)

---

## Self-Review

**Spec coverage:**
- Scopes `sellorder:read` + `sellorder:write` → Task 1. ✓
- Relaxed mount guard + per-tool enforcement + `tools/list` filtering → Task 5. ✓
- Manager-gated `sellorder:write` in interactive flow → Task 1 (`dropWriteUnlessManager`). ✓
- `search_sellable_inventory` (same sellable predicate as `validateSellLines`, advisory price) → Task 6. ✓
- `create_sell_order_draft` (inventory-linked only, server-derived descriptive fields) → Task 7. ✓
- Shared `createSellOrderDraft` service, no parallel logic → Task 4. ✓
- Default MCP customer via `mcp.sellOrderCustomerId` setting, override allowed → Task 2 (seed) + Task 7 (read/override). ✓
- Audit `source: mcp:<clientId>` distinguishable → Task 4 (service param) + Task 7 (passes ctx.source), asserted in Task 7 test. ✓
- Tests: scope enforcement, list filtering, sellable exclusion, happy path, rejections → Tasks 5-7. ✓
- Issuing the token via UI → Task 8. ✓

**Resolved spec deviation (recorded):** the search tool's advisory price is the inventory line's own `sell_price` (USD) — the value the desktop draft pre-fills as the default unit price — rather than the market `last_price`. It is more direct, matches existing UI behavior, and needs no extra lookup. Returned as `sellPrice`. (Update the spec's "Resolved" note to match — done as part of Task 6 commit if desired.)

**Type consistency:** `DraftLineInput`/`CreateDraftInput`/`CreateDraftResult` defined in Task 4 are the exact shapes consumed in Task 7. `InventoryAttrs` (Task 3) is the row shape selected in Tasks 6 & 7. `TOOL_SCOPES` names match the tool `name` fields in both `TOOL_DEFS` and `SELL_ORDER_TOOL_DEFS`. `OAuthScope` (Task 1) covers every scope string used.

**Placeholder scan:** none — every code and test step contains complete content.
