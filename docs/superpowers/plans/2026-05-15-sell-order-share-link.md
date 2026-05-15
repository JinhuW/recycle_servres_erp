# Sell Order Share Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give sell orders the same shareable deep-link as purchase orders — a share button next to each Sell Order ID, with the link able to open the order in either view or edit mode.

**Architecture:** Introduce two hash routes — `#/sell-orders/:id` (view) and `#/sell-orders/:id/edit` (edit) — and make the URL the source of truth for which sell order dialog is open and in what mode (mirroring how `DesktopApp` already syncs `#/purchase-orders/:id`). The sell-order detail dialog already fetches its own order by id, so no shell-level fetch is needed. Add a share button to the Sell Order ID cell that copies/shares the view-mode link, reusing the existing purchase-order pattern and i18n keys.

**Tech Stack:** React (hash router in `src/lib/route.ts`), TypeScript, Vitest (already used by the backend; added to the frontend in Task 1).

---

## File Structure

- `apps/frontend/package.json` — add `test` script + `vitest` devDependency (frontend has no test runner yet).
- `apps/frontend/tests/route.test.ts` — **create**; unit tests for `pathToDesktopView` (pure function, no React runtime needed).
- `apps/frontend/src/lib/route.ts` — **modify** `pathToDesktopView` to resolve the two new sell-order paths.
- `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx` — **modify**: derive the open-order/mode from the route instead of local `open` state; rewire row/detail callbacks to `navigate(...)`; add the share button; add an `onToast` prop.
- `apps/frontend/src/DesktopApp.tsx` — **modify**: pass `onToast={showToast}` to `<DesktopSellOrders>`.

---

### Task 1: Add frontend test harness + failing route tests

**Files:**
- Modify: `apps/frontend/package.json`
- Create: `apps/frontend/tests/route.test.ts`

- [ ] **Step 1: Add the test script and vitest devDependency**

Edit `apps/frontend/package.json`. In `"scripts"`, add a `"test"` entry next to the existing scripts:

```json
  "scripts": {
    "dev": "vite --host 0.0.0.0",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
```

In `"devDependencies"`, add (keep the list alphabetically consistent with the existing file; exact existing version pin from the backend is `^4.1.5`):

```json
    "vitest": "^4.1.5"
```

- [ ] **Step 2: Install**

Run: `pnpm -C apps/frontend install`
Expected: completes; `vitest` resolves (already present in the monorepo via the backend).

- [ ] **Step 3: Write the failing test**

Create `apps/frontend/tests/route.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pathToDesktopView, match } from '../src/lib/route';

describe('match', () => {
  it('matches a single param segment', () => {
    expect(match('/sell-orders/:id', '/sell-orders/SO-1')).toEqual({ id: 'SO-1' });
  });
  it('does not match when segment counts differ', () => {
    expect(match('/sell-orders/:id', '/sell-orders/SO-1/edit')).toBeNull();
  });
  it('matches the two-param edit shape', () => {
    expect(match('/sell-orders/:id/edit', '/sell-orders/SO-1/edit')).toEqual({ id: 'SO-1' });
  });
});

describe('pathToDesktopView — sell orders', () => {
  it('resolves the list path', () => {
    expect(pathToDesktopView('/sell-orders')).toBe('sellorders');
  });
  it('resolves a sell-order view deep link', () => {
    expect(pathToDesktopView('/sell-orders/SO-1289')).toBe('sellorders');
  });
  it('resolves a sell-order edit deep link', () => {
    expect(pathToDesktopView('/sell-orders/SO-1289/edit')).toBe('sellorders');
  });
});

describe('pathToDesktopView — unchanged behaviour', () => {
  it('still resolves purchase-order deep links', () => {
    expect(pathToDesktopView('/purchase-orders/SO-1')).toBe('history');
  });
  it('defaults unknown paths to dashboard', () => {
    expect(pathToDesktopView('/nope')).toBe('dashboard');
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm -C apps/frontend test`
Expected: FAIL — the two sell-order deep-link cases (`/sell-orders/SO-1289`, `/sell-orders/SO-1289/edit`) return `'dashboard'` instead of `'sellorders'`. The `match` tests and the unchanged-behaviour tests should PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/package.json apps/frontend/pnpm-lock.yaml pnpm-lock.yaml apps/frontend/tests/route.test.ts
git commit -m "test(frontend): add vitest + failing sell-order route tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

(If `pnpm-lock.yaml` did not change, omit it from `git add` — only stage files that actually changed.)

---

### Task 2: Resolve sell-order deep links in the router

**Files:**
- Modify: `apps/frontend/src/lib/route.ts:67-76` (`pathToDesktopView`)

- [ ] **Step 1: Update `pathToDesktopView`**

In `apps/frontend/src/lib/route.ts`, the current function is:

```ts
export function pathToDesktopView(path: string): DesktopViewId {
  if (path === '/' || path === '/dashboard') return 'dashboard';
  if (path === '/submit') return 'submit';
  if (path === '/purchase-orders' || match('/purchase-orders/:id', path)) return 'history';
  if (path === '/market') return 'market';
  if (path === '/inventory' || match('/inventory/:id', path)) return 'inventory';
  if (path === '/sell-orders') return 'sellorders';
  if (path === '/settings') return 'settings';
  return 'dashboard';
}
```

Replace the `/sell-orders` line with one that also matches the two deep-link shapes:

```ts
  if (
    path === '/sell-orders' ||
    match('/sell-orders/:id', path) ||
    match('/sell-orders/:id/edit', path)
  ) return 'sellorders';
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `pnpm -C apps/frontend test`
Expected: PASS — all cases in `route.test.ts` green.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/lib/route.ts
git commit -m "feat(frontend): resolve sell-order deep links to the sellorders view

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Drive the sell-order dialog from the URL + add the share button

No automated test (this is React UI wiring with no component-test harness in this project); verification is `tsc` typecheck (Step 6) plus the manual checklist in Task 4.

**Files:**
- Modify: `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx`
  - imports `:1`
  - props/type `:108-112`
  - open state `:118`
  - row `onClick` `:239`
  - the `o.id` cell `:241`
  - View/Edit action buttons `:256,:264`
  - `<SellOrderDetail>` wiring `:286-293`
- Modify: `apps/frontend/src/DesktopApp.tsx:130-131`

- [ ] **Step 1: Add router imports to DesktopSellOrders**

In `apps/frontend/src/pages/desktop/DesktopSellOrders.tsx`, the current line 7 is:

```ts
import { api } from '../../lib/api';
```

Add the router import immediately after it:

```ts
import { api } from '../../lib/api';
import { useRoute, navigate, match } from '../../lib/route';
```

- [ ] **Step 2: Add the `onToast` prop**

Current (lines 108-112):

```ts
type SellOrdersProps = {
  onNewFromInventory?: () => void;
};

export function DesktopSellOrders({ onNewFromInventory }: SellOrdersProps = {}) {
```

Replace with:

```ts
type SellOrdersProps = {
  onNewFromInventory?: () => void;
  onToast?: (msg: string, kind?: 'success' | 'error') => void;
};

export function DesktopSellOrders({ onNewFromInventory, onToast }: SellOrdersProps = {}) {
```

- [ ] **Step 3: Replace local `open` state with a route-derived value**

Current (line 118):

```ts
  const [open, setOpen] = useState<{ id: string; mode: 'view' | 'edit' } | null>(null);
```

Replace with:

```ts
  const { path } = useRoute();
  const editMatch = match('/sell-orders/:id/edit', path);
  const viewMatch = match('/sell-orders/:id', path);
  const open: { id: string; mode: 'view' | 'edit' } | null =
    editMatch ? { id: editMatch.id, mode: 'edit' }
    : viewMatch ? { id: viewMatch.id, mode: 'view' }
    : null;
```

(Order matters: `/sell-orders/:id` has two segments and will not match `/sell-orders/SO-1/edit` (three segments), so checking `editMatch` first is belt-and-braces but harmless.)

- [ ] **Step 4: Rewire row click, action buttons, and the share button**

Current row opening (line 239):

```tsx
                  onClick={() => setOpen({ id: o.id, mode: 'view' })}
```

Replace with:

```tsx
                  onClick={() => navigate('/sell-orders/' + o.id)}
```

Current `o.id` cell (line 241):

```tsx
                  <td className="mono" style={{ fontWeight: 600, fontSize: 11.5 }}>{o.id}</td>
```

Replace with (mirrors the purchase-order share button in `DesktopOrders.tsx:468-493`, including the `paperclip` icon and the reused i18n keys):

```tsx
                  <td className="mono" style={{ fontWeight: 600, fontSize: 11.5 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {o.id}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const url = `${location.origin}${location.pathname}#/sell-orders/${o.id}`;
                          const share = (navigator as Navigator & { share?: (data: { url: string; title: string }) => Promise<void> }).share;
                          if (typeof share === 'function') {
                            share.call(navigator, { url, title: t('shareOrder') }).catch((err: Error) => {
                              if (err.name !== 'AbortError') onToast?.(t('orderIdCopyFailed'), 'error');
                            });
                          } else if (navigator.clipboard?.writeText) {
                            navigator.clipboard.writeText(url)
                              .then(() => onToast?.(t('orderIdCopied')))
                              .catch(() => onToast?.(t('orderIdCopyFailed'), 'error'));
                          } else {
                            onToast?.(t('orderIdCopyFailed'), 'error');
                          }
                        }}
                        aria-label={t('shareOrder')}
                        title={t('shareOrder')}
                        style={{ background: 'transparent', border: 'none', color: 'var(--fg-subtle)', padding: 0, marginLeft: 2, lineHeight: 0, cursor: 'pointer', verticalAlign: 'middle' }}
                      >
                        <Icon name="paperclip" size={12} />
                      </button>
                    </span>
                  </td>
```

Current View action button (line 256):

```tsx
                        onClick={() => setOpen({ id: o.id, mode: 'view' })}
```

Replace with:

```tsx
                        onClick={() => navigate('/sell-orders/' + o.id)}
```

Current Edit action button (line 264):

```tsx
                          onClick={() => setOpen({ id: o.id, mode: 'edit' })}
```

Replace with:

```tsx
                          onClick={() => navigate('/sell-orders/' + o.id + '/edit')}
```

- [ ] **Step 5: Rewire the `<SellOrderDetail>` callbacks**

Current (lines 286-293):

```tsx
      {open && (
        <SellOrderDetail
          id={open.id}
          mode={open.mode}
          onSwitchToEdit={() => setOpen({ id: open.id, mode: 'edit' })}
          onClose={() => setOpen(null)}
          onSaved={() => { reload(); setOpen(null); }}
        />
```

Replace with:

```tsx
      {open && (
        <SellOrderDetail
          id={open.id}
          mode={open.mode}
          onSwitchToEdit={() => navigate('/sell-orders/' + open.id + '/edit')}
          onClose={() => navigate('/sell-orders')}
          onSaved={() => { reload(); navigate('/sell-orders'); }}
        />
```

- [ ] **Step 6: Pass `onToast` from the shell**

In `apps/frontend/src/DesktopApp.tsx`, current (lines 130-131):

```tsx
          {view2 === 'sellorders' && (
            <DesktopSellOrders onNewFromInventory={() => navigate('/inventory')} />
```

Replace with:

```tsx
          {view2 === 'sellorders' && (
            <DesktopSellOrders onNewFromInventory={() => navigate('/inventory')} onToast={showToast} />
```

(`showToast` is already defined in `DesktopApp.tsx` with signature `(msg: string, kind?: Toast['kind']) => void`, compatible with the `onToast` prop type.)

- [ ] **Step 7: Typecheck**

Run: `pnpm -C apps/frontend exec tsc -b`
Expected: no errors. (Confirms `open` is no longer typed via `useState`, `useState` may now be unused — if `tsc`/lint flags `useState` as unused, remove it from the `react` import on line 1; do not remove `useEffect`/`useMemo`, still used.)

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/pages/desktop/DesktopSellOrders.tsx apps/frontend/src/DesktopApp.tsx
git commit -m "feat(frontend): shareable deep links for sell orders

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Manual verification

**Files:** none (verification only)

- [ ] **Step 1: Start the app**

Run: `pnpm -C apps/frontend dev`
Open the app and sign in as a manager (purchasers cannot see sell orders).

- [ ] **Step 2: Verify URL sync**

Navigate to Sell Orders. Click a row → the address bar hash becomes `#/sell-orders/<id>` and the detail dialog opens in **view** mode. Click the row's Edit (pencil) action on a non-Done order → hash becomes `#/sell-orders/<id>/edit` and the dialog is in **edit** mode. Close the dialog → hash returns to `#/sell-orders`.

- [ ] **Step 3: Verify the share button**

In the Sell Orders table, click the share (paperclip) button next to an Order ID. On a browser without `navigator.share`, expect the "link copied" toast and the clipboard to contain `…#/sell-orders/<id>`. Confirm clicking share does **not** also open the row dialog.

- [ ] **Step 4: Verify cold-load deep links**

Paste `…#/sell-orders/<id>` into a fresh tab (manager session) → Sell Orders view loads with the detail dialog open in **view** mode. Paste `…#/sell-orders/<id>/edit` → dialog opens in **edit** mode. Reloading either URL preserves the mode.

- [ ] **Step 5: Verify access control**

Sign in as a purchaser and open `…#/sell-orders/<id>` → redirected to the dashboard (sell orders remain manager-only; the route does not bypass the existing role redirect).

---

## Self-Review Notes

- **Spec coverage:** Router (Task 2 + Task 1 tests), open/close/mode state lifted to URL (Task 3 Steps 3–6), share button mirroring PO with reused i18n keys (Task 3 Step 4), access unchanged (verified Task 4 Step 5), testing — `pathToDesktopView` unit-tested (Tasks 1–2) + manual checklist (Task 4). All spec sections covered. Spec listed no mobile/dialog-internal share (out of scope) — not planned, as intended.
- **Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output.
- **Type consistency:** `open` shape `{ id: string; mode: 'view' | 'edit' }` is preserved exactly as the previous `useState` type, so `<SellOrderDetail id={open.id} mode={open.mode} …>` keeps compiling unchanged. `onToast?: (msg: string, kind?: 'success' | 'error') => void` matches `DesktopApp.showToast` (`Toast['kind']` is `'success' | 'error'`).
