---
id: RS-573
title: Review mode prints a product label for each line as it is checked
type: story
status: done
priority: P2
created: 2026-11-08
reporter: jinhu
branch: JinhuW/arapaima
pr:
version: 1.448.0
related: []
---

## Ask

> In the PO review page.
>
> I hope when i confirm each line, it will also print the spec of the product.
>
> A few key info:
> PO number
> # - of the PO.
> spec of it.
>
> also when the system didn't connect with printer, then it will be fine.
>
> Once we check it. It will come out a small dialog to ask how many labels it will print.

Follow-up answers, 2026-11-08. Asked what a check should do with no printer
connected: "Nothing, just confirm". Asked what the labels dialog should start
at: "let we pass this feature. once i check, it will print a label for the
product".

## Context

Review mode (`apps/frontend/src/pages/desktop/DesktopBoxCheck.tsx`) prints
one label per PO, the box's, on Approve (v1.327.0, RS-378). It goes through
`useLabelPrint` / `drawLabel` in `LabelPrint.tsx`, which Pack mode shares. Pack
mode already prints a label per packed product (RS-382). A product checked into
stock has nothing on it that ties it back to its PO line and spec.

## Acceptance criteria

- [x] Ticking a line (checkbox, Space, or a scan that ticks it) prints one label for it while the Bluetooth printer is on.
- [x] The label shows the PO number (and warehouse) on top, the line's `#` as the big title, and the spec under it: brand, capacity and generation, plus class, rank and speed for RAM, and the matching fields for SSD and HDD.
- [x] *Check all remaining* prints one label per line it ticks, in `#` order.
- [x] A line ticked at 0 (not in the box) prints nothing. Unticking prints nothing. Ticking it again prints again.
- [x] With the printer off, waiting or unsupported, a tick prints nothing and opens no print dialog. The check saves as before.
- [x] The label settings' *Auto* toggle still governs only the Approve box label.

## Out of scope

- The "how many labels?" dialog. The owner dropped it, so each check prints one label.
- A print-dialog fallback for line labels.
- A separate on/off setting for line labels. Disconnecting the printer is the off switch.
- The part number on the label. 50×25 mm stock has room for the spec or the part number, not both, and the ask names the spec.

## Notes

Plan: `~/.claude/plans/giggly-discovering-crayon.md` (session plan, approved 2026-11-08).

- The device type (Server, Desktop) is left off the label. With it, the speed
  fell past the second line on 50×25 mm stock, and the class (RDIMM, UDIMM,
  SODIMM) already says what kind of machine the stick is for.
- `useLabelPrint` gained `printToPrinter`, which skips the print-dialog
  fallback. Without it, a printer that is off would open the dialog on every
  tick.
- Verified locally with the fake CT221D in Playwright on a seeded Reviewing PO.
  A tick with the printer off printed nothing and opened no dialog, and the
  check still saved. With the printer on, a checkbox tick, a scan and *Check
  all remaining* (one open line) printed 1, 1 and 1 TSPL jobs. A tick at 0
  printed nothing.
