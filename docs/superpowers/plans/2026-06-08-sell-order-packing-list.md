# Sell Order Packing List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-sell-order printable packing-list PDF, downloadable from the sell-order detail view, grouped by warehouse and showing qty/item/part-number with a hand-tick checkbox.

**Architecture:** A new backend route `GET /api/sell-orders/:id/packing-list` (manager-only, like every route in that file) reads the order head + lines, groups lines by warehouse in JS, and streams a PDF built by a new `buildSellOrderPackingListPdf` in `lib/pdf.ts` that reuses the existing `renderPdfToBuffer`/`loadInvoiceLogo` machinery. The desktop sell-order detail modal gets a "Packing list" button that calls the existing `api.download` helper.

**Tech Stack:** Hono (backend routes), pdfkit (lazy-loaded in `lib/pdf.ts`), postgres.js, React + `useT()` i18n, Vitest integration tests against real Postgres.

---

## File Structure

- **Modify** `apps/backend/src/lib/pdf.ts` — add `PackingLine`/`PackingGroup`/`PackingListData` types and `buildSellOrderPackingListPdf`. Reuses `renderPdfToBuffer`, `loadInvoiceLogo`, `pdfResponse`, and the palette constants already in the file.
- **Modify** `apps/backend/src/routes/sellOrders.ts` — import the new builder + `pdfResponse` + `loadInvoiceLogo`; add the `/:id/packing-list` route.
- **Create** `apps/backend/tests/sell-order-packing-list.test.ts` — integration tests (mirrors `tests/po-invoice.test.ts`).
- **Modify** `apps/frontend/src/lib/i18n.tsx` — add `soPackingList` + `soPackingListTooltip` keys in EN and ZH.
- **Modify** `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` — add the download button to the `SellOrderDetail` footer button group.

---

## Task 1: PDF builder in `lib/pdf.ts`

**Files:**
- Modify: `apps/backend/src/lib/pdf.ts` (add types + `buildSellOrderPackingListPdf`; the existing `renderPdfToBuffer`, `loadInvoiceLogo`, `pdfResponse`, and palette constants `PEACH`/`ORANGE`/`BURNT`/`INK`/`MUTED`/`RULE`/`ZEBRA` stay as-is)

The builder is exercised end-to-end by the integration test in Task 3 (the buffer must start with `%PDF-`), so there is no separate unit test for it — that matches how `buildPoInvoicePdf` is covered by `po-invoice.test.ts`.

- [ ] **Step 1: Add the data types**

Add these exported types directly below the existing `InvoiceData` type (after line ~93 in `apps/backend/src/lib/pdf.ts`):

```ts
export type PackingLine = {
  qty: number;
  label: string;
  sub: string;          // sub-label, '' when none
  partNumber: string;   // '' when none
};

export type PackingGroup = {
  warehouse: string;    // warehouse short code, or 'Unassigned'
  lines: PackingLine[];
};

export type PackingListData = {
  company: string;
  soId: string;
  date: string;         // YYYY-MM-DD
  customer: string;     // customer name
  customerShort: string;
  groups: PackingGroup[];
  logoPng: Buffer | null;
};
```

- [ ] **Step 2: Add the builder function**

Append this function to the end of `apps/backend/src/lib/pdf.ts`. It reuses `renderPdfToBuffer`, `loadInvoiceLogo` (called by the route, passed in via `logoPng`), and the palette constants already declared at the top of the file. The checkbox is drawn as a stroked square (the WinAnsi Helvetica encoding has no ☐ glyph, so a real rectangle is used).

```ts
// Packing list — price-free pick/pack sheet for warehouse staff. Lines arrive
// pre-grouped by warehouse; each group is a section with a stroked-square
// checkbox column to tick off by hand. Reuses the invoice header/logo treatment
// so the two documents look like a set.
const P = {
  check: { x: 44,  box: 11 },
  qty:   { x: 66,  w: 44 },
  item:  { x: 118, w: 287 },
  part:  { x: 415, w: 140 },
};

export function buildSellOrderPackingListPdf(d: PackingListData): Promise<Buffer> {
  return renderPdfToBuffer((doc) => {
    const PW = doc.page.width;
    const L = doc.page.margins.left;
    const R = PW - doc.page.margins.right;
    const W = R - L;
    const PAGE_BOTTOM = doc.page.height - 56;

    // ── Header band ──────────────────────────────────────────────────────────
    const bandH = 116;
    doc.rect(0, 0, PW, bandH).fill(PEACH);

    let logoBottom = 38;
    if (d.logoPng) {
      try {
        doc.image(d.logoPng, L, 30, { fit: [150, 56], valign: 'center' });
        logoBottom = 30 + 56;
      } catch {
        doc.fillColor(ORANGE).font('Helvetica-Bold').fontSize(26)
          .text(d.company || 'Packing List', L, 38, { width: W * 0.56 });
        logoBottom = doc.y;
      }
    } else {
      doc.fillColor(ORANGE).font('Helvetica-Bold').fontSize(26)
        .text(d.company || 'Packing List', L, 38, { width: W * 0.56 });
      logoBottom = doc.y;
    }
    doc.fillColor(BURNT).font('Helvetica-Bold').fontSize(10)
      .text(d.company || '', L, logoBottom + 4, { width: W * 0.56 });

    // Title + sell-order id (right-aligned inside the band).
    doc.fillColor(BURNT).font('Helvetica-Bold').fontSize(22)
      .text('Packing List', L, 38, { width: W, align: 'right' });
    doc.fillColor(INK).font('Helvetica').fontSize(12)
      .text(d.soId, L, 66, { width: W, align: 'right' });

    // ── Meta row: customer + date ────────────────────────────────────────────
    let y = bandH + 18;
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(BURNT).text('Customer', L, y);
    const customerText = d.customerShort
      ? `${d.customer} (${d.customerShort})`
      : (d.customer || '—');
    doc.font('Helvetica').fontSize(11).fillColor(INK).text(customerText, L, y + 15, { width: W * 0.6 });

    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(BURNT)
      .text('Date', L + W * 0.6, y, { width: W * 0.4, align: 'right' });
    doc.font('Helvetica').fontSize(11).fillColor(INK)
      .text(d.date || '—', L + W * 0.6, y + 15, { width: W * 0.4, align: 'right' });
    y += 48;

    const drawColHead = (yy: number): number => {
      doc.font('Helvetica').fontSize(9.5).fillColor(MUTED);
      doc.text('Packed', P.check.x - 4, yy, { width: 40 });
      doc.text('Qty', P.qty.x, yy, { width: P.qty.w, align: 'right' });
      doc.text('Item', P.item.x, yy, { width: P.item.w });
      doc.text('Part #', P.part.x, yy, { width: P.part.w });
      const ny = yy + 16;
      doc.moveTo(L, ny).lineTo(R, ny).lineWidth(1).strokeColor(RULE).stroke();
      return ny + 6;
    };

    const drawSectionHead = (yy: number, warehouse: string): number => {
      doc.rect(L, yy, W, 22).fill(ZEBRA);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(BURNT)
        .text(`Warehouse: ${warehouse}`, L + 8, yy + 5, { width: W - 16 });
      return yy + 30;
    };

    d.groups.forEach((g) => {
      if (y + 60 > PAGE_BOTTOM) { doc.addPage(); y = doc.page.margins.top; }
      y = drawSectionHead(y, g.warehouse);
      y = drawColHead(y);

      g.lines.forEach((l, i) => {
        const sub = l.sub || '';
        doc.font('Helvetica').fontSize(10.5);
        const labelH = doc.heightOfString(l.label || '—', { width: P.item.w });
        const subH = sub ? doc.heightOfString(sub, { width: P.item.w }) + 1 : 0;
        const rowH = Math.max(labelH + subH, 16) + 12;

        if (y + rowH > PAGE_BOTTOM) {
          doc.addPage();
          y = doc.page.margins.top;
          y = drawColHead(y);
        }

        if (i % 2 === 0) doc.rect(L, y - 4, W, rowH).fill(ZEBRA);

        const ty = y + 2;
        // Checkbox: a stroked square (no reliable ☐ glyph in core fonts).
        doc.lineWidth(1).strokeColor(INK)
          .rect(P.check.x, ty + 1, P.check.box, P.check.box).stroke();
        doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
          .text(String(l.qty), P.qty.x, ty, { width: P.qty.w, align: 'right' });
        doc.font('Helvetica').fontSize(10.5).fillColor(INK)
          .text(l.label || '—', P.item.x, ty, { width: P.item.w });
        if (sub) doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
          .text(sub, P.item.x, doc.y + 1, { width: P.item.w });
        doc.font('Helvetica').fontSize(10).fillColor(INK)
          .text(l.partNumber || '—', P.part.x, ty, { width: P.part.w });
        y += rowH;
      });

      y += 12;
    });

    if (d.groups.length === 0) {
      doc.font('Helvetica').fontSize(11).fillColor(MUTED)
        .text('This order has no line items to pack.', L, y);
    }
  });
}
```

- [ ] **Step 3: Verify the file typechecks**

Run: `cd apps/backend && npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (If the project has no per-package tsconfig for `tsc`, fall back to `pnpm typecheck` from the repo root — expected: passes.)

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/lib/pdf.ts
git commit -m "feat(sell-orders): packing-list PDF builder"
```

---

## Task 2: Backend route `GET /api/sell-orders/:id/packing-list`

**Files:**
- Modify: `apps/backend/src/routes/sellOrders.ts` (add import; add route after the existing `GET /:id` handler, which ends around line 303)

- [ ] **Step 1: Add the import**

At the top of `apps/backend/src/routes/sellOrders.ts`, directly below the existing xlsx import (line 15: `import { buildXlsxBuffer, ... } from '../lib/xlsx';`), add:

```ts
import { buildSellOrderPackingListPdf, pdfResponse, loadInvoiceLogo } from '../lib/pdf';
```

- [ ] **Step 2: Add the route handler**

Insert this handler immediately after the closing `});` of the `sellOrders.get('/:id', …)` handler (around line 303, before the `sellOrders.post('/', …)` create handler). It re-queries head + lines (only the packing-relevant columns, no prices), groups by warehouse in JS, and streams the PDF.

```ts
// Packing list — a price-free, printable pick/pack sheet for warehouse staff.
// Lines are grouped by warehouse; lines with no warehouse fall into an
// "Unassigned" group that sorts last. Manager-only like every route here.
sellOrders.get('/:id/packing-list', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const sql = getDb(c.env);

  const head = (await sql<{
    id: string; created_at: string;
    customer_name: string; customer_short: string;
  }[]>`
    SELECT so.id, so.created_at, c.name AS customer_name, c.short_name AS customer_short
    FROM sell_orders so JOIN customers c ON c.id = so.customer_id
    WHERE so.id = ${id} LIMIT 1
  `)[0];
  if (!head) return c.json({ error: 'Not found' }, 404);

  const lines = await sql<{
    label: string; sub_label: string | null; part_number: string | null;
    qty: number; warehouse_short: string | null; position: number;
  }[]>`
    SELECT sol.label, sol.sub_label, sol.part_number, sol.qty,
           w.short AS warehouse_short, sol.position
    FROM sell_order_lines sol
    LEFT JOIN warehouses w ON w.id = sol.warehouse_id
    WHERE sol.sell_order_id = ${id}
    ORDER BY sol.position
  `;

  // Group by warehouse, preserving line order within each group. 'Unassigned'
  // sorts last; everything else alphabetically by warehouse code.
  const UNASSIGNED = 'Unassigned';
  const byWarehouse = new Map<string, typeof lines>();
  for (const l of lines) {
    const key = l.warehouse_short ?? UNASSIGNED;
    if (!byWarehouse.has(key)) byWarehouse.set(key, []);
    byWarehouse.get(key)!.push(l);
  }
  const groups = [...byWarehouse.keys()]
    .sort((a, b) => {
      if (a === UNASSIGNED) return 1;
      if (b === UNASSIGNED) return -1;
      return a.localeCompare(b);
    })
    .map((warehouse) => ({
      warehouse,
      lines: byWarehouse.get(warehouse)!.map((l) => ({
        qty: l.qty,
        label: l.label,
        sub: l.sub_label ?? '',
        partNumber: l.part_number ?? '',
      })),
    }));

  const company = await getWorkspaceSetting<string>(sql, 'workspace_name', 'Recycle Servers');

  const buf = await buildSellOrderPackingListPdf({
    company,
    soId: head.id,
    date: new Date(head.created_at).toISOString().slice(0, 10),
    customer: head.customer_name,
    customerShort: head.customer_short ?? '',
    groups,
    logoPng: loadInvoiceLogo(),
  });

  return pdfResponse(buf, `${head.id}-packing-list.pdf`);
});
```

- [ ] **Step 3: Confirm `getWorkspaceSetting` is imported**

Run: `cd apps/backend && grep -n "getWorkspaceSetting" src/routes/sellOrders.ts`
Expected: at least one match in an existing `import` line near the top. If there is NO existing import (only the new usage shows), add it to the settings import — check how `orders.ts` imports it:

Run: `grep -n "getWorkspaceSetting" src/routes/orders.ts`
Then mirror that exact import in `sellOrders.ts` (e.g. add `getWorkspaceSetting` to the existing `from '../lib/settings'` import, which currently imports `getUploadLimits`).

- [ ] **Step 4: Typecheck**

Run: `cd apps/backend && npx tsc --noEmit -p tsconfig.json` (or `pnpm typecheck` from repo root)
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/routes/sellOrders.ts
git commit -m "feat(sell-orders): packing-list PDF endpoint"
```

---

## Task 3: Backend integration tests

**Files:**
- Create: `apps/backend/tests/sell-order-packing-list.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/sell-order-packing-list.test.ts` with this content. It builds a real sell order via the seed's free sellable inventory + first customer (same pattern as `sell-orders.test.ts`), then asserts the PDF stream, the 404, and the non-manager 403.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

function getRaw(path: string, token: string): Promise<Response> {
  return app.fetch(
    new Request('http://test' + path, {
      headers: { cookie: `at=${token}`, 'X-Requested-By': 'recycle-erp' },
    }),
    testEnv,
  );
}

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  expect(r.status).toBe(200);
  expect(r.body.items.length).toBeGreaterThan(0);
  return r.body.items[0].id;
}

async function createSellOrder(token: string): Promise<string> {
  const line = await freeSellableLine(token);
  const customerId = await firstCustomerId(token);
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: {
      customerId,
      lines: [{
        inventoryId: line.id, category: 'RAM', label: 'Sample DIMM',
        partNumber: 'PN-PACK-1', qty: 2, unitPrice: line.sell_price,
        warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
      }],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

describe('GET /api/sell-orders/:id/packing-list', () => {
  beforeEach(async () => { await resetDb(); });

  it('streams a PDF document for a manager', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createSellOrder(token);

    const res = await getRaw(`/api/sell-orders/${id}/packing-list`, token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('packing-list.pdf');

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(500);
  });

  it('404s an unknown sell order', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/sell-orders/SO-does-not-exist/packing-list', token);
    expect(res.status).toBe(404);
  });

  it('forbids a non-manager', async () => {
    const mgr = await loginAs(ALEX);
    const id = await createSellOrder(mgr.token);

    const pur = await loginAs(MARCUS);
    const res = await getRaw(`/api/sell-orders/${id}/packing-list`, pur.token);
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (route not yet present? No — route exists from Task 2, so it should PASS)**

This plan implements the route before the test, so this is a verification run, not a red-phase run.

Run: `cd apps/backend && npx vitest run tests/sell-order-packing-list.test.ts`
Expected: 3 passed.

(Note from CLAUDE.md: run the single file with `npx vitest run tests/<file>` from `apps/backend` — `pnpm --filter … test -- <path>` silently runs the whole suite. The DB must be reachable at `127.0.0.1:5432`; `docker-compose.override.yml` provides it locally.)

- [ ] **Step 3: If any test fails, debug against the helpers**

If `freeSellableLine` or the `WH-LA1` warehouse id doesn't match the current seed, confirm the exact values used by the existing passing test:

Run: `cd apps/backend && grep -rn "WH-LA1\|freeSellableLine" tests/sell-orders.test.ts tests/helpers/inventory.ts`
Adjust the `warehouseId` / line shape in the test to match what `sell-orders.test.ts` already uses successfully, then re-run Step 2.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/tests/sell-order-packing-list.test.ts
git commit -m "test(sell-orders): packing-list endpoint integration tests"
```

---

## Task 4: i18n strings

**Files:**
- Modify: `apps/frontend/src/lib/i18n.tsx` (EN block ~line 782, ZH block ~line 2019)

- [ ] **Step 1: Add the EN keys**

In `apps/frontend/src/lib/i18n.tsx`, find the EN line `soReopenTooltip: 'Reopen this sell order',` (~line 782) and add two keys directly after it:

```ts
    soPackingList: 'Packing list',
    soPackingListTooltip: 'Download a printable packing list',
```

- [ ] **Step 2: Add the ZH keys**

Find the ZH line `soReopenTooltip: '重新打开此销售订单',` (~line 2019) and add directly after it:

```ts
    soPackingList: '装箱单',
    soPackingListTooltip: '下载可打印的装箱单',
```

- [ ] **Step 3: Typecheck the frontend**

Run: `pnpm --filter recycle-erp-frontend typecheck` (or `pnpm typecheck` from repo root)
Expected: no errors. (The i18n catalog is keyed by a shared type union; adding the same key to both EN and ZH keeps them balanced — if one side is missing the key, typecheck fails, which is the intended guard.)

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/lib/i18n.tsx
git commit -m "i18n(sell-orders): packing-list button strings (EN+ZH)"
```

---

## Task 5: Desktop download button

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` (the `SellOrderDetail` footer button group at ~line 924)

- [ ] **Step 1: Add the button as the first item in the footer button group**

In `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx`, find the footer button-group container (around line 924):

```tsx
            <div style={{ display: 'flex', gap: 8 }}>
              {editable && order.status !== 'Draft' && order.archivedAt === null && (
```

Insert the packing-list button as the FIRST child of that `<div>`, before the Archive button. It is always shown (any status, view or edit mode), uses the existing `api.download` helper, and reports errors via the existing `handleFetchError`:

```tsx
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn"
                title={t('soPackingListTooltip')}
                onClick={async () => {
                  try {
                    await api.download(
                      `/api/sell-orders/${order.id}/packing-list`,
                      `${order.id}-packing-list.pdf`,
                    );
                  } catch (e) {
                    handleFetchError(e);
                  }
                }}
              >
                <Icon name="download" size={14} /> {t('soPackingList')}
              </button>
              {editable && order.status !== 'Draft' && order.archivedAt === null && (
```

- [ ] **Step 2: Confirm `api`, `Icon`, `handleFetchError`, and `t` are already in scope**

Run: `cd apps/frontend && grep -n "import { api\|import { Icon\|handleFetchError\|const { lang, t } = useT" src/pages/desktop/DesktopSellOrders.tsx`
Expected: `api` and `Icon` are already imported (the existing export button at line 218 uses both), `handleFetchError` is already used in `runExport`, and `t` is destructured in `SellOrderDetail` (line 419). No new imports needed. If any are missing, add the import mirroring the existing usages in the same file.

- [ ] **Step 3: Typecheck the frontend**

Run: `pnpm --filter recycle-erp-frontend typecheck` (or `pnpm typecheck` from repo root)
Expected: no errors.

- [ ] **Step 4: Build the frontend to confirm the chunk compiles**

Run: `pnpm --filter recycle-erp-frontend build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSellOrders.tsx
git commit -m "feat(sell-orders): packing-list download button in detail view"
```

---

## Task 6: Full verification + release

**Files:** none (verification + release tooling)

- [ ] **Step 1: Run the new backend test once more + the broader sell-order suite**

Run: `cd apps/backend && npx vitest run tests/sell-order-packing-list.test.ts tests/sell-orders.test.ts`
Expected: all pass. (If unrelated tests in the broad suite flake, suspect the shared-DB harness per CLAUDE.md, not this change.)

- [ ] **Step 2: Repo-wide typecheck**

Run: `pnpm typecheck`
Expected: passes across the workspace.

- [ ] **Step 3: Cut the release**

This feature ships as its own SemVer release (minor — a new feature) per the repo convention.

Run: `bash scripts/release.sh minor` (or follow the exact invocation documented in the release memory / `scripts/release.sh --help`)
Expected: root `package.json` version bumped, `CHANGELOG.md` regenerated with the packing-list feature, tag created.

- [ ] **Step 4: Confirm the CHANGELOG mentions the packing list**

Run: `git show --stat HEAD && grep -n -i "packing" CHANGELOG.md`
Expected: the new release section references the sell-order packing list. If `release.sh` didn't capture it (commits not in the changelog range), add an entry manually and amend.

- [ ] **Step 5: Push (only when the user asks)**

Per the user's workflow, commits land directly on `main`. Push when the user confirms:

```bash
git push origin main --follow-tags
```

---

## Self-Review

**Spec coverage:**
- Per-order PDF endpoint, manager-only, any status, 404 unknown → Task 2 + Task 3. ✓
- Price-free, grouped by warehouse, Qty/Item/Part# + packed checkbox → Task 1 (`buildSellOrderPackingListPdf`). ✓
- "Unassigned" group sorts last → Task 2 grouping sort. ✓
- Frontend button in detail modal footer using `api.download` → Task 5. ✓
- EN+ZH strings → Task 4. ✓
- Tests (200/pdf, 404, 403) → Task 3. ✓
- Release + CHANGELOG → Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `PackingListData`/`PackingGroup`/`PackingLine` defined in Task 1 are constructed exactly with those field names (`qty`, `label`, `sub`, `partNumber`, `warehouse`, `groups`, `soId`, `customer`, `customerShort`, `date`, `company`, `logoPng`) in Task 2. The endpoint path `/:id/packing-list`, the download filename suffix `-packing-list.pdf`, and the i18n keys `soPackingList`/`soPackingListTooltip` match across Tasks 2, 3, 4, and 5. ✓
