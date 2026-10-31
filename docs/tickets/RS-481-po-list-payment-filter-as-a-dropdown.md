---
id: RS-481
title: PO list payment filter as a dropdown
type: story
status: done
priority: P2
created: 2026-10-31
reporter: jinhu
branch: JinhuW/blenny
pr: "#1027"
version: 1.394.0
related: []
---

## Ask

> Pls use dropdown here:
>
> [Image #1]

(The screenshot is the desktop PO list's PAYMENT chip row: All 15, Business
13, Bonian 0, Chris 0, Cynthia 0, Harrison 2, Jinhu 0, Stefen 0, Tao Wu 0,
Test 0, Tim Wu 0.)

## Context

The payer chips date from v1.252.0. `DesktopOrders.tsx` builds them from
`payerOptions()` and counts them with `facetCounts()` (`lib/poFacets.ts`), one
chip per person who paid a PO in scope. With ten payers the row runs the
card's full width and most chips read 0. The pick persists under
`desktop.orders.payment`.

## Acceptance criteria

- [x] The Payment group in the PO list's facet rail is one dropdown: All,
      Business, then each payer, each with its count (`Harrison (2)`).
- [x] A pick filters the table as the chip did; All clears it; the pick is still
      remembered across open-PO → back (in-memory, as before) and still reads as All when no PO answers to it.
- [x] A non-All pick looks pressed, like an active chip.
- [x] Warehouse chips, the stage rail and the count logic are unchanged.

## Out of scope

Warehouse chips (few, and they read well as chips). Mobile has no payer chips.

## Notes

A native `<select>` (the `.select` look other filters use), not a custom
menu: counts ride in the option text. Verified locally: Business filtered
64 → 44 rows.
