---
id: RS-617
title: Label printer connected in one tab can't be used from another
type: bug
status: done
priority: P2
created: 2026-11-25
reporter: jinhu
branch: fix/label-printer-cross-tab
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1265
version: 1.483.0
related: []
---

## Ask

> debug a issue that when my printer in the review mode page connected to one tab, then other tab can not connect.

## Context

The label printer is reached over Web Bluetooth, and each tab kept its own
connection with nothing between tabs. A BLE label printer takes one connection
and stops advertising while it has one. A second tab's reload wait
(`watchAdvertisements` before `gatt.connect`) never heard it and sat on
*Waiting for <name>*, and Chrome's chooser usually didn't list it. Had a second
tab got in, two tabs' chunked jobs would have interleaved on the one port.

## Acceptance criteria

- [x] With the printer on in one tab, every other tab shows it on, and its
      labels and status checks print through the tab that owns it, one job at
      a time across tabs.
- [x] When the owning tab closes, a tab that was following connects the
      remembered printer by itself.
- [x] Disconnect in any tab forgets the printer in all of them.
- [x] Connect in a tab takes the printer over from a tab still waiting for it.

## Out of scope

Handing ownership to whichever tab is in front. A hidden owner tab still
prints; see the debug note for the timer-throttling caveat.

## Notes

One owner per browser, chosen by a Web Lock (`rs.labelPrinter`); the others
follow over a BroadcastChannel of the same name (`lib/labelPrinter.ts`).
Debug note: `docs/debug-notes/2026-11-25-label-printer-one-tab-per-printer.md`.
