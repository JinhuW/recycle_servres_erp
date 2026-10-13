---
id: RS-247
title: Pre-release review fixes for the v1.254 release
type: bug
status: in-progress
priority: P1
created: 2026-10-13
reporter: jinhu
branch: fix/prerelease-rs246
pr:
version:
related: [RS-239, RS-240, RS-241, RS-242, RS-243, RS-244, RS-245]
---

## Ask

> /code-review high dev to main branch. fix all issue you found and release to prod.

## Context

`/code-review high` ran over dev against main, which was v1.247.2 → v1.253.0: the after-sales cases
(RS-241), the sell-order notes, products toolbar and search (RS-239, RS-240), the PO list's warehouse and payment chips
(RS-242), the DDR3 required-field relaxation (RS-244) and the grouped-inventory warehouse-pill fix
(RS-243). RS-245 (v1.254.0, inventory groups DDR5 by spec) landed on dev after the review ran, so it rides
this release without having been in its scope.

Each finding was checked against the code; all ten hold and all ten are fixed here.

| # | Finding | Verdict |
|---|---|---|
| 1 | An after-sales case in *Awaiting return* could have its resolution PATCHed to Discount or cleared; the status route only lets a return await the goods, so the guard held on entry only | **Fixed**: the PATCH refuses with 409 while the case awaits its goods; the page disables the select there |
| 2 | The DDR3 synthetic part # was built from whichever of capacity/type was filled, so `DDR3_8GB` and `DDR3_8GB_Server` were two inventory products. The forms require both, but the API didn't | **Fixed**: the RAM rule needs both; one alone gives no part number |
| 3 | The new-case form's qty field clamped on every keystroke: it could not be emptied or retyped | **Fixed**: the text is kept while typing and clamped on blur |
| 4 | A typed internal note on the sell-order view page was dropped without a word on Back, a link or reload; the edit form asks | **Fixed**: the unsaved guard covers the view-mode note |
| 5 | The after-sales summary tiles were re-fetched on every search keystroke and status pick | **Fixed**: once per visit |
| 6 | The manager-picker fetch was written four times and the after-sales status / caseable-status lists three times, across backend and frontend | **Fixed**: `AFTER_SALES_STATUSES`, `AFTER_SALES_RESOLUTIONS`, `CASEABLE_SELL_STATUSES` in `@recycle-erp/shared`; `useManagerOptions()` in `lib/useManagers.ts`. The PO edit page keeps its own list (it needs every member) and the phone PO page its lazy one |
| 7 | `addLines` on the sell-order editor set the draft from the render's snapshot rather than a functional update | **Fixed**: functional update; the added-row flash is keyed by lot |
| 8 | A whitespace-only note on a case status move was refused as "too long" | **Fixed**: a blank note is no note; a non-string is still a 400 |
| 9 | The new-case form showed the sell order's raw status id, where the other pages show the status's short label | **Fixed**: `sellOrderStatusShort()` in `lib/lookups.ts`, used by both |
| 10 | A remembered warehouse pick with no PO in the current scope (role preview, scope switch) left the PO list empty with no chip pressed | **Fixed**: such a pick reads as All until the scope has it again; the stored pick is kept |

## Acceptance criteria

- [x] PATCH `resolution: 'discount'` or `''` on an *Awaiting return* case → 409 naming Return; the page's
      save (`resolution: 'return'` resent) → 200.
- [x] `synthesizePartNumber('RAM', { generation: 'DDR3', capacity: '8GB' })` is null; the two-part key is
      unchanged; the SSD MIXED rule still skips blanks.
- [x] The new-case qty field can be cleared and retyped; it clamps to `1..qty` when it loses focus.
- [x] Leaving a sell-order view page with an unsaved note asks first.
- [x] `/api/after-sales/summary` is requested once when the list opens.
- [x] A status move with `note: '   '` → 200, event note null; `note: 5` → 400; 4001 chars → 400.
- [x] The new-case form shows the status short label, in the chip and in the not-eligible message.
- [x] A PO list whose remembered warehouse has no PO in scope shows All pressed and the full list.

## Out of scope

Hoisting the phone PO page's lazy manager fetch (it loads behind the commission fold, a different shape).

## Notes

Plan: `~/.claude/plans/rippling-leaping-token.md`.
