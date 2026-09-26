---
id: RS-111
title: Parallel reads, batched writes, shared modal, search debounce, inventory reload
type: story
status: in-progress
priority: P2
created: 2026-09-26
reporter: jinhu
branch: feat/rs-111-skipped-items
pr:
version:
related: []
---

## Ask

> Deliberately left alone. These would change behaviour or server load:
> - Running request queries in parallel, which could use every prod database connection on one page view.
> - Batching inserts.
> - Switching the hand-built dialogs to the shared modal.
> - Delaying search until typing stops.
> - Changing which filters the inventory reload uses.

Asked which to implement: "Inventory reload filters (Recommended), Search debounce (Recommended), Shared modal for dialogs, Parallel reads + batched inserts, all of them"

## Context

These are the five items RS-108 skipped because each changes behaviour or load.
Plan: `~/.claude/plans/rustling-fluttering-island.md`.

## Acceptance criteria

- [ ] PO and sell-order detail reads run at most 4 at a time; response JSON is unchanged.
- [ ] Line inserts, price adjustments, sold events, bank-sync upserts and OAuth revokes are one statement each; returned ids and counts are unchanged.
- [ ] A duplicate transaction id inside one bank-sync batch no longer risks aborting the sync.
- [ ] After a transfer, the inventory list keeps every active filter.
- [ ] Payments and Internal transactions search waits 200 ms after typing; filter chips stay instant.
- [ ] The listed dialogs use the shared Modal; Escape closes only the top dialog and is ignored while saving; autofocused fields keep focus.

## Out of scope

DesktopSubmit's dialogs (another session is editing that file), ErrorDialog, HandoffDialog and StatusChangeDialog shells, CloseSellOrderDialog, the mobile sheets, and Combobox Escape propagation.
