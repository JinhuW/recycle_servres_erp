---
id: RS-226
title: Pack mode filter also finds lots by PO number
type: story
status: done
priority: P2
created: 2026-10-10
reporter: jinhu
branch: feat/pack-search-po
pr: 598
version: 1.241.0
related: [RS-225]
---

## Ask

> Pack should also able to searh by PO number

## Context

Pack mode's scan box (`DesktopSellOrderPack.tsx`) filters as you type with
Review mode's `filterScan` (`lib/boxCheck.ts`), which matches part numbers and
serials only. A sell order draws its lots from several POs, and each pack row
already prints "From PO-1319 #1", but there was no way to narrow the list to one
PO's lots. RS-225 (v1.240.0) added the PO-side counterpart to the inventory
search.

## Acceptance criteria

- [x] Typing a PO number in Pack mode's scan box (`PO-1343`, `po1343`, or
      just `1343`) lists only the lots that came from that PO.
- [x] Part-number and serial filtering are unchanged.
- [x] Enter on a PO number keeps the filter up and shows no "nothing matches"
      error. It packs nothing, because a PO number names lots, not one unit.

## Out of scope

- Review mode (box check): it works on a single PO, so a PO filter there
  means nothing. `filterScan` stays as it was.
- `PO-1343 #2` product-# syntax in Pack: a bare `#N` there would be read as the
  sell order's own `#`, so it would be ambiguous.

## Notes

- The PO match lives in `packFilter` (`lib/sellOrderPack.ts`), on top of
  `filterScan`, so Review mode is untouched.
