# Inventory: select / unselect all in current filter

2026-07-19 · desktop shell only · no backend changes

## Problem

The desktop inventory page selects lots one checkbox (or one product group)
at a time. There is no way to select everything matching the active filters
in one action, which makes bulk transfers and sell orders tedious.

## Design

### Scope of "all"

The **filter-sellable set**: every lot with status `Reviewing` or `Done`
across the currently listed product groups, further restricted lot-by-lot to
the active warehouse filter. Category, search, sold/pending toggles, and
attribute chips are already applied by `/api/inventory/products` to the
loaded groups, so the set inherits them.

Known limit: in a `mixed_spec` group, individual lots don't carry spec
fields in the payload, so attribute chips apply at group level there — the
same semantics the table already displays.

### Controls

Two controls, one shared toggle handler (managers only):

1. **Table header checkbox** in the existing empty first `<th>` of
   `InventoryProductTable` — checked when every filter-sellable lot is
   selected, indeterminate when some are, unchecked otherwise. This is the
   entry point when nothing is selected yet (the floating toolbar is hidden
   in that state).
2. **Toolbar button** in the floating `sel-bar`, next to Clear — labelled
   "Select all (N)" when the set isn't fully selected, "Unselect all" when
   it is.

### Toggle semantics

Mirrors the existing per-group checkbox: if every filter-sellable lot is
already selected → remove exactly those ids from the selection; otherwise →
add them all. Unselect-all only removes lots in the current filter;
selections made under other filters survive. "Clear" remains the full wipe.

### Implementation shape

- `DesktopInventory.tsx`: a `useMemo` computes the filter-sellable id list
  from `products` + `warehouseFilter`; derives
  `selectAllState: 'none' | 'some' | 'all'` and a `toggleSelectAll`
  callback. Renders the toolbar button; passes state + callback to
  `InventoryProductTable`.
- `InventoryProductTable.tsx`: renders the header checkbox (manager only)
  with `indeterminate` set via ref.
- New strings go through `useT()` (en + zh).
