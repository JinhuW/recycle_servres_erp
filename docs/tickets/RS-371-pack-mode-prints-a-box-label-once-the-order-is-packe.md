---
id: RS-371
title: Pack mode prints a box label once the order is packed
type: story
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/merrow
pr: "#845"
version: 1.323.0
related: [RS-187, RS-188, RS-361]
---

## Ask

Set as a session goal (`/goal`):

> for the label printer.
>
> Pls once i finish the review, it will print an label for the SO number.
> Counts.
> Name of the Purchaser.

## Context

Pack mode (`#/sell-orders/<id>/pack`, `DesktopSellOrderPack.tsx`, v1.218.0)
is the sell order's checklist. RS-187 asked for it as "similar to the review
mode in the PO", and the requester calls finishing it the review. RS-188 says
why the packer labels things: "then the receiver can easily check them by the
label". The RS-361 screenshot of this page had a *Label printer off · Connect*
control in the page head, but no build here ever had one.

Nothing in the ERP prints a label today. The only print path is the transfer
manifest, through `window.print()` and a print-only block in `desktop.css`.
The office scanner runs through a loopback bridge (`auto_ram_scanner`), which
only scans. No label printer model is recorded anywhere, so the label goes
through the browser's print dialog, sized for the stock. Any label printer
with a driver or AirPrint (Rollo, Zebra, DYMO, Brother) takes that, on the
desktop and on the iPad Pack mode was built for.

The page head already reads the same three facts the label needs:
`SO-4001`, `NorthBridge Data Centers · 6 products · 14 units`. On a sell
order the purchaser is the buyer, i.e. its customer.

## Acceptance criteria

- [x] When a tick on this page (a row, a product, a scan, or Apply) packs the
      last product left in what is being packed, the page prints a label:
      the whole order, or the picked warehouse's lots under *Packing from*.
- [x] The label carries the SO number, the counts (products and units in the
      box), and the customer's name. Packing one warehouse adds its name, and
      the counts are that warehouse's. It also carries the date.
- [x] It prints once per order and warehouse per visit. Opening an order that
      is already packed, or another iPad finishing it, prints nothing here.
- [x] A **Label** control in the page head prints the label on demand. It also
      turns the automatic print on or off and picks the stock: 4 × 6 in,
      4 × 3 in or 2.25 × 1.25 in. Both choices are saved preferences.
- [x] The print is one page at the chosen size, with nothing of the app on it.
      The transfer manifest still prints as before.
- [x] English and Chinese strings.

## Out of scope

- A barcode or QR code of the SO number.
- Printing without the browser dialog: silent printing needs a bridge (as the
  scanner has) or a kiosk-printing browser, and the printer model is unknown.
- One label per product (#n). The packer still writes those.
- The same label for the PO's Review mode (PO number, purchaser).
- The mobile shell, which has no Pack mode.

## Notes

- Built under a `/goal`, so it went straight to implementation. No plan was
  reviewed first.
- "The review" is read as Pack mode, the sell order's twin of Review mode
  (RS-187), because the ask names the SO number. "Purchaser" is read as the
  buyer, the sell order's customer, not the ERP's purchaser role: a sell
  order has no purchaser, and the label is for the receiver.
- The trigger lives in the tick handlers (`labelOnFinish`), not an effect on
  the tally. An effect would also fire when a re-read showed another iPad's
  ticks.
- The label is portalled to `<body>`, and `body.printing-label` takes the app
  out of the flow (`display: none`), not just out of sight. With only
  `visibility`, as the transfer manifest does, the hidden app still lays out
  pages, and a label printer feeds a blank label for each one. `@page` comes
  from a `<style>` inside the label, so it exists only while the label is
  mounted and never resizes the manifest's page.
- Sizes are in container units off the label box, so one layout serves all
  three stocks. Below 1.6 in tall the top row and the caption go.
- Verified locally on SO-4001 (Playwright, `window.print` stubbed, real print
  PDFs). Packing HK's one product printed one label: "1 product · 1 unit ·
  from HK". Ticking it off and on again printed nothing more. Packing the
  rest under All printed "6 products · 41 units". Each stock came out as one
  PDF page of its size (288×432, 288×216, 162×90 pt). So did a stress label
  (SO-12345, a 70-character customer, 128 products and 1024 units), which
  overflowed nothing. A reload of the packed order with the automatic print
  off printed nothing. The preferences saved to the server. The head control
  was checked at 1440, 1080 and 820 wide.
- Not tested on a real label printer or on iPad Safari. The print runs a
  frame after the tick, outside the tap itself. If iOS refuses that, the
  label's own button is the fallback.
