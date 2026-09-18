---
id: RS-072
title: PayPal screenshot from the hand-off dialog is kept on the order
type: bug
status: backlog
priority: P3
created: 2026-09-18
reporter: Claude (dev→main review, 2026-09-14)
branch:
pr:
version:
related: [RS-050, RS-071]
---

## Ask

> (No user ask — surfaced by the 2026-09-14 dev→main review of RS-050 and
> deferred out of RS-071 on plan review.)

## Context

The PayPal screenshot dropped into the *Mark as In Transit* dialog is scanned
for the transaction ID and uploaded to R2, but the only row that records it is
the `packages` row a **label** hand-off creates (`payment_screenshot_key` /
`_url`). A **pickup** hand-off has no package, so the object is uploaded and
then forgotten; the PO shows nothing on file afterwards. RS-071 added a
`Payment` attachment bucket on the order that is the natural home for it.

Two things stopped RS-071 from doing it in passing:

- The hand-off body's `paymentScreenshotKey` is client-supplied. Inserting it
  as an `order_status_attachments` row would let the status-meta DELETE route
  R2-delete a key the purchaser did not mint (any key they choose to send) and
  would blank a package's screenshot when the order's copy is removed. The
  upload route mints keys under `orders/<id>/…`; the delete must only remove
  keys under that prefix, or the row must own a separate copy.
- The scan endpoint does not return the stored object's size / MIME, which
  the attachment row needs.

## Acceptance criteria

- [ ] A PayPal screenshot given to the hand-off dialog is on the order afterwards as a `Payment` attachment, for pickup and label hand-offs alike.
- [ ] Removing that attachment cannot delete an R2 object the order's own upload route did not create, and does not blank a package's screenshot.
- [ ] The dialog's scan still fills the transaction ID as today.

## Out of scope

- Changing the optional status of the PayPal screenshot.

## Notes

- Origin: `~/.claude/projects/…/memory/dev-to-main-review-2026-09-14-handoff-findings.md`
  ("pickup screenshot orphaned").
