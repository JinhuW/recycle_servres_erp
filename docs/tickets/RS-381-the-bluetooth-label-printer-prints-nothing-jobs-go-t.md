---
id: RS-381
title: "The Bluetooth label printer prints nothing: jobs go to the wrong characteristic"
type: bug
status: in-progress
priority: P1
created: 2026-10-23
reporter: jinhu
branch: JinhuW/merrow
pr:
version:
related: [RS-374, RS-378]
---

## Ask

> debug the reason that print labels does not works.

Sent with a screenshot of Review mode's head: *Label printer on ·
CT221D-4FD1*, with no paper state after the name. Asked during debugging,
the loaded labels are "50 × 25 mm".

## Context

The printer is a CLABEL CT221D, a 2-inch desktop label printer. Opening it
from the dev site in Chrome showed one service, Microchip's ISSC
transparent UART `49535343-fe7d-…`. Its characteristics, in Chrome's order:

| Characteristic | Properties | What it is |
| --- | --- | --- |
| `…1e4d…` | read, notify | data from the printer |
| `…6daa…` | write without response | not the data port |
| `…8841…` | write, write without response | data to the printer |
| `…aca3…` | read, write, notify | control point |

`open()` in `lib/labelPrinter.ts` (v1.324.0) took the first characteristic
that takes a write, which here is `…6daa…`. Every label and every status
query went there, and the printer never saw them. That is why it printed
nothing, and why the chip had no *Ready*.

A TSPL job written to `…8841…` printed ("TSPL OK", 50 × 25 mm), so the
printer speaks TSPL. It answers no status query on either notify
characteristic: TSPL's `ESC ! ?` and `ESC ! S`, ESC/POS's `DLE EOT`. It can
show connected, never paper state.

Even on the right port the label would have come out wrong. The page offered
4 × 6, 4 × 3 and 2.25 × 1.25 in stock, defaulting to 4 × 6. A 2-inch printer
with 50 × 25 mm labels can't take that, and TSPL was sent `SIZE 4,6`.

## Acceptance criteria

- [ ] Each known service's port is named (write and notify characteristic).
      The CT221D's job goes to `…8841…` and its replies are read on
      `…1e4d…`. Nothing is written to `…6daa…` or `…aca3…`. An unknown
      service's port is guessed, preferring a characteristic that
      acknowledges writes.
- [ ] Jobs go as acknowledged writes wherever the port takes them, in
      128-byte chunks.
- [ ] A 50 × 25 mm stock exists and is the default. TSPL gets `SIZE 50 mm,25
      mm` and `GAP 2 mm,0 mm`, and inch stock still gets its sizes in inches.
- [ ] The 50 × 25 mm label is laid out for its size: the number, the
      purchaser and the counts, large enough to read, inside a 2-inch head's
      width.
- [ ] A real label prints on the CT221D from the dev site.

## Out of scope

- The printer's paper state. It answers no query, so the chip shows only
  connected.

## Notes

- Debugged on the real printer through Chrome. A diagnostic button in a dev
  site tab opened the chooser, listed the services, sent the status queries
  and a one-label TSPL test. The CT221D's characteristic order is now a unit
  test.
- A parallel session (per-product Pack labels, worktree `pinfish`) was told
  the root cause, so it can rebase onto this fix.
