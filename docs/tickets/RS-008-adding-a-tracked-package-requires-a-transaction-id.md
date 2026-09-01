---
id: RS-008
title: Adding a tracked package requires a transaction ID
type: story
status: in-review
priority: P2
created: 2026-08-31
reporter: Jinhu
branch: feat/shipping-txn-required
pr: 235
version: 1.116.0
related: [RS-006]
---

## Ask

> In the shipping page, when user submit a shipping, It much fill the
> transcation id. or show an diaglog to ask them to ask the mamanager who pay
> for ths order.

Three answers settled the shape.  Which screen — the Add-package form
(tracking number, carrier, source, seller, payment screenshot, PayPal
transaction ID), not the label-buying wizard.  What an empty ID does — a **hard
stop**: a dialog with one OK button, and no package is created.  And who it
governs — **everyone**, managers included.

## Context

The Add-package form is where a purchaser pastes an inbound tracking number and
starts tracking the box.  Both shells render it from one shared state machine,
`lib/useAddPackageForm.ts`, and `paypalTxnId` was optional there — the payload
literally read `...(paypalTxnId ? { paypalTxnId } : {})`.

The ID is not paperwork.  `routes/packages.ts` copies a package's
`paypal_txn_id` onto the PO minted from the delivered box, and `banktx/sync.ts`
auto-links a Mercury/PayPal row to a PO by exact `paypal_txn_id` equality.  A
package added without one becomes a PO that can only be reconciled by a manager
guessing from amount and date on the Payments page.  And because that page is
manager-only, a purchaser who doesn't have the ID has exactly one route to it:
ask whoever paid.  That is what the dialog says.

This is the shipping-side twin of [RS-006](./RS-006-company-paid-pos-must-carry-a-payment-transaction-id.md),
which requires the same ID before a company-paid PO can leave Draft.  They
compose rather than overlap: a package added with an ID mints a PO that already
satisfies RS-006's advance guard, so nobody is asked twice.

## Acceptance criteria

- [x] Submitting the Add-package form with an empty transaction ID opens a
      blocking dialog naming the missing field and telling the user to ask the
      manager who paid, and creates no package
- [x] The dialog is dismiss-only — there is no "add anyway" path
- [x] A second click after dismissing raises the dialog again rather than going
      silent
- [x] Filling the ID lets the same submit through unchanged
- [x] The rule holds on both shells, from one implementation, and for managers
      as well as purchasers
- [x] The transaction-ID field is marked required before the user submits
- [x] Both catalogues carry the new string; no raw English in 中文

## Out of scope

- **Server-side enforcement.**  `POST /api/packages` still accepts a package
  without an ID.  The mobile shell is an installed PWA, so a cached bundle
  predating this change would meet an opaque 400 with no dialog; the column is
  nullable with historic nulls; and `orders.paypal_txn_id` stays blankable by a
  manager.  Requiredness here is workflow policy, not a data invariant.  A
  direct API client can therefore still create an ID-less package — closing
  that is three lines beside the existing `source` check plus churn across five
  backend test files.
- The label-buying wizard (`ShippingLabelWizard`), which has no transaction-ID
  field and buys rather than records a label.
- Linking a real synced `bank_transactions` row from the shipping page — that
  stays manager-only on the Payments page.

## Notes

- The gate lives in `submit()` in the shared hook, **before**
  `submitting.current = true`.  Placing it after would latch the double-submit
  ref forever and swallow every later submit in silence — the plan review
  caught this, and the third acceptance criterion is what pins it.
- It reuses `errCantSubmitTitle` / `errCantSubmitMsg` plus a details line, the
  same call `DesktopSubmit` makes, so a blocked add reads like every other
  blocked submit in the app.  One new key, `shipPayTxnRequired`.
- `canSubmit` deliberately still excludes the transaction ID, so the button
  stays live and the click can explain itself rather than going dead with no
  message.
- A package genuinely bought without PayPal — a local cash pickup — can no
  longer be tracked at all.  Jinhu chose the hard stop over an "add anyway"
  override knowingly.
