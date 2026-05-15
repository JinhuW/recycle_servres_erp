# Sell Order Share Link — Design

**Date:** 2026-05-15
**Status:** Approved (pending spec review)

## Problem

Purchase orders support a shareable deep link: a share button next to the
Order ID copies a URL like `…#/purchase-orders/SO-1289`, and opening that URL
routes a manager straight to that order. Sell orders have no equivalent —
they open in a modal dialog driven by local component state with **no URL
route**, so a sell order cannot be linked or shared.

Goal: give sell orders the same share-link capability, with the link able to
open the order in **either view or edit mode**.

## Constraints & Context

- Router is a tiny hash-based router (`src/lib/route.ts`) with a path-segment
  `match()` (no query-string parsing). Existing patterns: `/inventory/:id`,
  `/purchase-orders/:id`.
- Purchase orders open as a **full page**; the shell (`DesktopApp.tsx`)
  fetches the order and syncs `editingOrder` with `#/purchase-orders/:id`.
- Sell orders open as a **modal dialog** (`SellOrderDetail` in
  `DesktopSellOrders.tsx`) with internal state `open: {id, mode:'view'|'edit'}`.
  The dialog already fetches its own order via `GET /api/sell-orders/:id`.
- Sell orders are manager-only; purchasers are already redirected away from
  the `sellorders` view.
- There is **no mobile sell-orders view**.

## Chosen Approach — Two Path Segments

- `#/sell-orders/:id` → open the detail dialog in **view** mode.
- `#/sell-orders/:id/edit` → open the detail dialog in **edit** mode.

The hash is the source of truth for which sell order is open and in what
mode, mirroring how `DesktopApp` already syncs `#/purchase-orders/:id`.
Rejected alternatives: query-param mode (router has no query parsing, less
consistent); view-only link (doesn't meet the "both modes" requirement).

## Design

### 1. Router — `src/lib/route.ts`

`DESKTOP_VIEW_TO_PATH.sellorders` (`/sell-orders`) already exists. Update
`pathToDesktopView` so it also returns `'sellorders'` for
`match('/sell-orders/:id', path)` and `match('/sell-orders/:id/edit', path)`
(currently only the exact `/sell-orders` resolves).

### 2. Open/close/mode state — `DesktopApp.tsx` + `DesktopSellOrders.tsx`

Lift the open-order source of truth from `DesktopSellOrders`'s internal
`open` state to the URL:

- The open order id + mode is derived from `useRoute()` via
  `match('/sell-orders/:id', path)` (view) and
  `match('/sell-orders/:id/edit', path)` (edit).
- Row click → `navigate('/sell-orders/' + id)`.
- Edit affordance (`onSwitchToEdit`) → `navigate('/sell-orders/' + id + '/edit')`.
- Close (`onClose`) → `navigate('/sell-orders')`.
- Save (`onSaved`) → reload list, then `navigate('/sell-orders')`.

`SellOrderDetail` already fetches its order by id internally, so cold-loading
either URL needs **no extra fetch logic in the shell** (unlike purchase
orders, where the shell fetches).

### 3. Share button — `DesktopSellOrders.tsx` (the `o.id` cell)

Mirror the purchase-order share button exactly:

- URL: `${location.origin}${location.pathname}#/sell-orders/${o.id}`
  (view-mode link).
- `navigator.share` when available, else `navigator.clipboard.writeText`
  fallback, else error toast.
- Reuse existing i18n keys: `shareOrder`, `orderIdCopied`,
  `orderIdCopyFailed`. Reuse the same Icon as the PO button.
- `stopPropagation` so clicking share does not also open the row.
- Thread an `onToast` prop into `DesktopSellOrders` (it currently has none);
  `DesktopApp` already exposes `showToast`.

### 4. Access

No change. The route does not bypass auth/role; recipients must be managers
(purchasers are already redirected away from `sellorders`).

### 5. Testing

- Unit-test `pathToDesktopView` returns `'sellorders'` for
  `/sell-orders/SO-1`, `/sell-orders/SO-1/edit`, and still `'sellorders'`
  for `/sell-orders`.
- Manual: open a sell order → URL becomes `/sell-orders/:id`; copy link;
  open it cold in a new tab → dialog opens in view mode; switch to Edit →
  URL becomes `/sell-orders/:id/edit`; reload → opens in edit mode; close →
  URL returns to `/sell-orders`.

## Out of Scope (YAGNI)

- Mobile sell-orders share link (no mobile sell-orders view exists).
- Share button inside the detail dialog (purchase orders don't have one
  either).
- Backend changes (none required).
