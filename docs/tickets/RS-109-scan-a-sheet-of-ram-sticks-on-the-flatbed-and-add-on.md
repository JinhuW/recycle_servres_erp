---
id: RS-109
title: Scan a sheet of RAM sticks on the flatbed and add one line per stick
type: story
status: done
priority: P2
created: 2026-09-26
reporter: jinhu
branch: feat/ram-sheet-scan
pr: "#410"
version: 1.178.0
related: []
---

## Ask

> I would like to create an local process that can use the printer scanner to auto capture the ram information.
>
> /Users/jinhu/Desktop/Baby2.jpeg
>
> This is an example for the image that come from the scanner.
>
> I would like the scanner can auto deivide all rams and use the AI the capture the ram information from it,

Follow-up answers: push the results into the ERP; AI via OpenRouter; "It will be great to use some buttom in the current erp system."

## Context

Today RAM labels are read one stick at a time: one photo per stick through the line drawer's AI dropzone (`POST /api/scan/label`). The office Canon MF460 II flatbed can image a whole batch of sticks in one pass, at 300 dpi and in about 10 s, over eSCL/AirScan. The ERP runs in the cloud and cannot reach the LAN printer, so a small loopback bridge (the separate `auto_ram_scanner` repo) scans on the purchaser's Mac. The ERP page does everything else.

## Acceptance criteria

- [x] The new-PO desktop page has a **Scan RAM sheet** button next to the add-line buttons. It shows only when RAM AI capture is enabled.
- [x] The dialog shows whether the local scanner bridge is running. **Scan from printer** pulls a page through the bridge. **Upload scan image** accepts an existing image without the bridge.
- [x] The page is split into one crop per stick. For the 2-stick sample, the Samsung SODIMM and then the HPE/Micron RDIMM are listed in reading order. Dust and the scanner-edge lines are ignored. Sticks that touch are flagged "may be 2+ sticks".
- [x] Each crop goes through the existing `/api/scan/label` RAM pipeline. Results show per stick with a thumbnail, fields and confidence. A failed stick can be retried alone.
- [x] Purchasers set qty and unit cost in the dialog, with an apply-to-all cost. Identical part numbers can be combined into one line. **Add lines** appends ready-to-submit RAM lines, each carrying its scan image.

## Out of scope

Edit-order and mobile flows; serial-number extraction; a new backend route (the existing `/label` is reused per crop).

## Notes

- Segmentation is pure TS over RGBA in `packages/shared` (`segmentRamSheet`), so it is testable in the backend's vitest with `sharp`-decoded fixtures.
- Bridge: `recycle_servers/auto_ram_scanner` (`npm start`, `http://127.0.0.1:47811`). The first use from the https ERP origin triggers Chrome's Local Network Access prompt.
