---
id: RS-229
title: Group RAM by part-number family in inventory
type: story
status: in-progress
priority: P2
created: 2026-10-11
reporter: jinhu
branch: feat/ram-part-families
pr:
version:
related: [RS-228]
---

## Ask

> right now, we have too many dueplicate ram types.
> [Image #1]
> for example this. they should be the same, but they are count as a different.
>
> In our inventory, I hope we can think of how to group them together.
>
> NOt just the samsung, but also other brand.
>
> The main thing we are care about are the chips + speed + capacity. Based on this theory, i hope to group them.

> Some of my idea may group M393A2K43BB1-CTD M391A2K43BB1-CTDQ -> M391A2K43BB1-CTDxx

> Let we seperate UDIMM with RDIMM also.

(Image #1: two grouped Inventory rows, "Samsung 16GB DDR4 · Server · RDIMM ·
2Rx8 · 2666 MHz" `M393A2K43BB1-CTD7Q` and "Samsung 16GB DDR4 · Server · UDIMM
· 2Rx8 · 2666 MHz" `M391A2K43BB1-CTDQ`.)

When asked, the requester chose: group by part-number family, keep brands
separate, keep module forms separate (first RDIMM + ECC UDIMM were to merge,
then "Let we seperate UDIMM with RDIMM also").

## Context

The grouped Inventory view merged lots only when their canonical part numbers
were identical. A RAM part number ends in codes that name neither the chips,
the speed nor the capacity — Samsung's packaging/PCB suffix (`-CTD` vs
`-CTD7Q` vs `-CTDQ`), Micron's marking (`-2G1A2II` vs `-2G1A2KJ`), an `O`
read for a `0` (`CQKOL`) — so one module showed as several products.

## Acceptance criteria

- [x] RAM lots whose part numbers differ only after the speed code (Samsung,
      SK Hynix DDR3/4) or after the die revision (Micron) are one product in
      the grouped view and the grouped export.
- [x] Module form, die, organisation and speed still separate products:
      `M393…` (RDIMM) and `M391…` (ECC UDIMM) stay two rows.
- [x] A merged product shows its family as `M393A2K43BB1-CTD*`, lists the
      member part numbers on hover, and its lots table gains a Part # column.
- [x] Part numbers no scheme reads (OEM, Corsair, G.Skill, Kingston, Hynix
      DDR5) group exactly as before.

## Out of scope

- Market values, chip # auto-fill and the sell-order picker stay keyed per
  canonical part number.
- Kingston `KSM…/16HDI` vs `…MEI`: the suffix names the dies, so it must not
  merge.

## Notes

Decoder: `packages/shared/src/ramFamily.ts`, beside RS-228's
`ramPartDecode.ts`. On 200 real market-list RAM part numbers it reads 96 and
merges 7 pairs, all suffix variants.
