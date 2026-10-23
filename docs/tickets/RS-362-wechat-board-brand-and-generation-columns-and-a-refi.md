---
id: RS-362
title: WeChat board: brand and generation columns, and a refine filter
type: story
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/featherduster
pr: 838
version: 1.318.0
related: []
---

## Ask

> In this wechat page
> brand should be a dedicated column here:
> [Image #1]
> same as generateion.
>
> I hope to have a filter as well:
> [Image #2]

Image #1 was the price board in its *Brand & code* view, with a "三星 53 lines"
brand header over its lines and DDR5 in the grey line under each module.
Image #2 was the inventory page's **Refine RAM** panel: rows of chips for
Generation, Speed, Brand, Capacity, Device, Form and Rank, each with a count.

## Context

**Monitors ▸ WeChat** (`DesktopWechat.tsx`) groups *Brand & code* lines under
brand header rows (`groupByBrand` in `lib/wechatMarket.ts`, v1.312.2) and shows
a line's `ddr` in its sub-text (`LineName`). Every line of the day is already
on the client, and `WechatRow` carries `brand`, `ddr`, `speed`, `capacityGb`,
`formFactor` and `ranks`, so both the columns and the filter need no backend
change. memtrade sets `brand` only on *Brand & code* lines: spec and part-code
lines add up across brands, so their brand is null. `ddr` is set on all three.

The inventory panel is inline JSX in `DesktopInventory.tsx`, styled by
`inv-subfilter` / `inv-chip` in `desktop.css`.

## Acceptance criteria

- [x] *Brand & code* view: a **Brand** column; the brand header rows are gone;
      lines still sort brand-first (三星, 海力士, 镁光, 长鑫, others, unbranded
      last). An unbranded line reads *No brand given*.
- [x] All three views: a **Generation** column (DDR4/DDR5, `—` when unknown);
      the generation is no longer repeated under the module.
- [x] The spec and part-code views don't show the Brand column (they have no
      brand).
- [x] A collapsible **Refine RAM** panel inside the board card, with the same
      look as the inventory one: rows Generation, Speed, Brand (Brand & code
      only), Capacity, Device (Server/PC), Rank; each chip shows its line
      count.
- [x] Chips are OR within a row and AND across rows. A row's counts follow
      *Priced lines only*, the supply legend and the other rows' picks, not the
      search. The legend's counts follow the picks too.
- [x] A picked value with no lines left stays visible (count 0) and can be
      unpicked; the head shows "N filter(s) active" and *Clear all*.
- [x] Picks hold across a change of day and of view. Clicking a spec in Most
      wanted/offered clears them, and so does the toolbar's *Clear*.
- [x] The inventory Refine panel looks and behaves as before.

## Out of scope

- Translating brand names (三星 → Samsung). They show as memtrade writes them,
  as the headers did.
- A part-code facet; the search already finds codes.
- Keeping the picks across visits to the page.
- Sortable columns.

## Notes

- The panel is lifted out of `DesktopInventory.tsx` into
  `components/RefinePanel.tsx` so the two pages share one implementation and
  one look.
- Two fixes to the shared panel came along, so they reach the inventory page
  too. First, it collapses on `click`, not `mousedown`. A mousedown collapse
  moved what was below it before the mouseup, so the click could miss: a board
  row, or a Most wanted spec once the page was scrolled 39px. It tests
  `composedPath()`, because unpicking a chip nothing matches removes that chip
  before the listener runs. Second, `.inv-chip:hover` outranked `.inv-chip.on`,
  which inked a picked chip's label in its own fill under the mouse.
- Renumbered from RS-360 before merging: PR #836 had claimed that number.
