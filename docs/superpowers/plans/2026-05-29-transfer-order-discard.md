# Transfer-Order Discard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a manager discard a *Pending* transfer order — undoing the inventory move (lines return to origin, partial splits re-merge) and deleting the TO record.

**Architecture:** A new manager-only `DELETE /api/inventory/transfer-orders/:id` handler reverses the move inside one locked `sql.begin` transaction, then deletes the `transfer_orders` row. Full-move lines flip back in place; partial-clone lines (identified by `peer_line_id` in their `transferred` event) merge their qty back into the source remainder and are deleted. The create endpoint additionally stamps `prior_status` so reverted lines return to their exact pre-transfer status. Frontend adds a danger-styled **Discard** button on Pending rows behind a confirm modal.

**Tech Stack:** Hono + postgres.js (backend), Vitest integration tests against real Postgres, React + TypeScript (frontend), bilingual i18n (EN/ZH).

---

## File Structure

- `apps/backend/src/routes/inventory.ts` — **Modify.** Add `prior_status` to the two `transferred` event details in `POST /transfer`; add the new `DELETE /transfer-orders/:id` handler before `export default inventory`.
- `apps/backend/tests/transfer-orders.test.ts` — **Modify.** Add a discard `describe` block.
- `apps/frontend/src/lib/api.ts` — **Modify.** Add `discardTransferOrder`.
- `apps/frontend/src/pages/desktop/DesktopTransfers.tsx` — **Modify.** Discard button + confirm modal + handler.
- `apps/frontend/src/lib/i18n.tsx` — **Modify.** EN + ZH keys.

Single-file backend route (transfers live inside `inventory.ts`, not a separate `transfers.ts`) — follow that existing placement; do not create new files.

---

## Task 1: Stamp `prior_status` into transfer events

The discard reversal restores a line's pre-transfer status. That status (`Reviewing` or `Done`) isn't recorded today, so add it to the `transferred` event detail now. Discard falls back to `'Done'` for transfers created before this ships.

**Files:**
- Modify: `apps/backend/src/routes/inventory.ts` (full-move event ~line 974-978; partial `detail` object ~line 1006)
- Test: `apps/backend/tests/transfer-orders.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('POST /api/inventory/transfer — creates a transfer order', …)` block (after the first `it`):

```ts
  it('records prior_status on the transferred event', async () => {
    const { token } = await loginAs(ALEX);
    const db = getTestDb();
    const before = (await db`
      SELECT l.id, l.status, l.qty, COALESCE(l.warehouse_id, o.warehouse_id) AS wh
      FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.status IN ('Reviewing','Done') AND COALESCE(l.warehouse_id, o.warehouse_id) IS NOT NULL
      LIMIT 1
    `)[0] as { id: string; status: string; qty: number; wh: string };
    const to = WAREHOUSES.find((w) => w !== before.wh)!;
    const r = await api<{ ok: true; transferOrderId: string }>(
      'POST', '/api/inventory/transfer',
      { token, body: { toWarehouseId: to, lines: [{ id: before.id, qty: before.qty }] } },
    );
    expect(r.status).toBe(200);
    const ev = (await db`
      SELECT detail FROM inventory_events
      WHERE order_line_id = ${before.id} AND kind = 'transferred' ORDER BY created_at DESC LIMIT 1
    `)[0] as { detail: Record<string, unknown> };
    expect(ev.detail.prior_status).toBe(before.status);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/backend && npx vitest run tests/transfer-orders.test.ts -t "records prior_status"`
Expected: FAIL — `expected undefined to be 'Done'` (or `'Reviewing'`).

- [ ] **Step 3: Add `prior_status` to the full-move event detail**

In `inventory.ts`, the full-move branch (`if (r.qty === s.qty)`), change the `transferred` event insert detail from:

```ts
          ${tx.json({ from: fromWh, to: toWarehouseId, qty: r.qty, transfer_order_id: transferOrderId, ...(note ? { note } : {}) })})
```

to:

```ts
          ${tx.json({ from: fromWh, to: toWarehouseId, qty: r.qty, transfer_order_id: transferOrderId, prior_status: s.status, ...(note ? { note } : {}) })})
```

- [ ] **Step 4: Add `prior_status` to the partial-move detail object**

In the partial branch (`else`), change:

```ts
        const detail = { from: fromWh, to: toWarehouseId, qty: r.qty, transfer_order_id: transferOrderId, ...(note ? { note } : {}) };
```

to:

```ts
        const detail = { from: fromWh, to: toWarehouseId, qty: r.qty, transfer_order_id: transferOrderId, prior_status: s.status, ...(note ? { note } : {}) };
```

(`s.status` is read into `s` before any UPDATE, so it's the pre-transfer status.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/backend && npx vitest run tests/transfer-orders.test.ts -t "records prior_status"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/inventory.ts apps/backend/tests/transfer-orders.test.ts
git commit -m "feat(transfers): record prior_status on transferred events"
```

---

## Task 2: Backend `DELETE /transfer-orders/:id` — discard handler

**Files:**
- Modify: `apps/backend/src/routes/inventory.ts` (add handler just before `export default inventory;` at the end)
- Test: `apps/backend/tests/transfer-orders.test.ts` (new `describe` block)

- [ ] **Step 1: Write the failing tests**

Append this `describe` block at the end of `tests/transfer-orders.test.ts` (after the reopen block, before EOF):

```ts
describe('DELETE /api/inventory/transfer-orders/:id — discard', () => {
  beforeEach(async () => { await resetDb(); });

  it('403 for non-manager', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('DELETE', '/api/inventory/transfer-orders/TO-1', { token });
    expect(r.status).toBe(403);
  });

  it('404 for unknown order', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('DELETE', '/api/inventory/transfer-orders/TO-999999', { token });
    expect(r.status).toBe(404);
  });

  it('400 when the order is not Pending', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    await api('POST', `/api/inventory/transfer-orders/${moved.orderId}/receive`, { token });
    const r = await api('DELETE', `/api/inventory/transfer-orders/${moved.orderId}`, { token });
    expect(r.status).toBe(400);
  });

  it('full move: line returns to origin at its prior status, TO deleted', async () => {
    const { token } = await loginAs(ALEX);
    const db = getTestDb();
    const before = (await db`
      SELECT l.id, l.status, l.qty, COALESCE(l.warehouse_id, o.warehouse_id) AS wh
      FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.status IN ('Reviewing','Done')
        AND COALESCE(l.warehouse_id, o.warehouse_id) IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sell_order_lines sl WHERE sl.inventory_id = l.id)
      LIMIT 1
    `)[0] as { id: string; status: string; qty: number; wh: string };
    const to = WAREHOUSES.find((w) => w !== before.wh)!;
    const tr = await api<{ ok: true; transferOrderId: string }>(
      'POST', '/api/inventory/transfer',
      { token, body: { toWarehouseId: to, lines: [{ id: before.id, qty: before.qty }] } },
    );
    const orderId = tr.body.transferOrderId;

    const r = await api<{ ok: true; id: string }>(
      'DELETE', `/api/inventory/transfer-orders/${orderId}`, { token },
    );
    expect(r.status).toBe(200);

    const ln = (await db`SELECT status, warehouse_id, transfer_order_id FROM order_lines WHERE id = ${before.id}`)[0] as
      { status: string; warehouse_id: string | null; transfer_order_id: string | null };
    expect(ln.status).toBe(before.status);
    expect(ln.warehouse_id).toBe(before.wh);
    expect(ln.transfer_order_id).toBeNull();
    const gone = await db`SELECT id FROM transfer_orders WHERE id = ${orderId}`;
    expect(gone.length).toBe(0);
    const ev = (await db`
      SELECT detail FROM inventory_events
      WHERE order_line_id = ${before.id} AND kind = 'transfer_discarded' ORDER BY created_at DESC LIMIT 1
    `)[0] as { detail: Record<string, unknown> };
    expect(ev.detail.transfer_order_id).toBe(orderId);
  });

  it('partial move: source qty restored, clone deleted, TO deleted', async () => {
    const { token } = await loginAs(ALEX);
    const db = getTestDb();
    const src = (await db`
      SELECT l.id, COALESCE(l.warehouse_id, o.warehouse_id) AS wh
      FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.status IN ('Reviewing','Done')
        AND COALESCE(l.warehouse_id, o.warehouse_id) IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sell_order_lines sl WHERE sl.inventory_id = l.id)
      LIMIT 1
    `)[0] as { id: string; wh: string };
    await db`UPDATE order_lines SET qty = 5 WHERE id = ${src.id}`;
    const to = WAREHOUSES.find((w) => w !== src.wh)!;
    const tr = await api<{ ok: true; transferOrderId: string }>(
      'POST', '/api/inventory/transfer',
      { token, body: { toWarehouseId: to, lines: [{ id: src.id, qty: 2 }] } },
    );
    const orderId = tr.body.transferOrderId;
    // After a partial move the source keeps qty 3 and a clone of qty 2 carries the TO.
    const clone = (await db`SELECT id FROM order_lines WHERE transfer_order_id = ${orderId}`)[0] as { id: string };
    expect(clone).toBeDefined();

    const r = await api('DELETE', `/api/inventory/transfer-orders/${orderId}`, { token });
    expect(r.status).toBe(200);

    const srcRow = (await db`SELECT qty FROM order_lines WHERE id = ${src.id}`)[0] as { qty: number };
    expect(srcRow.qty).toBe(5);
    const cloneGone = await db`SELECT id FROM order_lines WHERE id = ${clone.id}`;
    expect(cloneGone.length).toBe(0);
    const toGone = await db`SELECT id FROM transfer_orders WHERE id = ${orderId}`;
    expect(toGone.length).toBe(0);
  });

  it('partial move with consumed source: clone reverts standalone (fallback)', async () => {
    const { token } = await loginAs(ALEX);
    const db = getTestDb();
    const src = (await db`
      SELECT l.id, COALESCE(l.warehouse_id, o.warehouse_id) AS wh
      FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE l.status IN ('Reviewing','Done')
        AND COALESCE(l.warehouse_id, o.warehouse_id) IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sell_order_lines sl WHERE sl.inventory_id = l.id)
      LIMIT 1
    `)[0] as { id: string; wh: string };
    await db`UPDATE order_lines SET qty = 5 WHERE id = ${src.id}`;
    const to = WAREHOUSES.find((w) => w !== src.wh)!;
    const tr = await api<{ ok: true; transferOrderId: string }>(
      'POST', '/api/inventory/transfer',
      { token, body: { toWarehouseId: to, lines: [{ id: src.id, qty: 2 }] } },
    );
    const orderId = tr.body.transferOrderId;
    const clone = (await db`SELECT id FROM order_lines WHERE transfer_order_id = ${orderId}`)[0] as { id: string };
    // Consume the source remainder so the merge guard fails → fallback path.
    const so = (await db`SELECT id FROM sell_orders ORDER BY created_at LIMIT 1`)[0] as { id: string };
    await db`INSERT INTO sell_order_lines (sell_order_id, inventory_id, category, label, qty, unit_price)
             VALUES (${so.id}, ${src.id}, 'RAM', 'x', 1, 1)`;

    const r = await api('DELETE', `/api/inventory/transfer-orders/${orderId}`, { token });
    expect(r.status).toBe(200);

    const cloneRow = (await db`SELECT warehouse_id, transfer_order_id, status FROM order_lines WHERE id = ${clone.id}`)[0] as
      { warehouse_id: string | null; transfer_order_id: string | null; status: string };
    expect(cloneRow.transfer_order_id).toBeNull();
    expect(cloneRow.warehouse_id).toBe(src.wh);
    expect(['Reviewing', 'Done']).toContain(cloneRow.status);
    const toGone = await db`SELECT id FROM transfer_orders WHERE id = ${orderId}`;
    expect(toGone.length).toBe(0);
  });

  it('409 (no writes) when a line is committed to a sell order', async () => {
    const { token } = await loginAs(ALEX);
    const moved = await transferOne(token);
    const db = getTestDb();
    const so = (await db`SELECT id FROM sell_orders ORDER BY created_at LIMIT 1`)[0] as { id: string };
    await db`INSERT INTO sell_order_lines (sell_order_id, inventory_id, category, label, qty, unit_price)
             VALUES (${so.id}, ${moved.id}, 'RAM', 'x', 1, 1)`;
    const r = await api('DELETE', `/api/inventory/transfer-orders/${moved.orderId}`, { token });
    expect(r.status).toBe(409);
    const ord = (await db`SELECT status FROM transfer_orders WHERE id = ${moved.orderId}`)[0] as { status: string };
    expect(ord.status).toBe('Pending'); // unchanged — no writes
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/backend && npx vitest run tests/transfer-orders.test.ts -t "discard"`
Expected: FAIL — the DELETE route doesn't exist yet, so it returns 404 for the non-404 cases (e.g. the "full move" test fails on `expect(r.status).toBe(200)`).

- [ ] **Step 3: Implement the discard handler**

In `inventory.ts`, insert this handler immediately before the final `export default inventory;` line:

```ts
// Discard a Pending transfer order: undo the move and delete the TO. Full-move
// lines flip back to their origin warehouse at their pre-transfer status;
// partial-clone lines (their transferred event carries a peer_line_id) merge
// their qty back into the source remainder and are deleted. Manager-only.
// Mirrors the PO "draft-only delete" rule — a Received order must be reopened
// first. Guard: every line must still be In Transit and uncommitted to a sell
// order, else 409 with no writes (matches reopen).
inventory.delete('/transfer-orders/:id', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const sql = getDb(c.env);

  type Outcome = { code: 404 | 400 | 409; msg: string } | { code: 200 };
  let outcome: Outcome = { code: 200 };

  await sql.begin(async (tx) => {
    const ord = (await tx`
      SELECT id, status, from_warehouse_id FROM transfer_orders WHERE id = ${id} FOR UPDATE
    `)[0] as { id: string; status: string; from_warehouse_id: string | null } | undefined;
    if (!ord) { outcome = { code: 404, msg: `transfer order ${id} not found` }; return; }
    if (ord.status !== 'Pending') {
      outcome = { code: 400, msg: `transfer order ${id} is ${ord.status}; reopen it before discarding` };
      return;
    }

    const lines = (await tx`
      SELECT l.id, l.status, l.qty,
             (SELECT COUNT(*)::int FROM sell_order_lines sl WHERE sl.inventory_id = l.id) AS sell_count
      FROM order_lines l
      WHERE l.transfer_order_id = ${id}
      FOR UPDATE OF l
    `) as unknown as Array<{ id: string; status: string; qty: number; sell_count: number }>;

    const bad = lines.filter((l) => l.status !== 'In Transit' || l.sell_count > 0);
    if (bad.length > 0) {
      outcome = { code: 409, msg: `cannot discard: line(s) ${bad.map((l) => l.id).join(', ')} have moved on` };
      return;
    }

    const lineIds = lines.map((l) => l.id);
    const evs = lineIds.length === 0 ? [] : (await tx`
      SELECT order_line_id, detail FROM inventory_events
      WHERE order_line_id = ANY(${lineIds}::uuid[])
        AND kind = 'transferred'
        AND detail->>'transfer_order_id' = ${id}
    `) as unknown as Array<{ order_line_id: string; detail: Record<string, unknown> }>;
    const evByLine = new Map(evs.map((e) => [e.order_line_id, e.detail]));

    for (const l of lines) {
      const detail = evByLine.get(l.id) ?? {};
      const fromDetail = typeof detail.from === 'string' && detail.from ? detail.from : null;
      const origin = ord.from_warehouse_id ?? fromDetail;
      const priorStatus = typeof detail.prior_status === 'string' ? detail.prior_status : 'Done';
      const peerLineId = typeof detail.peer_line_id === 'string' ? detail.peer_line_id : null;

      let merged = false;
      if (peerLineId) {
        const peer = (await tx`
          SELECT id FROM order_lines
          WHERE id = ${peerLineId} AND transfer_order_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM sell_order_lines sl WHERE sl.inventory_id = order_lines.id)
          FOR UPDATE
        `)[0] as { id: string } | undefined;
        if (peer) {
          await tx`UPDATE order_lines SET qty = qty + ${l.qty} WHERE id = ${peer.id}`;
          await tx`
            INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
            VALUES (${peer.id}, ${u.id}, 'transfer_discarded',
                    ${tx.json({ transfer_order_id: id, returned_to: origin, qty: l.qty })})
          `;
          await tx`DELETE FROM order_lines WHERE id = ${l.id}`;
          merged = true;
        }
      }
      if (!merged) {
        await tx`
          UPDATE order_lines
             SET warehouse_id = ${origin}, status = ${priorStatus}, transfer_order_id = NULL
           WHERE id = ${l.id}
        `;
        await tx`
          INSERT INTO inventory_events (order_line_id, actor_id, kind, detail)
          VALUES (${l.id}, ${u.id}, 'transfer_discarded',
                  ${tx.json({ transfer_order_id: id, returned_to: origin, qty: l.qty })})
        `;
      }
    }

    await tx`DELETE FROM transfer_orders WHERE id = ${id}`;
  });

  if (outcome.code !== 200) {
    const err = outcome as { code: 404 | 400 | 409; msg: string };
    return c.json({ error: err.msg }, err.code);
  }
  return c.json({ ok: true, id });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/backend && npx vitest run tests/transfer-orders.test.ts`
Expected: PASS — all discard tests plus the pre-existing transfer/receive/reopen tests.

- [ ] **Step 5: Typecheck**

Run: `cd apps/backend && npx tsc --noEmit -p tsconfig.json` (or from repo root `pnpm typecheck`)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/routes/inventory.ts apps/backend/tests/transfer-orders.test.ts
git commit -m "feat(transfers): discard a Pending transfer order (DELETE endpoint)"
```

---

## Task 3: Frontend — Discard button, confirm modal, i18n

**Files:**
- Modify: `apps/frontend/src/lib/api.ts` (after `deleteOrder`, ~line 175)
- Modify: `apps/frontend/src/lib/i18n.tsx` (EN block ~line 297; ZH block ~line 1356)
- Modify: `apps/frontend/src/pages/desktop/DesktopTransfers.tsx`

- [ ] **Step 1: Add the API helper**

In `lib/api.ts`, immediately after the `deleteOrder` export (lines 174-175):

```ts
export const discardTransferOrder = (id: string) =>
  api.delete<{ ok: true; id: string }>(`/api/inventory/transfer-orders/${id}`);
```

- [ ] **Step 2: Add EN i18n keys**

In `i18n.tsx`, in the EN block right after `transfersActionError: 'Action failed',` (line 297):

```ts
    transfersDiscard: 'Discard',
    transfersDiscardConfirmTitle: 'Discard {id}?',
    transfersDiscardConfirmBody: 'Its lines return to their origin warehouse and the transfer is removed. This cannot be undone.',
    transfersDiscarded: 'Order {id} discarded',
```

- [ ] **Step 3: Add ZH i18n keys**

In the ZH block right after `transfersActionError: '操作失败',` (line 1356):

```ts
    transfersDiscard: '撤销',
    transfersDiscardConfirmTitle: '撤销 {id}？',
    transfersDiscardConfirmBody: '其明细将退回原仓库，调拨单将被删除。此操作无法撤销。',
    transfersDiscarded: '调拨单 {id} 已撤销',
```

- [ ] **Step 4: Import Modal and add discard state in DesktopTransfers**

At the top of `DesktopTransfers.tsx`, add to the imports (after the `Icon` import on line 4):

```ts
import { Modal } from '../../components/Modal';
import { discardTransferOrder } from '../../lib/api';
```

Inside the component, after the `printing` state (line 85):

```ts
  const [discardId, setDiscardId] = useState<string | null>(null);
```

- [ ] **Step 5: Add the discard handler**

After the `act` function (ends line 112), add:

```ts
  const discard = async (id: string) => {
    setBusy(id);
    try {
      await discardTransferOrder(id);
      onToast?.(t('transfersDiscarded', { id }));
      setDiscardId(null);
      load(filterRef.current);
    } catch (e) {
      onToast?.(t('transfersActionError') + ': ' + errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  };
```

- [ ] **Step 6: Add the Discard button on Pending rows**

In the Pending-row action group, after the existing `Confirm received` button (the `o.status === 'Pending'` block ending line 175), add a second button inside the same `{o.status === 'Pending' && (...)}` — replace:

```tsx
                {o.status === 'Pending' && (
                  <button className="btn accent" disabled={busy === o.id}
                          onClick={() => act(o, 'receive')}>
                    <Icon name="check" size={13} /> {t('transfersConfirm')}
                  </button>
                )}
```

with:

```tsx
                {o.status === 'Pending' && (
                  <>
                    <button className="btn accent" disabled={busy === o.id}
                            onClick={() => act(o, 'receive')}>
                      <Icon name="check" size={13} /> {t('transfersConfirm')}
                    </button>
                    <button className="btn" disabled={busy === o.id}
                            style={{ color: 'var(--neg)', borderColor: 'var(--neg)' }}
                            onClick={() => setDiscardId(o.id)}>
                      <Icon name="trash" size={13} /> {t('transfersDiscard')}
                    </button>
                  </>
                )}
```

- [ ] **Step 7: Render the confirm modal**

After the existing manifest print block (look for where `printing` is rendered, near the end of the returned JSX), add:

```tsx
      {discardId && (
        <Modal onClose={() => { if (busy !== discardId) setDiscardId(null); }} shellStyle={{ maxWidth: 420 }}>
          <div className="modal-head">
            <div className="modal-title">{t('transfersDiscardConfirmTitle', { id: discardId })}</div>
            <div className="modal-sub">{t('transfersDiscardConfirmBody')}</div>
          </div>
          <div className="modal-foot">
            <button className="btn" disabled={busy === discardId} onClick={() => setDiscardId(null)}>
              {t('cancel')}
            </button>
            <button
              className="btn"
              style={{ background: 'var(--neg)', color: 'white', borderColor: 'var(--neg)' }}
              disabled={busy === discardId}
              onClick={() => discard(discardId)}
            >
              {busy === discardId ? '…' : t('transfersDiscard')}
            </button>
          </div>
        </Modal>
      )}
```

- [ ] **Step 8: Typecheck and build the frontend**

Run: `pnpm --filter recycle-erp-frontend build`
Expected: build succeeds, no TS errors.

- [ ] **Step 9: Commit**

```bash
git add apps/frontend/src/lib/api.ts apps/frontend/src/lib/i18n.tsx apps/frontend/src/pages/desktop/DesktopTransfers.tsx
git commit -m "feat(transfers): desktop Discard button + confirm modal"
```

---

## Task 4: Final verification

- [ ] **Step 1: Run the full transfer test file**

Run: `cd apps/backend && npx vitest run tests/transfer-orders.test.ts`
Expected: all green (schema, create, list, receive, reopen, discard).

- [ ] **Step 2: Manual smoke (optional, if a dev stack is running)**

As a manager, open Transfers → Pending. Confirm a TO shows a red **Discard** button; clicking it opens the confirm modal; confirming removes the TO from the list and toasts "Order TO-x discarded". Verify the moved item is back at its origin warehouse in Inventory.

---

## Self-Review Notes

- **Spec coverage:** Pending-only guard (Task 2 step 3, `status !== 'Pending'` → 400); manager-only (403 check); undo full move (revert-in-place branch); merge partial split (peer branch); delete TO (final `DELETE`); 409 sold/moved-on guard; `prior_status` restore (Task 1 + handler `priorStatus`); DELETE verb endpoint; frontend button + confirm modal + DELETE call; EN/ZH i18n. All present.
- **Type consistency:** API helper `discardTransferOrder` returns `{ ok: true; id: string }`, matching the handler's success body. Event kind string `'transfer_discarded'` is used identically in handler and tests. i18n keys (`transfersDiscard`, `transfersDiscardConfirmTitle`, `transfersDiscardConfirmBody`, `transfersDiscarded`) match between definition and usage.
- **No placeholders:** every code step shows complete code and exact run commands.
