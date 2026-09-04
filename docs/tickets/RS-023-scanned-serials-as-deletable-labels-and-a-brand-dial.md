---
id: RS-023
title: Scanned serials as deletable labels, and a brand dialog that fits
type: task
status: in-progress
priority: P2
created: 2026-09-04
reporter: jinhu
branch: feat/rs-023-serial-chips-brand-dialog
pr:
version:
related: []
---

## Ask

> Polish following features:
>
> 1. When user use the QR code scann to scan sn number, it will put all string
>    as a kind of a label style and when uuser want to delete the sn number, it
>    will delete the whole labeled text
> 2. [screenshot of the "Confirm the brand" dialog] In this screenshot page,
>    user can click the image and it will zoom out. also do not create two line
>    buttom, you can say confirm , retake and note the action in other location

Then, on the same dialog:

> it will not prompt this when user selet the branch to the non-other branch
> selection.

## Context

Three papercuts in the RAM line-entry flow, all reported from the phone.

**Serials.** The serial-number field is a plain textarea in both shells
(`SubmitForm.tsx`, `LineDrawer.tsx`). A scanned SN lands as one more line of a
monospace blob, so removing one means selecting exactly the right characters —
there is no "this serial, gone" gesture.

**The brand dialog.** `BrandConfirmDialog` exists to make a purchaser *look at
the photo again* when the AI couldn't name the module's brand, but the photo
can't be enlarged. Its three buttons (`Retake photo` / `Cancel` /
`Confirm brand`) wrap onto two lines; at a 360 px viewport a nowrap row of
three would be clipped outright by the shell's `overflow: hidden`.

**The repeat prompt.** `brandConfirmPending` reads only the `_brandNeedsConfirm`
flag stamped at scan time, so once the purchaser has answered the question in
the line's own Brand select, saving still opens the dialog and demands the same
answer again.

How serials are stored does not change: the field value stays the same
newline-joined string, so `parseSerials`, the DDR5 / count-vs-qty validators and
the backend are untouched.

## Acceptance criteria

- [ ] A scanned or typed serial renders as a label chip in the serial field, in
      both the mobile submit form and the desktop line drawer.
- [ ] Removing a serial takes the whole label: the chip's `×`, or Backspace in
      an empty input (first press highlights the last chip, second removes it).
- [ ] The chip field round-trips the same newline-joined string, and typed text
      that has not yet become a chip still counts toward the DDR5 / count-vs-qty
      validators.
- [ ] Opening an existing line with serials renders chips without marking the
      line dirty.
- [ ] Tapping the photo in the brand dialog opens the full-screen lightbox; Esc
      closes the zoom only, leaving the dialog open.
- [ ] The brand dialog's footer is a single unwrapped row at a 360 px viewport:
      `Retake` and `Confirm`. Cancel moves to an `×` in the dialog head.
- [ ] Saving a RAM line whose brand is set to a real catalog brand does not open
      the brand dialog — on the mobile form, the desktop drawer, submit, and
      order edit.
- [ ] A brand that is blank, `Other`, or off-catalog still prompts.

## Out of scope

- The read-only `SerialNumbers` pills on inventory screens.
- `Shipping.tsx`'s scanner, which reads tracking numbers, not serials.
- Any change to serial storage, the serial validators, or the backend.

## Notes

- Plan: `~/.claude/plans/peaceful-toasting-ritchie.md`.
- Feature 3 needs no new predicate — `ramBrandNeedsConfirm` already encodes
  "blank, `Other`, or off-catalog prompts; a catalog brand does not". It is
  applied a second time to the *line's* brand.
- `_brandNeedsConfirm` stays `true` on a line settled through the select; only
  the dialog's own confirm clears it. Nothing else reads the flag and it is
  never sent to the API.
- The chip field mirrors uncommitted text into the field value rather than
  committing on blur: iOS Safari does not blur an input when a `<button>` is
  tapped, so commit-on-blur would drop the last typed serial on Save and then
  report a count mismatch about a serial visibly on screen.
