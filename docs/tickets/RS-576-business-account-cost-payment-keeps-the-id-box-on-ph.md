---
id: RS-576
title: Business Account cost payment keeps the ID box on phone and lets a manager fix a typed ID
type: bug
status: done
priority: P1
created: 2026-11-09
reporter: jinhu
branch: JinhuW/sevengill
pr: 1178
version: 1.450.1
related: [RS-572]
---

## Ask

> /code-review high from dev to main, release all changes to prod.

Asked after the review reported the RS-572 regressions below: "Fix first, then release (Recommended)".

## Context

RS-572 (v1.447.0) made a manager's Business Account side link-only. `PaymentFields` hid the transaction ID box and the screenshot panel whenever the page passed `sources`. Two pages pass it:

- **Phone.** The mobile `OrderDetail.tsx` passes `sources` but has no bank-link picker, because Payments is desktop-only. A manager on a phone lost the only way to clear the `missingTxnId` blocker.
- **Mistyped ID.** On the desktop, a purchaser's typed ID became read-only. `companyPayTxnUnknown` (`services/orderTxnRule.ts`) ignores links, and a link fills `paypal_txn_id` only while it is NULL. A wrong ID therefore kept `unknownTxnId` blocking, with nothing on the PO page to fix it.
- **Hidden screenshots.** The same change also hid screenshots already on file, which used to show read-only.

## Acceptance criteria

- [x] On the mobile PO page, a manager on the Business Account side has the PayPal transaction ID input and the screenshot panel, as before v1.447.0.
- [x] On the desktop manager PO page with no ID typed and no screenshot on file, the Business side still shows only the picker and *Bank payments*.
- [x] On the desktop, when an ID is typed, the manager gets an editable ID input and can correct or clear it.
- [x] On the desktop, screenshots already on file show read-only, with no upload control.

## Out of scope

The other findings of the same review are left for a follow-up:

- The picker shows while the ledger loads.
- A reversed link hides the picker.
- The RAM series fold sets one price across conditions.
- Label overflow.
- A duplicate print after Undo.

## Notes

The page that renders a picker opts in with `linksPayment`. Before, `sources` alone implied a picker.
