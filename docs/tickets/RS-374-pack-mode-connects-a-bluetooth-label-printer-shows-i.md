---
id: RS-374
title: Pack mode connects a Bluetooth label printer, shows its status, and names the purchasers
type: story
status: in-progress
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/merrow
pr:
version:
related: [RS-371, RS-361]
---

## Ask

A follow-up to RS-371, sent while it was being finished:

> you should also check the printer status and a print buttom

Asked how the printer is connected: "bluetooth which is same as we did
before in the sell order." Asked whose name the label means by "Name of the
Purchaser" (RS-371's ask): "Our purchaser(s) only". Asked which device runs
Pack mode: "Mac, in Chrome". No printer model was given.

## Context

RS-371 (v1.323.0) printed the box label through the browser's print dialog.
That dialog can't tell the page anything about a printer. The label named
the sell order's customer, because a sell order has no purchaser. Every lot
on one comes from a PO line, though, and every PO has a purchaser.

The RS-361 screenshot showed a *Label printer off · Connect* control in the
Pack page head. Chrome on the Mac reaches a Bluetooth printer through Web
Bluetooth. Safari has no Web Bluetooth, but the iPad isn't the device here.
"Same as before in the sell order" is the Bluetooth scanner Pack mode already
takes. That scanner types like a keyboard, so it has no code of its own to
reuse. No model is on record, so the page speaks the three languages
Bluetooth label printers use: TSPL, ZPL (Zebra) and ESC/POS raster.

## Acceptance criteria

- [x] The Pack page head shows the printer's status: *Label printer off* with
      **Connect**, *Connecting…*, *Label printer on · <name> · Ready*, or the
      problem the printer reports (*Out of paper*, *Cover open*, *Busy*,
      *Needs attention*), or *No Bluetooth in this browser*.
- [x] Connect opens Chrome's device chooser, asking for the five services
      label printers put their serial port on. The page finds a writable
      characteristic and, where there is one, a notify one.
- [x] The status is asked on connect, every 15 s, and before each print.
      That is TSPL's `ESC ! ?` or ESC/POS's paper sensor. A printer out of
      paper, open or faulted gets no label, and the page says why.
- [x] **Print label** sits in the head. With a printer on, it and the
      automatic print on finishing the box (RS-371) send the label over
      Bluetooth with no dialog, and a toast confirms it. With none, they open
      the print dialog.
- [x] The language follows the printer's service: Zebra's is ZPL, FF00 is
      ESC/POS, the rest TSPL. It can be set by hand in the label settings,
      saved as `pack.labelLanguage`.
- [x] The label names the purchasers of the POs its counted lots came from,
      once each in # order: two, then *+n*. It no longer names the customer.
- [x] The printer stays connected across Pack mode visits in a tab. A
      printer this browser was allowed before reconnects on load where Chrome
      offers `getDevices`.
- [x] The label is one drawn picture, in dots for the printer and as an
      image in the dialog, at every stock size.

## Out of scope

- Niimbot and other printers with their own packet protocols.
- Silent printing on the iPad. Safari has no Web Bluetooth.
- ZPL's status report, which is multi-line. A Zebra shows only connected.
- Calibrating gap or black-mark stock. TSPL is sent the common 3 mm gap.

## Notes

- Built under the same `/goal` as RS-371. The three answers above came from
  questions asked in the session.
- The connection is a module-level store (`lib/labelPrinter.ts`, read
  through `useSyncExternalStore`), so leaving Pack mode keeps the printer.
  Chrome opens its chooser only from a click, so Connect is a button, never
  automatic.
- TSPL's `BITMAP` prints a 0 bit, so its picture goes inverted. ZPL's `^GFA`
  and ESC/POS's `GS v 0` print a 1. The job goes out in 180-byte writes,
  under macOS's usual BLE MTU. It uses writes the printer acknowledges when
  the characteristic has no write-without-response, and otherwise pauses
  20 ms every 16 writes.
- Verified with a fake Web Bluetooth printer in Playwright. It kept every
  byte, and answered TSPL's status query with a byte the test set.
  - Connect found the 18F0 port. The chip read *Label printer on ·
    PM-241-BT · Ready*.
  - With the paper out, Print label sent nothing and toasted *The printer
    says: Out of paper*.
  - Finishing HK's box sent a TSPL job by itself, with no dialog. It decoded
    to SO-4001, *PURCHASER Lina Park*, *1 product 1 unit*, *from HK*:
    `SIZE 4,6`, a 102 × 1218-dot bitmap.
  - The whole order on 4 × 3 sent 102 × 609 dots, naming *Lina Park, Marcus
    Wright +2* and *6 products 41 units*.
  - ZPL by hand sent `^XA^PW816^LL609^GFA…`.
  - After Disconnect, Print label went to the dialog, as one 288 × 216 pt
    PDF page.
  - Head checked at 1440, 1080 and 820 wide, and without Web Bluetooth.
- Not tested on a real Bluetooth printer. TSPL's 3 mm gap, the write pacing
  and the status byte follow the TSPL and ESC/POS specs, not a device.
