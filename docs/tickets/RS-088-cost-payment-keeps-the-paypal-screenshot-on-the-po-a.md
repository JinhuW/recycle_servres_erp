---
id: RS-088
title: Cost Payment keeps the PayPal screenshot on the PO, and each bank payment links back
type: bug
status: done
priority: P2
created: 2026-09-20
reporter: jinhu
branch: fix/rs-088-paypal-shot-persists
pr: 382
version: 1.167.0
related: [RS-071, RS-073]
---

## Ask

> fix a bug that after i upload the paypal screenshot in the Cost payment and
> reopen the PO. The screenshot missing and the dorp box also disappear.
>
> PayPal transaction ID shoudl allow update.

Then, mid-investigation, pointing at the *Bank payments* ledger on the same
tab and at the empty *Payment screenshot* box:

> it should have a link to trace back to the payment.
>
> if i upload a screenshot before, then it should also attach to this page.

## Context

On the PO page's Cost Payment tab (company card, PayPal), dropping a
screenshot ran it through `POST /api/scan/payment` to read the transaction ID
and then held the image in React state only — nothing on the order recorded
it. Reopen the PO and it was gone. The cash screenshot never had this problem:
it is a `Payment` attachment on the order (RS-071). The hand-off dialog had
the same gap for pickup hand-offs (RS-073).

The PO in question (PO-1447, dev) was Reviewing, where the transaction ID is
already editable by a manager. It is frozen from Ready to Pay on (closed
book), and a *purchaser's* edit past Draft reverts the PO to Draft — both by
design and unchanged here.

Jinhu chose to keep the PayPal screenshot in the same `Payment` bucket as the
cash one rather than a dedicated column.

## Acceptance criteria

- [ ] A PayPal screenshot dropped on the Cost Payment tab (desktop and phone) or in the hand-off dialog is a `Payment` attachment on the order: it is listed on the tab after a reload, and the transaction ID is still read off it into the field.
- [ ] The Payment screenshot block shows what is on file even when the viewer cannot edit the PO; only upload and remove are gated.
- [ ] Removing it deletes only the order's own R2 object — no package row shares the key.
- [ ] Each row of the *Bank payments* ledger links to the Payments page pinned to this PO with that transaction's row open.
- [ ] A failed OCR keeps the file and tells the user to type the ID.

## Out of scope

- Editing the transaction ID on a Ready to Pay / Done PO (closed book).
- The tracker's add-package form, which keeps `/api/scan/payment`.

## Notes

- Plan: `~/.claude/plans/crystalline-napping-emerson.md`.
- Closes RS-073 too: the dialog now uploads into the order's bucket, so a
  pickup hand-off no longer orphans the screenshot and the hand-off body no
  longer carries a client-supplied R2 key.
- The first screenshot's "drop box disappeared" could not be reproduced from
  the code for a manager on a Reviewing PO; the second screenshot showed it
  back. The read-only rendering above covers the locked case either way.
