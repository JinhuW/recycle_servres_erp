---
id: RS-498
title: Business Account payments link to PayPal or Mercury, no Cash
type: story
status: done
priority: P2
created: 2026-11-01
reporter: jinhu
branch: JinhuW/discus
pr: 1052
version: 1.403.0
related: []
---

## Ask

> In the PO.
> [Image #1]
>
>
> remove the business cash option.
>
> All business payment should link to paypal or mercury transcation.

(The image was the PO page's Cost Payment tab, on the RMB Flow side.)

## Context

On the Cost Payment tab, picking *Business Account* in `components/PaymentFields.tsx`
showed a PayPal | Cash toggle. Cash had its own proof, a Payment-bucket
screenshot that `cashShotRequiredFor` (`services/orderTxnRule.ts`) required
before the PO could leave Draft, and website pickups were born
`payment_method = 'cash'` (`routes/webSubmissions.ts`). A cash PO is never
backed by a bank row. The Commission tab's Business side
(`components/CommissionPaymentFields.tsx`) already searches unlinked outgoing
PayPal / Mercury rows and links one through `POST /api/bank-transactions/:id/link`.

Decisions from the owner: remove Cash everywhere; the manager's Business
Account side gets a search-and-link picker like Commission's, and purchasers
keep typing the PayPal id at hand-off; POs already saved as cash stay as they
are, with nothing migrated.

## Acceptance criteria

- [x] No page offers Cash for a Business Account payment: the desktop PO page,
      the phone PO page, the hand-off dialog and the Submit page.
- [x] A company-paid PO is PayPal by default. The "pick a method" state and
      its blocker are gone.
- [x] On a manager's desktop PO page, the Business Account side searches
      unlinked, settled, outgoing PayPal and Mercury rows. A click asks to
      confirm, then links the row to the PO as cost, and the ledger refreshes.
- [x] A linked cost payment satisfies the transaction-id rule for leaving
      Draft, so a Mercury-paid PO is not blocked.
- [x] The backend refuses `paymentMethod: 'cash'` on create, patch and
      hand-off unless the PO is already saved as cash.
- [x] Website pickup submissions are created as PayPal.
- [x] Existing cash POs still read "Cash" with their screenshots, and their
      screenshot rule still applies.

## Out of scope

Migrating existing cash POs; the RMB Flow side; the Commission tab's behaviour.

## Notes

- The picker is `components/BankTxnLinkPicker.tsx`, shared with the Commission
  tab. A cost link fills the PO's PayPal id from a PayPal row, as before.
- `txnRequiredFor` / `companyPayTxnMissing` now count any bank row linked to
  the PO with `link_kind = 'payment'`, so `txnRequired` reads false once
  something is linked.
- The `missingMethod` blocker is gone: a NULL method on a company PO reads as
  PayPal, and the hand-off saves it as PayPal.
