---
id: RS-378
title: Review mode prints the PO's box label when the review is approved
type: story
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/merrow
pr: "#852"
version: 1.327.0
related: [RS-371, RS-374]
---

## Ask

RS-371's ask, set as a session goal:

> for the label printer.
>
> Pls once i finish the review, it will print an label for the SO number.
> Counts.
> Name of the Purchaser.

RS-371 read "the review" as Pack mode. Asked to confirm, with the options
"Yes, Pack mode", "PO Review mode instead" and "Both", the requester chose
**Both**. That keeps Pack mode's SO label and adds a PO label "when a
manager finishes a PO's Review mode (Approve for payment), with the PO
number, counts and that PO's purchaser". The same answer confirmed RS-374's
printer on real hardware: "It printed correctly".

## Context

Review mode (`DesktopBoxCheck.tsx`, v1.188.0) is the PO's bench check, and
its Finish review card ends in **Approve for payment** (Reviewing → Ready to
Pay). Approving leaves the page for the PO page (`onApproved`). The label
pieces from RS-371 and RS-374 sit in `PackLabel.tsx`: the drawn label, the
Bluetooth printer and the print-dialog fallback. Until now Pack mode was the
only page using them.

## Acceptance criteria

- [x] Approving a review prints the box's label when *Print when approved*
      is on (the same saved setting as Pack mode's). It prints before the
      page leaves for the PO page: over Bluetooth when the printer is on,
      else through the print dialog. A refused or cancelled approval prints
      nothing.
- [x] The label reads *Purchase order · <warehouse>*, the date, the PO
      number, *Purchaser <the PO's purchaser>*, and the counts. Those are the
      products with a unit counted, by #, and those units. A line counted 0
      is in neither.
- [x] Review mode's page head carries the same printer bar as Pack mode:
      status, Connect, Print label, and the settings menu.
- [x] Pack mode works as before. Both pages share one hook
      (`useLabelPrint`), so they can't print differently.

## Out of scope

- A label per PO line.
- Printing on the phone's review screen.

## Notes

- The approval awaits the print, so the page doesn't unmount a dialog or a
  Bluetooth job mid-print.
- Verified with the fake Web Bluetooth printer. PO-1404, created as Marcus
  with lines of 4 and 2, had its second line counted one short, every line
  checked, then Approve. The job decoded to *PURCHASE ORDER · LA1*,
  PO-1404, *PURCHASER Marcus Wright*, *2 products 5 units*. The PO went to
  Ready to Pay and the page left for it. Pack mode's run gave the same
  results as RS-374's.
- The shared local DB was at migration 0195. Applying 0196–0204, all
  additive, was needed to create a PO locally.
