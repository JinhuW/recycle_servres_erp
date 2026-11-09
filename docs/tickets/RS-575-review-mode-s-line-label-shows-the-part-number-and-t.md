---
id: RS-575
title: Review mode's line label shows the part number and the units counted
type: story
status: done
priority: P2
created: 2026-11-08
reporter: jinhu
branch: JinhuW/arapaima-label-pn
pr:
version: 1.450.0
related: [RS-573]
---

## Ask

> It should also include the spc number and count info for the label.

Follow-up answers, 2026-11-08. Asked what "spc number" means: "Part number".
Asked which count: "Units counted".

## Context

RS-573 (v1.448.0) prints a label for each line checked in Review mode. It
shows the PO number and warehouse, the line's `#`, and the spec. On 50×25 mm
stock (400×200 dots) those already fill the height, so the part number and the
count need room made for them.

## Acceptance criteria

- [x] A checked line's label shows its part number on one line, in mono, shrunk to fit the width.
- [x] It shows the units counted on that line (e.g. `4 units`) beside the big `#`, right-aligned on the title row.
- [x] The spec stays, on up to 2 lines.
- [x] A line with no part number prints without that row.
- [x] On 50×25 mm stock nothing overlaps or runs off the label, and the other stocks still lay out.
- [x] Pack mode's labels and the Approve box label are unchanged.

## Out of scope

- Counted out of ordered (`3 / 4`). The owner chose the units counted.
- The RAM short code. "spc number" was confirmed as the part number.

## Notes

- The count goes beside the `#`, not on a row of its own. With its own row,
  50×25 mm stock had no room for both the part number and two lines of spec.
- `drawLabel` now shrinks every block by one factor when the layout is taller
  than the stock. The box label and Pack mode's labels fit already, so they are
  unchanged.
- Verified with the fake CT221D on a seeded Reviewing PO:
  - A line counted 3 of 4 printed `3 units`.
  - The job counts held: printer off 0, then tick 1, scan 1, check-all 1,
    and a tick at 0 printed 0.
  - Drawn directly at 50×25 mm and 4×6: a 21-character part number, a line
    with no part number, a 3-digit count, the box label and a Pack label.
