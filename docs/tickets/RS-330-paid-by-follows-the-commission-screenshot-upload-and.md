---
id: RS-330
title: Paid by follows the commission screenshot upload and asks before it changes
type: story
status: done
priority: P2
created: 2026-10-20
reporter: jinhu
branch: paid-by-follows-upload
pr:
version: 1.302.0
related: [RS-328]
---

## Ask

> The paid by field can not be edit in the table view.
>
> It should only updaue / add when mamager upload the commission fee screenshots.
> Once we adjust the field [Image #2]  it shoudl ask to confirm.

Image #2: [assets/RS-330-commission-tab.png](assets/RS-330-commission-tab.png)
— a PO's Commission tab, with the *Paid by* select (Tim Wu) above the
commission screenshot drop box.

Asked whether an upload should replace a Paid by that already names someone
else:

> Should confirm if he want to update the Paid by field to heself.

Asked whether to fill in existing POs from who uploaded their commission
screenshot:

> Yes, backfill (Recommended)

## Context

RS-328 (v1.301.0) added the PO list's Paid by column. Managers could edit it
in the cell, and on the PO page a pick saved at once
(`components/CommissionPaymentFields.tsx`, `lib/useCommissionPaidBy.ts`).
Nothing tied the field to the commission screenshot: 0162 deliberately left
it unguessed, because the uploader need not be the payer.

The ask reverses that: the manager who uploads the screenshot is the payer.
Every commission upload already takes one path,
`usePaymentProof.addFiles('Commission', …)` →
`POST /api/orders/:id/status-meta/Commission/attachments`
(`routes/orders/evidence.ts`). It serves the desktop Commission tab, the
phone Commission fold and the Done dialog's drop box. Only managers can
write that bucket (`canWriteMeta`).

## Acceptance criteria

- [x] The list's Paid by cell is plain text for every role. A manager still
      gets the linked *Company paid* chip, which opens the payment.
- [x] A commission screenshot upload while Paid by reads *Not recorded* sets
      it to the uploader, with one Activity line.
- [x] An upload while Paid by names someone else, or reads Company paid,
      writes nothing. It asks the uploader *Set Paid by to you?*: yes switches
      it, no keeps it.
- [x] Picking a value in the PO page's Paid by select, desktop or phone, opens
      a confirm naming both values. Nothing is saved until it is confirmed,
      and Cancel leaves the select on the record.
- [x] An upload made in the Done dialog follows the same rules.
- [x] A bank payment linked as the commission still locks the field. An
      upload then neither writes nor asks.
- [x] Migration 0189 fills Paid by on every PO that has nothing recorded,
      from the uploader of its latest commission screenshot, when that
      uploader is a manager. Each filled PO gets an Activity line.

## Out of scope

- Removing a screenshot does not clear Paid by.
- The phone order list still has no Paid by column.

## Notes

- The upload route and the PUT share `lockPayerTx` / `recordPayerTx` in
  `routes/orders/evidence.ts`, so the payer and its Activity line are
  written one way. The upload writes only into an empty record. Taking over
  a payer already on file is the page's confirmed PUT, so a manager is never
  replaced without saying yes.
- The confirm is rendered once per page (`CommissionPaidByConfirm`), not
  inside the Commission fields, because the Done dialog's drop box uploads
  through the same `commissionShots.add`. Rendered at the default modal
  layer (100), it opened *behind* the Done dialog (`StatusChangeDialog`,
  110). `Modal` and `ConfirmDialog` now take a `zIndex`, and the confirm
  uses 120, as `SerialCheckDialog` does.
- The backfill skips an uploader who is not a manager. Only managers can
  write the Commission bucket, so that row should not exist; the test
  plants one to prove it is ignored.
- Verified on the local stack (Playwright, as alex):
  - The list has no picker.
  - A first upload records Alex without asking.
  - Picking Sofia asks; Cancel keeps Alex, and Change records Sofia.
  - A second upload asks *Set Paid by to you?*, and yes records Alex.
  - The same prompt opens above the Done dialog and leaves it open.
