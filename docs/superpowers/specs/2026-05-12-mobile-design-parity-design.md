# Mobile design parity — phone view ↔ Claude Design reference

**Date:** 2026-05-12
**Reference:** Claude Design handoff bundle "recycle-servers-inventory-management" (Phone.html → 8 screens: login, login-picker, dashboard, dashboard-then-submit, history, market, me, me-language).
**Goal:** Bring the live mobile build to visual and behavioral parity with the reference. Page-by-page delivery, with sign-off between groups.

This is a diff spec — it lists only what changes. Things already at parity (KPI tiles, sparkline, order accordion structure, tab bar shape, language sheet flag SVGs, total-cost card, segmented payment control, AI scan camera frame) are intentionally omitted.

## Scope decisions (from brainstorming)

1. **Inventory page (manager-only)** stays, polished against the design system's `.ph-*` primitives (the design didn't model it; we follow its idiom).
2. **Login → role-picker** becomes two steps, matching the reference.
3. **In scope:** visual parity, wiring half-finished interactions, localizing remaining hard-coded English, deduping category field forms, AND adding AI rescan to edit-mode for line items.
4. **Delivery:** page-by-page; checkpoint before moving to the next group.

## Cross-cutting changes (do once, before per-screen work)

### CC-1. Add missing CSS

`apps/frontend/src/styles/phone.css` is missing one class that the existing JSX already references:

- `.cam-hint` — translucent dark pill identical to `.ph-cam-pill` but center-anchored over the camera stage. Used in `Camera.tsx:171` and currently renders unstyled. Add to phone.css alongside the other `.ph-cam-*` rules.

Dead CSS we'll keep (don't delete, they belong to the design system even if unused today): `.ph-card-head/-title/-sub/-body`, `.ph-ai-card`. We'll start consuming them in CC-4.

### CC-2. Scroll-shadow header

`PhHeader.tsx` already accepts a `scrolled` prop and `.ph-header.scrolled` is styled, but no caller toggles it. Add a small hook `usePhScrolled(ref)` in `lib/usePhScrolled.ts` that listens to a scroll container ref and returns `boolean` when `scrollTop > 4`. Wire into Dashboard, Orders, Market, Inventory, Profile.

### CC-3. Unify the line-edit experience (revised)

Today there are **two different edit UIs** for a line item:

1. After camera capture: `SubmitForm` — full-screen, sticky action bar, AI banner, header back/rescan icons.
2. Inside OrderReview: each `.ph-line` card expands inline to a smaller edit form duplicating the RAM/SSD/Other field grid.

Both must converge on a **single edit page** that looks like the SubmitForm. Inline-expansion is removed.

**Target behavior:**
- A line in OrderReview renders only as a collapsed `.ph-line` card (label, part number, qty/unit/total, status chip). Trash icon remains on the right; the pencil/edit icon (or the row itself) pushes to the SubmitForm view.
- The SubmitForm view is reused (no new component) but supports an `editingLineIdx: number | null` mode. When non-null:
  - Pre-fills with the existing line's values.
  - Header title `t('editItem')` (e.g., "Edit RAM item"), sub = the line label.
  - Header trailing camera icon (RAM only) opens the rescan flow (CC-4) and applies AI values on return.
  - Action bar becomes Cancel + dark "Save changes" button (instead of "Add item").
  - Saving updates the line at `editingLineIdx` and returns to review.
  - Cancel/back returns to review without mutation (CC-6 logic).
- Adding a new line works the same as today (push to SubmitForm with `editingLineIdx === null`).

**Implementation notes:**
- Extend `CaptureState`'s `'form'` phase with `editingLineIdx?: number | null`.
- The shared field-grid component still exists (now: `components/PhCategoryFields.tsx`) because OrderReview no longer holds an inline copy. SubmitForm is the sole caller; the dedup naturally happens by deleting the inline form from OrderReview.
- Sell price input — previously only available in OrderReview's inline form — moves into SubmitForm and is shown only in edit-mode (it stays hidden for fresh line entry to preserve the design's "add cost now, sell later" intent).

### CC-4. AI rescan inside edit-mode (revised)

Now that line edit happens in the SubmitForm full-screen view (CC-3), AI rescan is a first-class affordance there:

- The SubmitForm header already has a trailing `camera` icon-button for RAM that triggers rescan. Keep it and ensure it works in both modes:
  - **New-line mode** (`editingLineIdx === null`): rescan goes back to camera, re-enters the form on detection — current behavior.
  - **Edit-line mode** (`editingLineIdx !== null`): rescan goes to camera with the existing line's category, returns to the SubmitForm with AI values merged (preserve `qty`, `unitCost`, `sellPrice`, and `condition` unless the scan supplied them).
- No new CaptureState phase is needed — the existing `'camera'` phase carries `editingLineIdx` through.

### CC-5. Deep-linkable order URLs (new requirement, mobile + desktop)

Orders have a globally unique `id` from the backend (`OrderSummary.id` in `lib/types.ts`), but neither surface exposes it as a URL today — both use internal state with no router. The mobile list shows the ID in mono font; desktop opens an edit page via `setEditingOrder(o)` callback. Both must become deep-linkable.

The app has no routing library installed (`package.json` has neither `react-router-dom` nor `wouter`). To keep the parity pass small, **use hash-based routing** rather than introducing a new dependency.

#### Shared route library: `lib/route.ts`

Exposes:
- `useRoute(): { path: string; params: Record<string, string> }` — re-renders on `hashchange`.
- `navigate(path: string)` — sets `window.location.hash` (without page reload).
- A small matcher: `match('/orders/:id', path)` → returns params or null.

Recognized routes (initial set):
- `#/` → default view for the surface.
- `#/orders` → orders list.
- `#/orders/:id` → open the specified order.

Both `MobileApp.tsx` and `DesktopApp.tsx` subscribe to the route and react accordingly. `lib/api.ts` should also expose `getOrderById(id)` if it doesn't already, so a deep link works even before the list fetch resolves.

#### Mobile (Orders.tsx / MobileApp.tsx)

When the route matches `#/orders/:id`:
- If the order exists in the loaded list, expand its accordion and scroll it into view.
- If not yet loaded, fetch `/api/orders/:id` (or fall back to a list refresh + lookup) and hydrate before expanding.
- For non-completed orders, additionally call `startEdit(order)` so the user lands in review.
- The hash is set when the user taps a row's edit pencil — `navigate('/orders/' + id)` — so the URL stays in sync without breaking the existing back-button flow.

Orders list rows get a tiny `link` icon button (16px) adjacent to the mono order ID in `.ph-order-head`. Tap → `navigator.clipboard.writeText(${location.origin}/#/orders/${order.id})` then toast `t('orderIdCopied')`. If `navigator.share` is available, prefer the system share sheet with the same URL.

#### Desktop (DesktopOrders.tsx / DesktopEditOrder.tsx / DesktopApp.tsx)

`DesktopApp.tsx:28` holds `view` and `editingOrder` state. Wire both to the route:
- On route `#/orders/:id`: setEditingOrder to that order (fetching if needed). `view` is implicitly forced to `'history'` because `DesktopEditOrder` is rendered as a sibling alternative.
- On route `#/orders` (no id): clear `editingOrder` and ensure `view === 'history'`.
- When `setEditingOrder(o)` is called from the list: also `navigate('/orders/' + o.id)`.
- When `DesktopEditOrder` closes / back: `navigate('/orders')`.

`DesktopOrders.tsx` list rows: surface the same copy/share affordance as mobile next to the order ID — small `link` icon button, same clipboard + share behavior, same `t('orderIdCopied')` toast.

**Acceptance:**
- Loading mobile at `https://app/#/orders/SO-1289` lands on the Orders tab with that order expanded and in edit mode (when not completed). Tapping the link icon copies the deep link.
- Loading desktop at the same URL renders `DesktopEditOrder` for that order. Closing it returns to the list and updates the hash to `#/orders`.
- The URL stays in sync as you navigate via UI on either surface (browser back/forward also works because `hashchange` fires on history navigation).

### CC-6. Back button returns to order detail when adding another item (new requirement)

Today, the capture state machine doesn't remember "where the user came from" when transitioning between phases. As a result, the back/cancel button on the SubmitForm (the "Add item" page) unconditionally calls `cancelCapture()`, which dumps the user to `{ phase: 'idle' }` — i.e. back to the dashboard or orders list, even mid-order.

The correct behavior:

- **First item** of a new draft order → back cancels the whole capture flow (current behavior). The user came from "idle"; back returns to idle.
- **Nth item** (after the user already added at least one line and tapped "+ Add another" from review) → back returns to the **review** screen with the existing lines intact.
- **Edit-mode**, adding an item to an existing order → back also returns to review for that order.

Implementation:

- Extend `CaptureState` (`MobileApp.tsx:23-28`): the `camera` and `form` phases gain a `returnTo: 'idle' | 'review'` discriminator.
- `pickCategory()` (first item) sets `returnTo: 'idle'`.
- `addAnotherItem()` (review → form/camera) sets `returnTo: 'review'`.
- Camera and SubmitForm receive an `onBack` prop. `MobileApp` provides one that branches:
  - `returnTo === 'idle'` → `cancelCapture()`.
  - `returnTo === 'review'` → `setCapture(c => ({ ...c, phase: 'review' }))` (preserving lines, editingId, category, detected).

**Acceptance:** Start an order with one RAM item; tap "+ Add another"; from the camera or form screen, tap back — you land on the review screen with the first line still present. From the very first item's camera/form, back still exits to dashboard.

### CC-7. i18n key additions

Add to `lib/i18n.tsx` for both `en` and `zh`:

| Key | EN | ZH |
|---|---|---|
| `rescanWithAi` | `Rescan with AI` | `用 AI 重新扫描` |
| `notifTitle` | `Notifications` | `通知` |
| `notifNUnread` | `{n} unread` | `{n} 条未读` |
| `notifAllCaught` | `All caught up` | `全部已读` |
| `notifMarkAllRead` | `Mark all read` | `全部标为已读` |
| `notifManageHint` | `Manage alert types in Profile · Notifications` | `在「个人 · 通知」中管理提醒类型` |
| `loadingAccounts` | `Loading demo accounts…` | `加载演示账号…` |
| `signInBack` | `Back` | `返回` |
| `searchOrders` | `Search orders…` | `搜索订单…` |
| `vsLast30` | `{pct} vs last 30d` | `较过去 30 天 {pct}` |
| `cameraUpload` | `Upload from library` | `从相册上传` |
| `cameraSwitch` | `Switch camera` | `切换摄像头` |
| `cameraFlash` | `Toggle flash` | `切换闪光灯` |
| `orderIdCopied` | `Order link copied` | `订单链接已复制` |
| `shareOrder` | `Share order` | `分享订单` |
| `editRamItem` | `Edit RAM item` | `编辑内存项目` |
| `editSsdItem` | `Edit SSD item` | `编辑硬盘项目` |
| `editOtherItem` | `Edit item` | `编辑项目` |
| `saveChanges` | `Save changes` | `保存修改` |

(Add adjacent to existing keys; no reordering required.)

---

## Per-screen changes

### S1. Login → role-picker (Login.tsx)

**Currently:** single page, picker reached via inline "Continue as →" text button. Hard-coded English subtitles in picker block.

**Target:**
- Split into two view states inside the same `.ph-login-shell`: `'signin'` → `'picker'`. (Already partly present via `mode` state, just commit to the two-step.)
- After "Continue" on signin, transition to picker (slide-in is fine; no need for sheet).
- Role rows use `t('managerFullAccess')`, `t('purchaserOwn')`, `t('role_admin')`, `t('role_purchaser')` (all exist in i18n.tsx today).
- "Loading demo accounts…" → `t('loadingAccounts')`.
- Brand strings `"Recycle Servers"` / `"Inventory & Profit"` → `t('appBrand')` / `t('brandSub')`.
- Back button at picker bottom uses `t('signInBack')` + `chevronLeft` icon, returns to `'signin'`.

**Acceptance:** Signing in flips to the picker view; refreshing the page with the same auth state returns to the picker (URL hash optional — not required, just internal state). All text comes from `t()`.

### S2. Dashboard (Dashboard.tsx)

- Remove hard-coded `"12.4% vs last 30d"` (Dashboard.tsx:79). Replace with `{t('vsLast30', { pct: deltaStr })}`. For now, `deltaStr` is `'—'` until the backend supplies a delta; the visual treatment (accent-strong pill with `arrowUp/Down/minus`) renders regardless.
- Pass `scrolled` prop to the inline dashboard header (it doesn't use PhHeader; replicate the `.ph-header.scrolled` treatment by adding `.scrolled` class to the header div based on `usePhScrolled`).
- The dashboard header is currently a custom `<header className="ph-header">`. Confirm it has `position: sticky` (it does, via the shared rule) and the scroll listener target is the page's `.ph-scroll` container.

**Acceptance:** Scrolling past 4px applies blurred bg + bottom border. Hard-coded delta gone.

### S3. Capture sub-flow

#### S3a. PhCategorySheet — already matches; no changes.

#### S3b. Camera (Camera.tsx)

- Add `.cam-hint` styling per CC-1.
- Wire flash button: track `flash: 'off' | 'on'` in component state; toggle icon color; apply `torch: true` constraint to the active `MediaStreamTrack` via `applyConstraints({ advanced: [{ torch: ... }] })` (silently no-op where unsupported).
- Wire switch-camera button: track `facingMode: 'environment' | 'user'`; restart `getUserMedia` with the new constraint.
- Title attributes → translated via `t('cameraFlash')`, `t('cameraSwitch')`, `t('cameraUpload')`.
- Replace 8-byte PNG fallback placeholder with a soft accent-tinted `.cam-viewfinder` (already used elsewhere) — the existing illustration covers the no-stream case, so just remove the broken fallback.

**Acceptance:** On supported devices, flash toggles the device torch; on others, the icon still flips but no error. Camera switch reinitializes the stream.

#### S3c. SubmitForm (SubmitForm.tsx) — now the single line-edit page

- Remove demo-seed defaults (qty=4, unitCost=78, brand="Samsung", etc.) for *manual* entry (no AI detection). Keep defaults *only* when `detected` is non-null and supplied them.
- Use `PhCategoryFields` (CC-3). Local state still owns the value; this component only renders fields.
- **Add `editingLineIdx?: number | null` prop and `existingLine?: DraftLine`** (CC-3). When set:
  - Title: `t('editRamItem')` / `t('editSsdItem')` / `t('editOtherItem')`.
  - Sub: the line's display label.
  - Initial form values come from `existingLine`.
  - Action bar dark button: `t('saveChanges')` (new key) instead of "Add to order"/"Add item".
  - Show the sell price field below unit cost.
  - On save: caller updates the line in place at that index, then transitions back to review.
- Header trailing camera icon (RAM rescan) — works in both new and edit modes (CC-4).
- **Back-button behavior (CC-6):** receive an `onBack` prop from `MobileApp`. The header's leading chevron-back calls `onBack()` instead of the old `onCancel`. `onCancel` becomes the explicit "Cancel" button in the sticky action bar (which still kills the whole capture for new orders; for edit-line, cancel returns to review). For Nth-item add, `onBack()` returns to review with lines intact; for first-item, it exits to idle. (Camera screen gets the same treatment.)

#### S3d. OrderReview (OrderReview.tsx) — line cards become tap-to-edit

- **Remove the inline expand-to-edit form** entirely. The duplicated RAM/SSD/Other field markup at OrderReview.tsx:92-198 is deleted.
- Each `.ph-line` card stays compact: rank, label/part-number, qty/unit/total, status chip, trailing trash icon.
- Tap on the card (or the existing pencil icon — make the whole row tappable, with the pencil as visual affordance) → pushes to SubmitForm in edit-line mode (S3c). On save, return here with the line updated.
- Warehouse selector — keep the manually styled native select; the design uses the same.
- "Add another <cat>" dashed button — confirm it uses `border: 1.5px dashed var(--border-strong); border-radius: 12px;` (already the case). Tap → pushes to SubmitForm in new-line mode.
- Total cost card, payment segmented control, warehouse, notes, action bar — unchanged.

**Acceptance:** Tapping a line in review opens the full SubmitForm pre-filled with that line's values. Saving updates the line and returns to review. AI rescan inside that edit page works for RAM and merges values without clobbering qty/cost/sellPrice. No more inline-expanded edit form.

### S4. Orders (Orders.tsx)

- Wire the trailing search icon button. Tap toggles a search row beneath the header (collapsible), containing one `.input` field with placeholder `t('searchOrders')`. Filters apply to: order id, line label, brand, part number. The chip scrollers continue to AND with the text query.
- Search row is hidden by default to preserve the design's clean header.
- Pagination: keep `slice(0, 30)` for now; document as known limit in this spec (out of scope for visual parity).
- Pass `scrolled` to PhHeader.
- **Deep-link integration (CC-5):** Subscribe to route; if `#/orders/:id` matches, scroll the matching `.ph-order` into view (with `behavior: 'smooth'`, `block: 'center'`), expand its accordion, and call `onEdit(order)` for non-completed orders.
- **Order ID affordance:** Add a tiny `link` icon button (16px) adjacent to the mono order ID in the `.ph-order-head`. Tap → `navigator.clipboard.writeText(${location.origin}/#/orders/${order.id})` then toast `t('orderIdCopied')`. If `navigator.share` is available, prefer the share sheet with the same URL.

**Acceptance:** Search icon toggles a search bar; typing filters the visible orders live; chip scrollers still narrow further. Tapping the link icon copies the deep link and toasts confirmation. Hitting `#/orders/<id>` directly opens that order expanded.

### S5. Market (Market.tsx)

- Pass `scrolled` to PhHeader.
- The "MAX BUY" dashed strip is rendered for every card today. Reference shows the same — keep.
- No content changes; just confirm the trend chip pos/neg coloring uses `.chip.pos`/`.chip.neg`.

### S6. Inventory (Inventory.tsx) — kept, polished

- Pass `scrolled` to PhHeader.
- Confirm the read-only banner (purchaser) uses `.ph-ai-banner` styling but with `info` tone (background `var(--info-soft)`, text `oklch(0.45 0.13 250)`). If we don't have an `.info` variant of the banner today, add one: extend phone.css with `.ph-info-banner` matching `.ph-ai-banner` shape but info-toned.
- Manager `+` button keeps existing behavior (kicks off capture flow).
- All copy in this page is already through `t()` — verify and fill any gaps.

### S7. Profile (Profile.tsx)

- Notifications row: `onClick` opens `PhNotificationsSheet` (re-use the existing component; lift the sheet open state into MobileApp via prop, or own it inside Profile).
- Security row: `onClick` triggers a toast `t('securitySub')` (since real auth is workspace-admin-managed; no destination needed yet). Mark with a subtle `lock` icon if not already.
- About row: `onClick` opens a small bottom sheet (`PhAboutSheet`) listing version, build, support email. New small component, follows the `.ph-sheet` primitives.
- All four rows must show chevrons consistently and respond to taps.

### S8. PhLanguageSheet (components/PhLanguageSheet.tsx)

- "Follow system" switch — currently keeps local state and never applies. Persist to `localStorage` under `rs.langFollowSystem` and, when on, read `navigator.language` to pick `en` vs `zh` on mount.
- When the switch is on, dim the list (already wired via `.ph-lang-list.disabled`) and the Done button applies the system-derived language.
- All text remains via `t()` (already done).

### S9. PhNotificationsSheet (components/PhNotificationsSheet.tsx)

- Run all hard-coded copy through `t()`: title (`t('notifTitle')`), unread count (`t('notifNUnread', { n })`), all-caught (`t('notifAllCaught')`), mark-all (`t('notifMarkAllRead')`), bottom hint (`t('notifManageHint')`).
- Visual structure already matches the reference.

---

## Out of scope (this pass)

- Replacing `slice(0, 30)` pagination with infinite scroll.
- Avatar upload on Profile.
- Period selector (7d / 30d / 90d) on Dashboard.
- Real notifications backend; current seed stays.
- Order search server-side; we filter the loaded slice client-side.

## Architecture / file plan

- New: `apps/frontend/src/components/PhCategoryFields.tsx`
- New: `apps/frontend/src/components/PhAboutSheet.tsx`
- New: `apps/frontend/src/lib/usePhScrolled.ts`
- New: `apps/frontend/src/lib/route.ts` (hash-routing helpers — CC-5; shared by both surfaces)
- Edited (mobile): every page under `apps/frontend/src/pages/` except `desktop/*`, plus `MobileApp.tsx`, `lib/i18n.tsx`, `components/PhHeader.tsx` (no API change), `styles/phone.css`.
- Edited (desktop, scoped to CC-5 only — not a full desktop parity pass): `DesktopApp.tsx`, `pages/desktop/DesktopOrders.tsx`, `pages/desktop/DesktopEditOrder.tsx`.
- `CaptureState` (MobileApp.tsx) gains:
  - a `'rescan'` phase plus an `editingLineIdx` field on `'rescan'` (CC-4).
  - a `returnTo: 'idle' | 'review'` discriminator on `'camera'` and `'form'` phases (CC-6).

## Testing / verification

This is a visual parity pass on an interactive React app. Verification:

1. `pnpm typecheck` (or `tsc --noEmit`) clean.
2. Manual: each of the 8 reference screens visually matches the bundle's prototypes. We don't render the prototype side-by-side; we read the source (phone-app.jsx + phone-styles.css) and replicate.
3. Manual: each interaction listed in this spec works (camera flash, search toggle, profile row taps, AI rescan).
4. `pnpm build` succeeds.

## Delivery order

One commit per group, sign-off requested after each:

1. **Cross-cutting** (CC-1..CC-7): css additions, scroll hook, unified line-edit refactor, AI rescan plumbing, hash routing (mobile + desktop), back-button fix, i18n keys.
2. **Login + Dashboard** (S1, S2).
3. **Capture flow** (S3a-d, includes the unified edit page and AI rescan).
4. **Orders + Market + Inventory** (S4, S5, S6) — mobile deep-link UX lives here.
5. **Profile + language + notifications sheets** (S7, S8, S9).
6. **Desktop deep-link wiring** (CC-5 desktop half): `DesktopApp.tsx`, `DesktopOrders.tsx`, `DesktopEditOrder.tsx` only — link-icon copy/share affordance and route-sync. No other desktop changes.
