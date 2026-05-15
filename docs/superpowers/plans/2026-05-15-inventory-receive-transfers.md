# Inventory Receive / Transfers Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manager-only `/transfers` page that lists in-transit inventory (lines moved via a warehouse transfer), lets a manager bulk-confirm receipt (→ `Done`), and exports the list to CSV.

**Architecture:** Two new Hono endpoints on the existing inventory router — `GET /api/inventory/transfers` (in-transit lines enriched with from→to from their latest `transferred` audit event) and `POST /api/inventory/receive` (bulk `In Transit` → `Done` + `received` audit event). A new `DesktopTransfers` page wired into the hash router and sidebar. CSV is generated client-side from the loaded rows.

**Tech Stack:** Hono + `postgres` (backend, Vitest), React 18 + tiny hash router (frontend, Vitest for pure-function tests), bilingual i18n (en/zh).

Spec: `docs/superpowers/specs/2026-05-15-inventory-receive-transfers-design.md`

---

### Task 1: Backend — `GET /api/inventory/transfers`

**Files:**
- Modify: `apps/backend/src/routes/inventory.ts` (insert a new route immediately **before** the `inventory.get('/:id', ...)` route, currently at line 119 — a GET `/transfers` registered after `/:id` would be shadowed by it)
- Test: `apps/backend/tests/transfers.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/transfers.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

type InvRow = { id: string; status: string; warehouse_id: string | null };
const WAREHOUSES = ['WH-LA1', 'WH-DAL', 'WH-NJ2', 'WH-HK', 'WH-AMS'];

// Transfer one sellable line to a different warehouse, return its id + dest.
async function transferOne(token: string): Promise<{ id: string; from: string; to: string }> {
  const inv = await api<{ items: InvRow[] }>('GET', '/api/inventory', { token });
  const line = inv.body.items.find(
    (i) => (i.status === 'Reviewing' || i.status === 'Done') && i.warehouse_id,
  );
  if (!line) throw new Error('no sellable line in seed');
  const to = WAREHOUSES.find((w) => w !== line.warehouse_id)!;
  const r = await api('POST', '/api/inventory/transfer', {
    token,
    body: { toWarehouseId: to, lines: [{ id: line.id, qty: 1 }] },
  });
  expect(r.status).toBe(200);
  return { id: line.id, from: line.warehouse_id!, to };
}

describe('GET /api/inventory/transfers', () => {
  beforeEach(async () => { await resetDb(); });

  it('403 for non-manager', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('GET', '/api/inventory/transfers', { token });
    expect(r.status).toBe(403);
  });

  it('lists a transferred line with from→to enrichment', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    const r = await api<{ items: { id: string; from_wh: string; to_wh: string }[] }>(
      'GET', '/api/inventory/transfers', { token },
    );
    expect(r.status).toBe(200);
    const row = r.body.items.find((i) => i.id === moved.id);
    expect(row).toBeDefined();
    expect(row!.from_wh).toBe(moved.from);
    expect(row!.to_wh).toBe(moved.to);
  });

  it('excludes In Transit lines that were never transferred (purchase-origin)', async () => {
    const { token } = await loginAs(ALEX);
    const inv = await api<{ items: InvRow[] }>('GET', '/api/inventory', { token });
    const purchaseInTransit = inv.body.items.find((i) => i.status === 'In Transit');
    expect(purchaseInTransit).toBeDefined(); // seed has In Transit purchase lines
    const r = await api<{ items: { id: string }[] }>(
      'GET', '/api/inventory/transfers', { token },
    );
    expect(r.body.items.some((i) => i.id === purchaseInTransit!.id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter recycle-erp-backend test -- transfers`
Expected: FAIL — `GET /api/inventory/transfers` returns 404/200 not matching (route does not exist yet).

- [ ] **Step 3: Implement the endpoint**

In `apps/backend/src/routes/inventory.ts`, find the line `// Single inventory line + its audit log.` directly above `inventory.get('/:id', async (c) => {` (around line 118-119). Insert this route **immediately before** that comment:

```typescript
// In-transit inventory awaiting receipt. Manager-only. Only lines that are
// in transit *because of a transfer* appear here — the LATERAL inner join to
// the latest 'transferred' event excludes purchase-origin In Transit lines
// (whose default status is also 'In Transit' per migration 0001).
inventory.get('/transfers', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT l.id, l.category, l.brand, l.capacity, l.type, l.classification,
           l.rank, l.speed, l.interface, l.form_factor, l.description,
           l.part_number, l.condition, l.qty,
           l.unit_cost::float AS unit_cost, l.sell_price::float AS sell_price,
           l.status,
           COALESCE(l.warehouse_id, o.warehouse_id) AS to_wh,
           w.short  AS to_short,
           te.detail->>'from' AS from_wh,
           fw.short AS from_short,
           te.created_at AS transferred_at,
           te.detail->>'note' AS note,
           act.name AS actor_name, act.initials AS actor_initials
    FROM order_lines l
    JOIN orders o ON o.id = l.order_id
    JOIN LATERAL (
      SELECT e.detail, e.created_at, e.actor_id
      FROM inventory_events e
      WHERE e.order_line_id = l.id AND e.kind = 'transferred'
      ORDER BY e.created_at DESC
      LIMIT 1
    ) te ON TRUE
    LEFT JOIN warehouses w  ON w.id  = COALESCE(l.warehouse_id, o.warehouse_id)
    LEFT JOIN warehouses fw ON fw.id = te.detail->>'from'
    LEFT JOIN users act ON act.id = te.actor_id
    WHERE l.status = 'In Transit'
    ORDER BY te.created_at DESC
    LIMIT 200
  `;
  return c.json({ items: rows });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter recycle-erp-backend test -- transfers`
Expected: PASS (all 3 cases in `GET /api/inventory/transfers`).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/inventory.ts apps/backend/tests/transfers.test.ts
git commit -m "feat(backend): GET /api/inventory/transfers — in-transit lines with from→to"
```

---

### Task 2: Backend — `POST /api/inventory/receive`

**Files:**
- Modify: `apps/backend/src/routes/inventory.ts` (add a POST route immediately after the existing `inventory.post('/transfer', ...)` route, which ends at line 459 with `});`)
- Test: `apps/backend/tests/transfers.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `apps/backend/tests/transfers.test.ts` (reuse `transferOne` defined above):

```typescript
describe('POST /api/inventory/receive', () => {
  beforeEach(async () => { await resetDb(); });

  it('403 for non-manager', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('POST', '/api/inventory/receive', { token, body: { ids: ['x'] } });
    expect(r.status).toBe(403);
  });

  it('400 when ids is empty', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('POST', '/api/inventory/receive', { token, body: { ids: [] } });
    expect(r.status).toBe(400);
  });

  it('moves an in-transit line to Done and removes it from /transfers', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    const recv = await api<{ ok: true; ids: string[] }>(
      'POST', '/api/inventory/receive', { token, body: { ids: [moved.id] } },
    );
    expect(recv.status).toBe(200);
    expect(recv.body.ids).toEqual([moved.id]);

    const after = await api<{ items: { id: string }[] }>(
      'GET', '/api/inventory/transfers', { token },
    );
    expect(after.body.items.some((i) => i.id === moved.id)).toBe(false);

    const inv = await api<{ items: { id: string; status: string }[] }>(
      'GET', '/api/inventory', { token },
    );
    expect(inv.body.items.find((i) => i.id === moved.id)!.status).toBe('Done');
  });

  it('rejects the whole batch if any line is not In Transit', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    const inv = await api<{ items: InvRow[] }>('GET', '/api/inventory', { token });
    const notInTransit = inv.body.items.find(
      (i) => i.status === 'Done' || i.status === 'Reviewing',
    )!;
    const r = await api('POST', '/api/inventory/receive', {
      token, body: { ids: [moved.id, notInTransit.id] },
    });
    expect(r.status).toBe(400);
    // Nothing was written — the in-transit line is still in transit.
    const after = await api<{ items: { id: string }[] }>(
      'GET', '/api/inventory/transfers', { token },
    );
    expect(after.body.items.some((i) => i.id === moved.id)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter recycle-erp-backend test -- transfers`
Expected: FAIL — `POST /api/inventory/receive` route does not exist (404), `receive` describe block fails.

- [ ] **Step 3: Implement the endpoint**

In `apps/backend/src/routes/inventory.ts`, locate the end of the `/transfer` route (the `});` closing `inventory.post('/transfer', ...)`, around line 459). Insert immediately after it:

```typescript
// Bulk receive. Manager-only. Flips In Transit lines to Done and writes a
// 'received' audit event per line. All-or-nothing: one bad line aborts the
// whole batch (mirrors /transfer). The In Transit check is the only guard —
// the Transfers page only ever offers genuinely-transferred lines.
inventory.post('/receive', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);

  const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return c.json({ error: 'ids must be a non-empty array' }, 400);
  }
  const ids: string[] = [];
  for (const raw of body.ids) {
    if (typeof raw !== 'string' || !raw) {
      return c.json({ error: 'each id must be a non-empty string' }, 400);
    }
    ids.push(raw);
  }

  const sql = getDb(c.env);
  const rows = (await sql`
    SELECT l.id, l.status, COALESCE(l.warehouse_id, o.warehouse_id) AS wh
    FROM order_lines l JOIN orders o ON o.id = l.order_id
    WHERE l.id = ANY(${ids}::uuid[])
  `) as unknown as { id: string; status: string; wh: string | null }[];

  if (rows.length !== ids.length) {
    return c.json({ error: 'one or more lines not found' }, 404);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) return c.json({ error: `line ${id} not found` }, 404);
    if (r.status !== 'In Transit') {
      return c.json({ error: `line ${id} is ${r.status}; only In Transit can be received` }, 400);
    }
  }

  await sql.begin(async (tx) => {
    for (const id of ids) {
      const r = byId.get(id)!;
      await tx`UPDATE order_lines SET status = 'Done' WHERE id = ${id}`;
      await tx`
        INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
        VALUES (${id}, ${u.id}, 'received', ${tx.json({ at: r.wh ?? '' })})
      `;
    }
  });

  return c.json({ ok: true, ids });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter recycle-erp-backend test -- transfers`
Expected: PASS (both `transfers` and `receive` describe blocks, 7 cases total).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm --filter recycle-erp-backend typecheck
git add apps/backend/src/routes/inventory.ts apps/backend/tests/transfers.test.ts
git commit -m "feat(backend): POST /api/inventory/receive — bulk In Transit → Done"
```

Expected typecheck: no errors.

---

### Task 3: Frontend — i18n strings (en + zh)

**Files:**
- Modify: `apps/frontend/src/lib/i18n.tsx` (en block near line 216 `nav_inventory`; zh block near line 394 `nav_inventory`)

- [ ] **Step 1: Add the English keys**

In `apps/frontend/src/lib/i18n.tsx`, find the `en:` map line:

```typescript
    nav_sellorders: 'Sell orders',
```

Add directly after it:

```typescript
    nav_transfers: 'Transfers',
    transfersTitle: 'Transfers',
    transfersSubtitle: 'In-transit inventory awaiting receipt at its destination.',
    transfersEmpty: 'Nothing in transit.',
    transfersConfirm: 'Confirm received',
    transfersExport: 'Export CSV',
    transfersColItem: 'Item',
    transfersColQty: 'Qty',
    transfersColFrom: 'From',
    transfersColTo: 'To',
    transfersColDate: 'Transferred',
    transfersColNote: 'Note',
    transfersColBy: 'By',
    transfersReceived: '{n} item(s) received',
    transfersReceiveError: 'Receive failed',
```

- [ ] **Step 2: Add the Chinese keys**

In the same file find the `zh:` nav line:

```typescript
    nav_market: '市场价格', nav_inventory: '库存', nav_sellorders: '销售订单', nav_settings: '设置',
```

Add a new line directly after it:

```typescript
    nav_transfers: '调拨',
    transfersTitle: '调拨', transfersSubtitle: '在途库存，等待目的仓确认收货。',
    transfersEmpty: '没有在途库存。', transfersConfirm: '确认收货', transfersExport: '导出 CSV',
    transfersColItem: '物品', transfersColQty: '数量', transfersColFrom: '调出',
    transfersColTo: '调入', transfersColDate: '调拨时间', transfersColNote: '备注',
    transfersColBy: '操作人', transfersReceived: '已收货 {n} 件', transfersReceiveError: '收货失败',
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/lib/i18n.tsx
git commit -m "i18n: transfers page strings (en + zh)"
```

---

### Task 4: Frontend — router + sidebar + app wiring

**Files:**
- Modify: `apps/frontend/src/lib/route.ts:55-76` (`DESKTOP_VIEW_TO_PATH`, `pathToDesktopView`)
- Modify: `apps/frontend/src/components/Sidebar.tsx:7-18` (`DesktopView` union, `NAV`)
- Modify: `apps/frontend/src/DesktopApp.tsx` (import + purchaser guard line 82 + render switch ~line 129)
- Test: `apps/frontend/tests/route.test.ts` (extend)

- [ ] **Step 1: Write the failing route test**

Append to `apps/frontend/tests/route.test.ts`:

```typescript
describe('pathToDesktopView — transfers', () => {
  it('resolves the transfers path', () => {
    expect(pathToDesktopView('/transfers')).toBe('transfers');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter recycle-erp-frontend test -- route`
Expected: FAIL — `pathToDesktopView('/transfers')` returns `'dashboard'`, not `'transfers'`.

- [ ] **Step 3: Update the router**

In `apps/frontend/src/lib/route.ts`, in `DESKTOP_VIEW_TO_PATH` add the `transfers` entry after `sellorders`:

```typescript
  sellorders: '/sell-orders',
  transfers:  '/transfers',
  settings:   '/settings',
```

In `pathToDesktopView`, add a branch before the `settings` branch:

```typescript
  if (path === '/sell-orders' || match('/sell-orders/:id', path) || match('/sell-orders/:id/edit', path)) return 'sellorders';
  if (path === '/transfers') return 'transfers';
  if (path === '/settings') return 'settings';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter recycle-erp-frontend test -- route`
Expected: PASS (new case + all existing cases unchanged).

- [ ] **Step 5: Update the sidebar**

In `apps/frontend/src/components/Sidebar.tsx`, the `DesktopView` union (lines 7-9) currently ends:

```typescript
  | 'inventory' | 'sellorders' | 'settings';
```

Change to:

```typescript
  | 'inventory' | 'sellorders' | 'transfers' | 'settings';
```

In the `NAV` array, add an entry after the `sellorders` row:

```typescript
  { id: 'sellorders', tKey: 'nav_sellorders', icon: 'tag',        roles: ['manager'] },
  { id: 'transfers',  tKey: 'nav_transfers',  icon: 'truck',      roles: ['manager'] },
  { id: 'settings',   tKey: 'nav_settings',   icon: 'settings',   roles: ['manager'] },
```

- [ ] **Step 6: Wire DesktopApp**

In `apps/frontend/src/DesktopApp.tsx`, add the import after the `DesktopSellOrders` import (line 21):

```typescript
import { DesktopSellOrders } from './pages/desktop/DesktopSellOrders';
import { DesktopTransfers } from './pages/desktop/DesktopTransfers';
```

Update the purchaser-redirect guard (line 82) to also bounce `transfers`:

```typescript
  const view2: DesktopView = user.role === 'purchaser' && (view === 'inventory' || view === 'sellorders' || view === 'transfers' || view === 'settings')
```

In the render switch, add a branch after the `sellorders` block (after line 132 `)}`):

```typescript
          {view2 === 'transfers' && <DesktopTransfers onToast={showToast} />}
```

> Note: `DesktopTransfers` does not exist yet (Task 5). Steps 5-6 will not typecheck until Task 5 is complete — that is expected; commit happens after Task 5.

- [ ] **Step 7: Commit (router + test only — typecheck-clean on their own)**

```bash
git add apps/frontend/src/lib/route.ts apps/frontend/tests/route.test.ts
git commit -m "feat(frontend): route /transfers → transfers view"
```

(Sidebar.tsx and DesktopApp.tsx are committed in Task 5 once the page exists and the build is green.)

---

### Task 5: Frontend — `DesktopTransfers` page

**Files:**
- Create: `apps/frontend/src/pages/desktop/DesktopTransfers.tsx`
- Reference: `apps/frontend/src/pages/desktop/DesktopInventory.tsx` (page-head/btn markup), `apps/frontend/src/lib/api.ts` (`api.get`/`api.post`), `apps/frontend/src/lib/i18n.tsx` (`useLang().t`)

- [ ] **Step 1: Create the page component**

Create `apps/frontend/src/pages/desktop/DesktopTransfers.tsx`:

```typescript
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useLang } from '../../lib/i18n';
import { Icon } from '../../components/Icon';

type TransferRow = {
  id: string;
  category: string;
  brand: string | null;
  capacity: string | null;
  type: string | null;
  description: string | null;
  part_number: string | null;
  qty: number;
  to_wh: string | null;
  to_short: string | null;
  from_wh: string | null;
  from_short: string | null;
  transferred_at: string;
  note: string | null;
  actor_name: string | null;
};

type Props = {
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
};

function rowLabel(r: TransferRow): string {
  return [r.brand, r.capacity, r.type, r.part_number]
    .filter(Boolean)
    .join(' ') || r.description || r.category;
}

function downloadCsv(rows: TransferRow[]): void {
  const head = ['Item', 'Qty', 'From', 'To', 'Transferred', 'Note', 'By'];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = rows.map((r) =>
    [
      rowLabel(r),
      String(r.qty),
      r.from_short ?? r.from_wh ?? '',
      r.to_short ?? r.to_wh ?? '',
      new Date(r.transferred_at).toISOString(),
      r.note ?? '',
      r.actor_name ?? '',
    ]
      .map((c) => esc(String(c)))
      .join(','),
  );
  const csv = [head.map(esc).join(','), ...lines].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `transfers-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function DesktopTransfers({ onToast }: Props = {}) {
  const { t } = useLang();
  const [rows, setRows] = useState<TransferRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const load = () => {
    api
      .get<{ items: TransferRow[] }>('/api/inventory/transfers')
      .then((r) => { setRows(r.items); setSelected(new Set()); })
      .catch((e) => onToast?.(String(e), 'error'));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Group rows under a "from → to" batch header.
  const groups = useMemo(() => {
    const m = new Map<string, TransferRow[]>();
    for (const r of rows) {
      const key = `${r.from_short ?? r.from_wh ?? '?'} → ${r.to_short ?? r.to_wh ?? '?'}`;
      (m.get(key) ?? m.set(key, []).get(key)!).push(r);
    }
    return [...m.entries()];
  }, [rows]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const confirmReceived = async () => {
    if (!selected.size) return;
    setBusy(true);
    try {
      const ids = [...selected];
      await api.post<{ ok: true; ids: string[] }>('/api/inventory/receive', { ids });
      onToast?.(t('transfersReceived', { n: ids.length }));
      load();
    } catch (e) {
      onToast?.(t('transfersReceiveError') + ': ' + String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('transfersTitle')}</h1>
          <div className="page-sub">{t('transfersSubtitle')}</div>
        </div>
        <div className="page-actions">
          <button className="btn" disabled={!rows.length} onClick={() => downloadCsv(rows)}>
            <Icon name="download" size={14} /> {t('transfersExport')}
          </button>
          <button
            className="btn accent"
            disabled={!selected.size || busy}
            onClick={confirmReceived}
          >
            <Icon name="check" size={14} /> {t('transfersConfirm')}
            {selected.size > 0 && (
              <span style={{
                marginLeft: 4, padding: '1px 7px',
                background: 'rgba(255,255,255,0.22)', borderRadius: 999,
                fontSize: 11, fontWeight: 600,
              }}>{selected.size}</span>
            )}
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="page-sub" style={{ padding: 24 }}>{t('transfersEmpty')}</div>
      ) : (
        groups.map(([label, grp]) => (
          <div key={label} style={{ marginBottom: 20 }}>
            <div className="nav-section" style={{ marginBottom: 6 }}>
              <Icon name="truck" size={12} /> {label} · {grp.length}
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 28 }}></th>
                  <th>{t('transfersColItem')}</th>
                  <th style={{ textAlign: 'right' }}>{t('transfersColQty')}</th>
                  <th>{t('transfersColDate')}</th>
                  <th>{t('transfersColNote')}</th>
                  <th>{t('transfersColBy')}</th>
                </tr>
              </thead>
              <tbody>
                {grp.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => toggle(r.id)}
                      />
                    </td>
                    <td>{rowLabel(r)}</td>
                    <td style={{ textAlign: 'right' }}>{r.qty}</td>
                    <td>{new Date(r.transferred_at).toLocaleDateString()}</td>
                    <td>{r.note ?? ''}</td>
                    <td>{r.actor_name ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </>
  );
}
```

- [ ] **Step 2: Verify the Icon import path and `useLang` export**

Run: `grep -n "export function Icon\|export type IconName" apps/frontend/src/components/Icon.tsx && grep -n "export function useLang\|export const useLang" apps/frontend/src/lib/i18n.tsx`
Expected: both symbols exist. If `Icon` lives elsewhere or `useLang` is named differently, adjust the two import lines in `DesktopTransfers.tsx` to match (mirror how `DesktopInventory.tsx` imports them — check its import block).

- [ ] **Step 3: Confirm the `check` and `truck` icon names exist**

Run: `grep -n "truck\|'check'\|\"check\"" apps/frontend/src/components/Icon.tsx | head`
Expected: both `truck` and `check` are defined icon names (the existing Transfer button uses `truck`; the workflow "Done" stage uses `check`). If `check` is not a valid `IconName`, use the name the `done` workflow stage uses in `apps/frontend/src/lib/status.ts:25` (`icon: 'check'`) — confirm and align.

- [ ] **Step 4: Typecheck + build the frontend**

Run: `pnpm --filter recycle-erp-frontend typecheck && pnpm --filter recycle-erp-frontend build`
Expected: no type errors; build succeeds. This now also validates the Task 4 Sidebar.tsx + DesktopApp.tsx edits (which reference `DesktopTransfers`).

- [ ] **Step 5: Commit (page + the deferred Task 4 wiring)**

```bash
git add apps/frontend/src/pages/desktop/DesktopTransfers.tsx \
        apps/frontend/src/components/Sidebar.tsx \
        apps/frontend/src/DesktopApp.tsx
git commit -m "feat(frontend): Transfers page — list, bulk receive, CSV export"
```

---

### Task 6: Activity drawer — `received` event kind

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopActivityDrawer.tsx:28` (`Filter` type), `:30-35` (`ACTION_META`), `:136` (filter pill list), `:242-246` (summary), `:63` (counter init)

- [ ] **Step 1: Add `received` to the filter type and counter**

In `apps/frontend/src/pages/desktop/DesktopActivityDrawer.tsx`, change line 28:

```typescript
type Filter = 'all' | 'created' | 'status' | 'edited' | 'priced' | 'transferred';
```

to:

```typescript
type Filter = 'all' | 'created' | 'status' | 'edited' | 'priced' | 'transferred' | 'received';
```

Change the counter init (line 63):

```typescript
    const c: Record<string, number> = { all: 0, created: 0, status: 0, edited: 0, priced: 0, transferred: 0 };
```

to:

```typescript
    const c: Record<string, number> = { all: 0, created: 0, status: 0, edited: 0, priced: 0, transferred: 0, received: 0 };
```

- [ ] **Step 2: Add the `received` action metadata**

In `ACTION_META` (after the `transferred` line, ~line 35), add:

```typescript
  transferred: { icon: 'truck', label: 'Transferred', dot: 'var(--info)' },
  received:    { icon: 'check', label: 'Received',    dot: 'var(--pos)' },
```

- [ ] **Step 3: Add `received` to the filter pill list**

Line 136 — change:

```typescript
            {(['all', 'created', 'status', 'edited', 'priced', 'transferred'] as Filter[]).map(f => (
```

to:

```typescript
            {(['all', 'created', 'status', 'edited', 'priced', 'transferred', 'received'] as Filter[]).map(f => (
```

- [ ] **Step 4: Add the summary label**

In `EventCard`'s `summary` chain (~line 242-246), add a `received` case after `transferred`:

```typescript
    : event.kind === 'transferred' ? 'Transferred'
    : event.kind === 'received'    ? 'Received'
    : event.kind === 'edited'      ? `${String(d.field ?? 'Field')} updated`
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopActivityDrawer.tsx
git commit -m "feat(frontend): show 'received' events in the activity drawer"
```

---

### Task 7: Fix stale status copy on the Inventory page

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopInventory.tsx:267`

- [ ] **Step 1: Replace the stale copy**

In `apps/frontend/src/pages/desktop/DesktopInventory.tsx`, line 267 reads:

```typescript
              ? 'Pick items across warehouses to create a sell order. Select rows in Ready or Selling status.'
```

The statuses `Ready`/`Selling` do not exist (`apps/frontend/src/lib/status.ts:9` defines `Draft | In Transit | Reviewing | Done`; `isSellable` = `Reviewing | Done`). Replace with:

```typescript
              ? 'Pick items across warehouses to create a sell order. Select rows in Reviewing or Done status.'
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter recycle-erp-frontend typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopInventory.tsx
git commit -m "fix(frontend): correct stale status names in inventory page subtitle"
```

---

### Final verification

- [ ] **Run the whole backend suite** (shared DB — full run catches regressions):

Run: `pnpm --filter recycle-erp-backend test`
Expected: all suites PASS, including the new `transfers.test.ts`.

- [ ] **Run the frontend tests + build:**

Run: `pnpm --filter recycle-erp-frontend test && pnpm -r run typecheck && pnpm --filter recycle-erp-frontend build`
Expected: route tests PASS, no type errors anywhere, build succeeds.

- [ ] **Manual smoke (optional, requires `pnpm dev`):** Log in as a manager → Inventory → select a `Reviewing`/`Done` row → Transfer to another warehouse. Open the new **Transfers** sidebar item → the line appears under its `from → to` group → select it → **Confirm received** → toast shows, row disappears, line is now `Done` in Inventory. **Export CSV** downloads a well-formed file. Confirm the **Transfers** nav item is absent for a purchaser login.
