---
id: RS-245
title: Inventory groups DDR5 RAM by spec, not part number
type: story
status: backlog
priority: P2
created: 2026-10-13
reporter: jinhu
branch: feat/ddr5-spec-grouping
pr:
version:
related: [RS-244]
---

## Ask

> Do you still recall how we group the ram in the inventory?
>
> I would like to group all DDR5 cuz the buyer does not care about the part number.
>
> They only care about the type, capacity, rank, speed, class.

Asked whether the scope was DDR5 only and whether brand stayed out of the key:

> 1. Only DDR5.
> 2. Brand should also take into count. i missed this one.

## Context

Inventory's grouped view (`GET /api/inventory/products`, and the grouped
export) collapses lots under `productGroupKey` in `routes/inventory.ts`: RAM
by module family since v1.244.0 (the part number with the maker's packaging
suffix dropped — `M393A2K43BB1-CTD*`), everything else by canonical part
number, and a lot with no part number as its own singleton. DDR5 buyers shop
by spec: a Samsung 32GB 2Rx4 4800 RDIMM is the same product whether the
stick is `M321R4GA3BB6-CQK` or `M321R4GA3BB6-CQKET`, and the family rule
only reads Samsung, Hynix and Micron anyway. Grouping DDR5 by its spec
fields gives the buyer-facing view one row per thing they would buy.

## Acceptance criteria

- [ ] DDR5 RAM lots group by Brand + Type + Capacity + Rank + Speed + Class;
      the part number and chip # play no part. A DDR5 lot with no part
      number joins the group its spec names.
- [ ] A DDR5 group whose lots carry different part numbers shows no single
      part number in its row — the "N part numbers" line and its hover list
      them — and the grouped export lists them comma-separated.
- [ ] A DDR5 lot with one of the six fields blank is its own product (blank
      keys on blank), never merged into a filled one.
- [ ] DDR3 and DDR4 lots group exactly as before (family, then canonical
      part number, then singleton).
- [ ] Picking a DDR5 lot into a sell order or Quick View still carries that
      lot's own part number.
- [ ] Unit tests cover the key; a route test covers the grouping.

## Out of scope

- DDR4 — explicitly kept on the family rule.
- The sell-order "Add from inventory" picker, which groups by part number
  and is a separate surface.
- Market values / price list, which key on part number.

## Notes

- The key is `ddr5SpecKey()` in `packages/shared/src/ramFamily.ts`, next to
  the family rule it takes precedence over, with the same normalisation
  (trim, case-fold, collapsed whitespace) on every field.
