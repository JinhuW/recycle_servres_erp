# Desktop UI — Design Parity Audit (2026-05-11)

## Purpose

Compare every desktop page and the shared shell against the canonical design
file (`Recycle Servers ERP.html` + companion jsx) and identify visual-parity
gaps. **Scope is visual parity only** — typography, spacing, layout, copy,
component structure, missing CSS classes. Behavior, API wiring, and types are
out of scope unless behavior produces a visible gap.

## Design source

Extracted from the design archive into
`/tmp/design/recycle-servers-inventory-management/project/`.

| Page                       | Design source (jsx)                                             | Current code                                                 |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| Shell + Sidebar + Toast    | `app.jsx` (NAV, Sidebar, Topbar, TweaksPanelMount), `styles.css` | `DesktopApp.tsx`, `components/Sidebar.tsx`                   |
| Dashboard                  | `dashboard.jsx:789-1013` (`DashboardView`)                      | `pages/desktop/DesktopDashboard.tsx`                         |
| Orders (History)           | `dashboard.jsx:78-571` (`HistoryView`)                          | `pages/desktop/DesktopOrders.tsx`                            |
| Edit Order                 | `dashboard.jsx:572-750` (`EditOrderPage`)                       | `pages/desktop/DesktopEditOrder.tsx`                         |
| Market Value               | `market-value.jsx` (entire)                                     | `pages/desktop/DesktopMarket.tsx`                            |
| Inventory                  | `inventory.jsx:3-680` (`InventoryView` + `QuickViewModal`)      | `pages/desktop/DesktopInventory.tsx`                         |
| Activity Drawer            | `inventory.jsx:682-942` (`HistoryDrawer`)                       | `pages/desktop/DesktopActivityDrawer.tsx`                    |
| Inventory Item Edit        | `inventory-edit.jsx` (entire)                                   | `pages/desktop/DesktopInventoryEdit.tsx`                     |
| Sell Orders                | `sell-orders.jsx:489-858` (`SellOrdersView` + `SellOrderDetail`) | `pages/desktop/DesktopSellOrders.tsx`                        |
| Sell Order Draft + Status  | `sell-orders.jsx:127-790`                                       | `pages/desktop/DesktopSellOrderDraft.tsx`, `components/StatusChangeDialog.tsx` |
| Settings (7 tabs)          | `settings.jsx` (entire)                                         | `pages/desktop/DesktopSettings.tsx`                          |
| Submit                     | `app.jsx:99-179` + `submit.jsx`                                 | `pages/desktop/DesktopSubmit.tsx`                            |

## Methodology

Each page was audited by an independent read-only sub-agent against a fixed
checklist (page head; layout; KPI / stat blocks; tables; filters and pills;
modals, drawers, selection bars, steppers; empty/loading/readonly states;
copy and i18n keys; density-mode behavior; CSS classes referenced in design
that are missing from current code). Sub-agent claims were fact-checked
against `tokens.css`, `desktop.css`, `DesktopApp.tsx`, and `Sidebar.tsx`
before inclusion. Corrections are noted inline (✏).

## Severity legend

- **P0** — feature missing entirely or visibly broken.
- **P1** — visible drift (wrong spacing, missing label, wrong class, missing
  modal section).
- **P2** — polish (subtle spacing, animation, micro-copy, secondary text).

## Summary matrix

| Page                       | P0 | P1 | P2 |
| -------------------------- | -: | -: | -: |
| Shell + Sidebar            |  3 |  1 |  1 |
| Dashboard                  |  0 |  1 |  2 |
| Orders (History)           |  0 |  2 |  0 |
| Edit Order                 |  0 |  3 |  3 |
| Market Value               |  0 |  1 |  1 |
| Inventory                  |  0 |  3 |  2 |
| Activity Drawer            |  0 |  2 |  2 |
| Inventory Item Edit        |  2 |  3 |  2 |
| Sell Orders                |  0 |  1 |  0 |
| Sell Order Draft + Status  |  1 |  4 |  0 |
| Settings                   |  2 |  4 |  5 |
| Submit                     |  0 |  4 |  2 |
| **Total**                  |  8 | 29 | 20 |

P0s are concentrated in: missing shell-level affordances (Topbar, role-preview
banner, TweaksPanel), missing Settings tabs (Commission, Workflow), and
Inventory Item Edit's missing sticky save bar + right-rail cards. Most P1/P2
items are isolated to single files and small enough to batch.

## Cross-cutting findings

These appear in multiple pages and are best fixed once at the shared layer:

1. **`.ai-filled` input state never applied**
   The CSS exists at `tokens.css:104` but no desktop tsx applies the class to
   inputs/selects that received AI-extracted data. Visible in Edit Order,
   Submit/LineDrawer.
2. **`.icon-only` button variant missing**
   Several tables in the design use small square icon buttons (~32–36px).
   `tokens.css:274` defines `.btn.icon` (7px padding) but the design uses
   `.btn.icon-only`. Add or rename in CSS, then audit usages.
3. **`marginBottom: 20` between KPI grid and following content**
   Design adds explicit `marginBottom: 18-20` on `.kpi-grid` containers
   (dashboard.jsx:869, market-value.jsx:133). Current uses CSS gap on the
   parent, which is often smaller. Inconsistent rhythm across Dashboard,
   Market, Orders.
4. **`.seg button` padding drift**
   Design styles.css:255 uses `padding: 6px 12px`; current `tokens.css:122`
   uses `8px 12px`. Tightening to design value makes filter rows more compact.
5. **Toast/role-preview banner/Topbar are wired in design but absent from
   `DesktopApp.tsx`**
   Pre-page banner area (workspace label + role-preview alert) is rendered
   inside `<main className="main">` in design but skipped in current code.

✏ **Corrections applied** during fact-check:
- `.toggle` CSS is **present** in `tokens.css:297` (one sub-agent reported it
  missing).
- `.bar-track` / `.bar-fill` are **present** in `desktop.css:222-223`.
- `.ai-filled` selector is **present** in `tokens.css:104`; the gap is
  application in tsx, not the stylesheet.
- `.toast` / `.toast-wrap` are **present** in `desktop.css:294-310` and wired
  in `DesktopApp.tsx:94-101`.

---

## Page-by-page audit

### Shell + Sidebar + Toast

**Design:** `app.jsx` + `styles.css` · **Current:** `DesktopApp.tsx`,
`components/Sidebar.tsx`, `styles/desktop.css`, `styles/tokens.css`

Sidebar grid (240px + 1fr), brand mark, nav buttons with active state and
badge, sidebar foot avatar, and toast wrap all match. Three structural
shell-level affordances are missing.

**Gaps**

- **[P0] Topbar missing from main content.** Design renders a workspace label
  (`Admin Workspace` / `Purchaser Workspace`) above every page
  (`app.jsx:15-25`, mounted at `app.jsx:285`). Current `DesktopApp.tsx` mounts
  the page directly. Add a `<Topbar />` slot inside `<main className="main">`
  before `<div className="page">`.
- **[P0] Role-preview banner missing.** Design lets a manager preview as
  purchaser; when active, a warning banner appears at the top of `<main>`
  (`app.jsx:279-284`). Current code has no preview mode wired. The banner CSS
  uses `var(--warn-soft)` and an Eye icon.
- **[P0] TweaksPanel mount missing.** Design surfaces a developer/admin
  tweaks panel for language, density, and role-preview toggles
  (`app.jsx:307`). Current desktop has no equivalent. Density and role
  preview are unreachable from the UI.
- **[P1] Language toggle absent in main shell.** A compact `EN/中` segmented
  toggle exists on Login (`pages/Login.tsx:14`) but not in the authed shell.
  Design surfaces it via `TweaksPanelMount`.
- **[P2] `.seg button` padding drift.** Design 6px vs current 8px in
  `tokens.css:122`. See cross-cutting #4.

**Matching**: sidebar grid, brand, nav-section heading, nav-item / active
state / badge, sidebar-foot avatar, toast-wrap + toast styling and wiring.

---

### Dashboard

**Design:** `dashboard.jsx:789-1013` · **Current:**
`pages/desktop/DesktopDashboard.tsx`

Major sections — KPI grid, range segmented control, trend chart, category
breakdown, leaderboard with medal ranks — are implemented. Current adds a
"Recent Activity" table (lines 214-257) not in design; not a gap.

**Gaps**

- **[P1] KPI grid → next-section spacing.** Design sets `marginBottom: 20`
  on `.kpi-grid` (`dashboard.jsx:869`). Current relies on parent gap which is
  smaller. `DesktopDashboard.tsx:72`.
- **[P2] Category breakdown card-head layout.** Design lays subtitle as a
  separate span (`dashboard.jsx:908-909`); current wraps it in card-head flex
  (`DesktopDashboard.tsx:118-121`). Minor difference, visually similar.
- **[P2] Leaderboard card outer spacing.** Card relies on page-level
  flex/grid gap; design uses explicit 20px between KPI grid and leaderboard.

**Matching**: page title/sub (manager vs purchaser variant), 4-col KPI tiles
with mono values and trend arrows, range seg control, 2fr/1fr layout
(`trend | categories`), SVG trend chart with axes and gradient, leaderboard
with rank medal classes, segmented filter, table with avatar+name cells,
empty-state with reset link, hover rows, right-aligned numerics.

---

### Orders (History)

**Design:** `dashboard.jsx:78-571` · **Current:**
`pages/desktop/DesktopOrders.tsx`

Filter pills, status filters, sort carets, KPI strip, and column-visibility
menu are all present. Two structural deltas in the per-order expanded view.

**Gaps**

- **[P1] Expanded line-item table missing columns.** Design has 9 columns
  (`#`, Item, Part #, Qty, Unit Cost, Sell/Unit, **Revenue**, **Profit**,
  Status). Current has 7 (no `#`, no Revenue, no Profit) and shifts Condition
  to its own column. `DesktopOrders.tsx:549-571`.
- **[P1] Line-item subtitle pattern divergence.** Design renders specs as a
  multi-line subtitle below the item name (RAM:
  `classification · rank · speed`; SSD: `formFactor`; Other: `condition`).
  Current renders Condition in its own column instead.
  `DesktopOrders.tsx:562-564`.

**Matching**: sort caret with active opacity 1 / inactive 0.32, sort cycle
desc→asc→reset, persisted column visibility, KPI strip (orders/revenue/
profit/commission), status filter card with tone dots and counts, warehouse
pill in row, category chip tones (RAM=info / SSD=pos / Other=warn), profit
`.pos` color, row hover, empty-state message.

---

### Edit Order

**Design:** `dashboard.jsx:572-750` + `submit.jsx:223-444` (LineItem) ·
**Current:** `pages/desktop/DesktopEditOrder.tsx`

The status stepper, readonly banner, and order-meta row are well matched.
Line-item editing diverges: design uses a per-line modal card with full spec
fields, AI-filled badges, and photo capture; current uses a compact in-table
row editor.

**Gaps**

- **[P1] Line-item modal vs in-table edit.** Design uses `LineItem`
  (`submit.jsx:243-256`) — multi-field card with Brand, Capacity, Type, etc.
  Current uses cells with `.so-mini-input` only. `DesktopEditOrder.tsx:153-230`.
- **[P1] `.ai-filled` class never applied to inputs.** CSS present
  (`tokens.css:104`); should highlight fields that received AI-extracted
  values. `DesktopEditOrder.tsx:153-230`. (Cross-cutting #1.)
- **[P1] AITag indicator missing.** Design renders a small "AI ✦" chip near
  AI-populated fields (`submit.jsx:140`). Not rendered in current.
- **[P2] Photo placeholder column missing.** Design includes a thumb/camera
  affordance on each line (`submit.jsx:247-250`); current omits it. Confirm
  with PM whether this is intentional for desktop.
- **[P2] Sub-label rendering.** Design `.label` supports a smaller hint line
  below; current renders single-line labels only.
  `DesktopEditOrder.tsx:342, 400`.
- **[P2] Readonly state granularity.** Current applies `.order-readonly` to
  the wrapper card (`DesktopEditOrder.tsx:131`); design applies dimming at
  the per-input level. Effectively similar, but blanket dim feels heavier.

**Matching**: page head (title + ID chip + category badge + sub-text with
submitter and line count), full status stepper (`.so-stepper / .so-step /
.so-step-dot / .so-step-bar / .so-step.locked`), order-meta 4-col grid,
shipped/draft/status-change banners, bottom save/cancel actions.

---

### Market Value

**Design:** `market-value.jsx` (389 lines) · **Current:**
`pages/desktop/DesktopMarket.tsx`

Near-complete parity. KPI tiles, trend badges, demand pills, dual-line
chart, expandable detail rows, and guide rows all match.

**Gaps**

- **[P1] TrendBadge "flat" threshold drift.** Design treats `|value| < 0.5`
  as flat (i.e. ±0.5%, `market-value.jsx:32`); current treats
  `|value| < 0.005` as flat (`DesktopMarket.tsx:32`). Current is 100×
  stricter, so sub-0.5% moves render an arrow instead of "Flat".
- **[P2] KPI grid spacing.** Design adds `marginBottom: 18`
  (`market-value.jsx:133`); current omits it. (Cross-cutting #3.)

**Matching**: page head, how-to banner with gradient, 3-col KPI layout with
icon backgrounds and tone, segmented filters + sort dropdown + search,
table column alignment (.num right-aligned), DemandPill chip styling,
sparkline SVG, expandable row chevron, DetailExpand 3-col layout, GuideRow
emphasis tones, DualLineChart with cost dashed line and sell area fill,
empty-state, footer formula explanation.

---

### Inventory

**Design:** `inventory.jsx:3-680` · **Current:**
`pages/desktop/DesktopInventory.tsx`

Table structure, warehouse pill filter, dark selection bar, segmented
filters, qty status indicators, and column-visibility menu match. Two
notable gaps in supporting affordances.

**Gaps**

- **[P1] Page subtitle copy drift.** Design says
  `Select rows in Ready or Selling status` (`inventory.jsx:133`); current
  says `Select rows in Reviewing or Done status`. Wrong statuses described.
  `DesktopInventory.tsx`.
- **[P1] QuickView linked-orders section missing.** Design's `QVLinkedOrders`
  (`inventory.jsx:628-673`) renders a grid of sell orders that consume the
  inventory item. Current `InventoryQuickView` ends at submitter info
  (around `DesktopInventory.tsx:775`) without this block.
- **[P1] Readonly banner "Request edit" affordance.** Design's read-only
  banner (around `inventory.jsx:178-183`) includes a "Request edit" link.
  Current `DesktopInventory.tsx:292-305` omits it.
- **[P2] Warehouse filter row spacing.** Design uses `marginBottom: 14`
  (`inventory.jsx:268`); current relies on implicit flex gap.
- **[P2] Density-mode wiring.** CSS overrides for
  `[data-density="compact"]` exist, but no UI surfaces the toggle in the
  authed shell (depends on TweaksPanel — see Shell P0).

**Matching**: `.wh-pill` filter with count badge and active state, floating
`.sel-bar` (dark, fixed bottom, dividers, accent pill), uppercase table
headers with subtle color and tabular nums, qty status dot+striped pattern
for in-transit / solid for done, chips for category/status, QuickView 2-col
key-facts grid, column visibility menu with All/None.

---

### Activity Drawer

**Design:** `inventory.jsx:682-942` · **Current:**
`pages/desktop/DesktopActivityDrawer.tsx`

Drawer width (680px), entrance animation (`drawer-in`), filter bar, sticky
day headers, timeline rail, and event card layout all match. Four small
refinements.

**Gaps**

- **[P1] Scope toggle (all vs item) missing.** Design conditionally renders
  an item-scoped header with item ID and specs when `scope === 'item'`
  (`inventory.jsx:768-776`). Current always shows the workspace-wide log.
  `DesktopActivityDrawer.tsx:105-128`.
- **[P1] Immutable chip styling — class vs inline.** Design uses
  `className="chip"` with color-mix backdrop (`inventory.jsx:758-765`);
  current uses inline styles (`DesktopActivityDrawer.tsx:109-119`).
  Functionally similar but inconsistent with the rest of the system.
- **[P2] Timeline dot icon stroke.** Design passes `stroke={2}` on the dot
  icon (`inventory.jsx:858`); current omits (`DesktopActivityDrawer.tsx:214`).
- **[P2] Footer icon: shield vs lock.** Design uses a shield icon for the
  audit/immutability footer (`inventory.jsx:936`); current uses lock
  (`DesktopActivityDrawer.tsx:230`).

**Matching**: drawer width and animation, header with icon/title/badge/sub/
close, segmented filter with counts + search, sticky day groupings,
timeline event cards (summary, status chips with from→to, user avatar and
ID), backdrop blur, Escape-to-close.

---

### Inventory Item Edit

**Design:** `inventory-edit.jsx` (entire) · **Current:**
`pages/desktop/DesktopInventoryEdit.tsx`

Two-column layout, tab navigation, stock-allocation table, and activity
timeline all match. The biggest gaps are in the right rail and around the
sticky save bar.

**Gaps**

- **[P0] Sticky save bar missing.** Design renders a bottom-anchored save
  bar with an "Unsaved" chip and contextual messages when the form is
  dirty (`inventory-edit.jsx:769-786`). Current has no sticky footer.
- **[P0] Right rail cards incomplete.** Design's sticky right rail stacks
  Summary, **Internal notes**, **Submitted by**, **Danger zone** cards.
  Current has only a summary-style block (`DesktopInventoryEdit.tsx:769-825`).
- **[P1] `.btn.icon-only` variant missing.** Design uses 32-36px square
  icon buttons in table rows; current `tokens.css:274` defines `.btn.icon`
  (7px padding) which renders differently. Add `.btn.icon-only` or rename.
  (Cross-cutting #2.)
- **[P1] Stock row action column.** Design conditionally renders a
  "View X stock" arrow on non-current warehouses with stock
  (`inventory-edit.jsx:420-428`). Current reserves the column
  (`<th style={{ width: 36 }}>` at `DesktopInventoryEdit.tsx:426`) but
  doesn't render the buttons.
- **[P1] Stock card head layout.** Design uses a 2-col `card-head`
  (title left, mini KPIs right) at `inventory-edit.jsx:335-351`; current
  uses a simpler single-column head.
- **[P2] Details tab read-only spec rows.** Design styles them as a
  grid-2 read-only layout (`inventory-edit.jsx:349-357`); current uses a
  custom `Row` component rendered as a disabled `.input`.
- **[P2] Tab styling polish.** Inline `<button className="tab active">`
  rendering works; design wraps icon + label + count chip more tightly
  (`inventory-edit.jsx:175-193`).

**Matching**: breadcrumb + page head + actions, two-column main grid
(`1fr 320px`, sticky right), tab nav with icon and count, card framing,
stock allocation table columns, pricing/quantity 3-col stat cards,
activity log timeline, mono fonts, tone colors.

---

### Sell Orders

**Design:** `sell-orders.jsx:489-858` · **Current:**
`pages/desktop/DesktopSellOrders.tsx`

Excellent parity. KPI/stat tiles, 4-step status stepper, status chips,
table columns, detail modal, line-items readonly table, and footer
actions all match. Only one observed text gap.

**Gaps**

- **[P1] Customer secondary text.** Design displays the customer region as
  secondary text below the customer name in the table
  (`sell-orders.jsx:576`); current shows the name again
  (`DesktopSellOrders.tsx:209`).

**Matching**: `.so-stat` cards (counts, revenue, active border/shadow),
status stepper (dots, bars, reached/active states), status chip tones
(`muted`/`info`/`warn`/`pos`) with dot prefix, full table columns
(Order/Customer/Created/Lines/Units/Total/Terms/Status/Actions), detail
modal head (ID + chip + customer + metadata), detail footer (Close / Edit /
Save), line-items table, totals summary, `.table-scroll` wrapper,
modal-backdrop click-to-close, copy and i18n keys.

---

### Sell Order Draft + Status Change Dialog

**Design:** `sell-orders.jsx:127-790` · **Current:**
`pages/desktop/DesktopSellOrderDraft.tsx`, `components/StatusChangeDialog.tsx`

Two-pane layout, warehouse-grouped line tables, mini-inputs, summary card,
tip box, and footer all match. Three substantive gaps in the editing
affordances.

**Gaps**

- **[P0] Status stepper missing inside the draft modal.** Design includes
  a full Shipped → Awaiting payment → Done stepper inside
  `SellOrderDraftModal` (`sell-orders.jsx:258-314`); current has no stepper
  in `DesktopSellOrderDraft.tsx`. (Only the standalone Edit Order page has
  it.)
- **[P1] CustomerCombobox inline-create missing.** Design exposes
  "add new customer" inline within the combobox
  (`sell-orders.jsx:104-118`). Current `CustomerPicker`
  (`DesktopSellOrderDraft.tsx:204-212`) is read-only — no create flow.
- **[P1] Summary: cost basis + margin rows.** Design `.so-summary` shows
  Cost basis / Profit / Margin (`sell-orders.jsx:429-434`). Current shows
  profit only and is missing the Cost basis label
  (`DesktopSellOrderDraft.tsx:350-365`).
- **[P1] Summary total binding.** Design totals row uses
  `totals.total` (profit-inclusive) (`sell-orders.jsx:424`); current uses
  `totals.subtotal` (`DesktopSellOrderDraft.tsx:355`).
- **[P1] Save button copy.** Design switches between "Save changes" (edit)
  and "Save draft" (new) based on `existingOrder`
  (`sell-orders.jsx:455 / 459`); current always says "Save draft"
  (`DesktopSellOrderDraft.tsx:386`).

**Matching**: two-pane layout (`.so-body`/`.so-main`/`.so-aside`),
warehouse-grouped line table (`.so-wh-head` / `.so-line-table`), summary
card structure (`.so-summary` / `.so-row` / `.so-divider` / `.so-row.total`),
tip box, footer with date + actions, mini-input styling and focus state,
StatusChangeDialog (drag-drop attachments, note, file list, removal), modal
shell + backdrop + chip tones, max-width 1100px.

---

### Settings

**Design:** `settings.jsx` (1921 lines) · **Current:**
`pages/desktop/DesktopSettings.tsx` (1529 lines)

Settings shell, tab nav layout, page header, modal architecture, role
picker, warehouse grid, category list, radio rows, password meter, and
data-table styles all match. Two **whole tabs** are missing.

**Note:** Earlier sub-agent reports flagged `.toggle` and `.bar-track` CSS
as missing — fact-check confirms both are present (`tokens.css:297`,
`desktop.css:222`). Those have been removed from the gap list.

#### Tab nav

- **[P0] Commission tab missing entirely.** Design tab is
  `settings.jsx:1385-1497` (tiered commission table, payout schedule
  radios, approval toggles). Current `SECTIONS` array
  (`DesktopSettings.tsx:85-91`) has 5 entries: members / warehouses /
  customers / categories / general — no commission.
- **[P0] Workflow tab missing entirely.** Design tab is
  `settings.jsx:1605-1899` (order lifecycle stage editor with drag,
  color pickers, pipeline preview). Not in `SECTIONS`.

#### Tab: Members

- **[P2] Member cell spacing inline vs class.** `<div className="member-cell">`
  uses inline gap (`DesktopSettings.tsx:554`); design uses a CSS-defined
  spacing. Minor.
- **[P2] Pending invites card gradient.** `.pending-card` gradient is
  defined in `desktop.css` — verify it renders against the current DOM.

#### Tab: Warehouses

- **[P1] `.wh-add:hover` icon swap.** Design switches `.wh-add-icon` color
  on hover; current may not. `desktop.css` has the rules; verify against
  the rendered DOM.
- **[P1] Capacity percentage class binding.** Hardcoded in JS
  (`DesktopSettings.tsx:1229-1232`) rather than chip/tone classes. Matches
  intent but inconsistent with the chip system elsewhere.

#### Tab: Customers

- **[P1] `StatTile` not using `.card`.** Inline styles at
  `DesktopSettings.tsx:66-78`; design uses the shared `.card` shell.
- **[P2] Outstanding A/R color via inline `style`.** Line 1038 uses
  `style={{ color: 'var(--warn)' }}` instead of a `.chip.warn` /
  `.text-warn` utility. Inconsistent with the chip system.

#### Tab: Categories

- **[P2] Category icon flex vs grid.** `.cat-icon` is defined as
  `display: grid; place-items: center` (`desktop.css:859`). Confirm tsx
  uses the class and not inline `display: flex`.
- **[P2] Margin number input class.** `<input style={{...}}>` at
  `DesktopSettings.tsx:261-270` should use `.input` to pick up focus ring
  and shared styling.

#### Tab: General

- **[P1] `.field-hint` vs `.help` class drift.** Design uses
  `<div className="field-hint">` (`settings.jsx:1532`); current uses
  `<div className="help">` (`DesktopSettings.tsx:331, 807, 842`). Both
  styles exist but the design intent is the `.field-hint` semantic. Either
  alias one to the other, or migrate usages.

**Matching**: settings-shell two-col grid, `.settings-nav-item` with icon /
label / sub, page header, SettingsHeader component, data-table, modal
architecture, role-picker (`.role-card` active states), warehouse grid
(`.wh-grid`/`.wh-card`), category list (`.cat-list`/`.cat-opt`), radio
rows, toggles, invite list, security cards, password meter, avatar sizes,
chip tones, segmented controls.

---

### Submit

**Design:** `app.jsx:99-179` (`SubmitView` category picker) + `submit.jsx`
(`OrderForm`, `LineItem`, `CameraModal`, `PhotoLightbox`) · **Current:**
`pages/desktop/DesktopSubmit.tsx`

Category picker, line-item table, LineDrawer modal, RAM/SSD fields, meta
section, and footer all match. Camera / photo lightbox / AI visuals are
intentionally desktop-omitted (see file comment at `DesktopSubmit.tsx:19`).

**Gaps**

- **[P1] `.ai-filled` not applied to populated inputs in LineDrawer.**
  Design adds `.ai-filled` via `className={'select' + aiCls('brand')}`
  (`submit.jsx:292`). Current `LineDrawer` (`DesktopSubmit.tsx:593`)
  doesn't add the class. CSS is present (`tokens.css:104`).
  (Cross-cutting #1.)
- **[P1] `.ai-banner` post-scan results banner missing.** Design renders
  it after a successful capture (`styles.css:434-443`); current omits.
- **[P1] AI dot pulse indicator.** `.ai-dot` is defined in `tokens.css`
  but not used in any desktop tsx — design uses it during scan/process.
- **[P1] OrderForm footer stepper.** Design renders a `.stepper` for
  multi-step flows; current footer has no progress indicator.
  `DesktopSubmit.tsx:470-501`.
- **[P2] Missing i18n keys.** Design references
  `t('aiLabelCapture')`, `t('manualEntry')`, `t('changeItemType')`,
  `t('multipleLineItems')` (`app.jsx:118-154`). Confirm presence in
  `lib/i18n.tsx`.
- **[P2] `.scan-line` animation missing in desktop.css.** CSS is in
  `tokens.css:215-227` so it's available, but `desktop.css` doesn't carry
  any camera/RAM-stick illustration classes; this is by design for the
  desktop variant.

**Matching**: 3-card category picker (RAM / SSD / Other with tag chips and
icons), `.chip` tone variants, line-item table with `.row-hover`,
LineDrawer (right-slide modal with Escape-to-close), RamFields / SsdFields
with `.grid-2 / .field / .label / .req / select`, warehouse + payment +
notes meta section, sticky bottom card with submit action.

**Intentional desktop omissions** (per `DesktopSubmit.tsx:19-20` comment):
camera modal, photo lightbox, RAM-stick illustration, cam-frame /
cam-corners. These are mobile-only.

---

## Next steps

1. **User reviews this audit.** Confirm severity calls and flag any P0/P1
   items that are actually intentional product decisions (especially the
   Edit Order line-item modal vs in-table editor, and the Inventory Item
   Edit right-rail cards).
2. **Bundle into a single design spec** under
   `docs/superpowers/specs/2026-05-11-desktop-design-parity-fixes.md`,
   grouping fixes into batches:
   - Batch A — shared CSS and shell affordances (Topbar, role-preview,
     `.icon-only`, `.seg` padding, KPI margin)
   - Batch B — copy and tone fixes (Inventory subtitle, SellOrders region,
     SellOrderDraft Save copy, TrendBadge threshold)
   - Batch C — Edit Order line-item modal + `.ai-filled` application
   - Batch D — InventoryEdit sticky save bar + right-rail cards
   - Batch E — SellOrderDraft summary + stepper + customer combobox
   - Batch F — Settings Commission tab
   - Batch G — Settings Workflow tab
3. **Then invoke `superpowers:writing-plans`** to convert the fix spec
   into a per-batch implementation plan with TDD checkpoints.
