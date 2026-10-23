---
id: RS-382
title: Pack mode prints a label for each product, not one for the box
type: story
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/pinfish
pr: "#857"
version: 1.329.0
related: [RS-371, RS-374, RS-378]
---

## Ask

> This ui does not show the connected printer or if the printer is connected. Pls update it to allow me show the printer status

Asked how the printer is connected: "Bluetooth using chrome". Asked which
printer: "Clabel which we tested before."

> for some reason, it is blank

> [Image #2]
>
> I am talking about this page.
> It will print a box lable to show the PO number, Purchaser, Date.

> I meant the sell order print each product #, The PO review page print the box info

Asked when a product's label prints: "It good before. Two mode, auto mode or
manul push buttom." Asked what it carries, from three drawn options, they
picked *SO #, product #, part, qty*:

```
┌──────────────────────────┐
│ SO-4001          10/23   │
│                          │
│  #3                      │
│  M393A2K40BB1-CRC0       │
│  14 units                │
└──────────────────────────┘
```

Asked whether Pack mode still prints the whole-box label: "No, product labels
only".

## Context

Image #1 was Pack mode's *Label · Auto* control at v1.323.0 (RS-371). RS-374
(v1.324.0) added the printer's status to it, and was merged during this
session. Image #2 is PO-1520 in Review mode, which had no label control then
("it is blank"). RS-378 (v1.327.0, merged while this was planned) added one:
Review mode prints the PO's box label (PO number, purchaser, date, counts)
when the review is approved, and it printed correctly on the real printer.

That leaves the sell order side. Pack mode (`DesktopSellOrderPack.tsx`)
still prints RS-371's box label: SO number, counts, purchasers, once the
last product is packed. The requester wants a label per product, carrying
the product's # (the number the packer has been writing by hand since
RS-188), so the receiver can match each item to the order. Both of RS-371's
out-of-scope items were these two labels.

Both pages share `useLabelPrint` (`PackLabel.tsx`) and one *Print when …*
setting (`pack.labelAuto`). That hook drops a label asked for while another
prints, which a label per product would hit at every quick scan.

## Acceptance criteria

- [x] In Pack mode with *Print when packed* on, a tick that packs a product
      (a row, a product, a scan, or Apply) prints that product's label, once
      per product per visit. A product packed at 0 prints none. Several
      packed at once print in # order.
- [x] Pack mode's **Print label** prints the selected product's label. Its
      tooltip names the product.
- [x] The product label carries the SO number and the date, the product's
      # large, its part number, and the units counted. On stock under 1.6 in
      tall (50 × 25 mm, 2.25 × 1.25 in) it keeps the SO number and drops the
      date.
- [x] Pack mode prints no box label. The Finish card's Print label button
      goes, and so does the box label's data (`sourcePurchaser` on
      `GET /api/sell-orders/:id`).
- [x] Labels asked for while one prints wait their turn instead of being
      dropped.
- [x] Without a printer, several labels go through one print dialog, one
      page each.
- [x] Review mode's *Print when approved* is its own setting
      (`review.labelAuto`), so turning one page to manual leaves the other.
      The stock and the printer language stay shared: one printer, one roll.
- [x] The settings button shows *Auto* or *Manual*, as v1.323's Label button
      did.
- [x] English and Chinese strings.

## Out of scope

- Review mode's label and when it prints: RS-378's, unchanged.
- A label per PO line in Review mode.
- Stock sizes beyond those offered.

## Notes

- The plan reviewed before building also had Review mode print on the last
  tick, with no counts. RS-378 landed first with *on Approve* and counts.
  That fits "once i finish the review" and the box info asked for, so it
  stays.
- The plan had a stock size per page. One printer holds one roll, so the size
  stays one setting, and changing the roll is changed once.
- RS-381 (v1.327.1) landed mid-build: the CT221D's data port, and 50 × 25 mm
  stock as the default. This was rebased onto it. `PackLabel.tsx` became
  `LabelPrint.tsx`, since both pages use it, with `LabelPrinterBar` and
  `LabelDialog`. Small stock keeps its top row here (the SO number on a
  product's label), drawn larger, and drops the date and the caption.
- Verified on the local stack with a fake CT221D in Playwright. Its first
  writable characteristic drops everything, and it answers no status query.
  Every TSPL bitmap was decoded and looked at.
  - SO-4001 at 50 × 25 mm: ticking #1 sent one job, *SO-4001 / #1 /
    OTH-72017 / 11 units*. Ticking it off and on again sent nothing.
  - #2 and #3 ticked back to back sent two jobs. An Apply of lowered #4 and
    #6 sent #4, then #6 at *4 units*.
  - In Manual, ticking #5, the last product, sent nothing, and no box label.
    Print label sent #5 (*1 unit*), titled `#5 · INT-240-544 · 1 unit`.
  - 2.25 × 1.25 in and 4 × 3 in printed at their sizes. No write reached the
    dead characteristic.
  - With no printer, Print label made a one-page 4 × 3 in PDF. A fresh
    visit's Apply of two made one two-page PDF.
  - PO-1406 in Review mode: switching it to Manual saved
    `review.labelAuto: false` and left `pack.labelAuto` unset. Print label
    and then Approve each sent the box label at 4 × 6 in. At 50 × 25 mm it
    decoded to *PURCHASE ORDER · LA1 / PO-1406 / Marcus Wright / 2 products
    6 units*.
  - Both heads were checked at 1440, 1080 and 820 wide. SO-4001's pack
    state was restored afterwards.
