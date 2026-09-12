---
id: RS-039
title: PO list links to its linked payments
type: story
status: done
priority: P2
created: 2026-09-12
reporter: Jinhu
branch: feat/po-payment-link
pr: 303
version: 1.138.0
related: [RS-011, RS-016, RS-036]
---

## Ask

> In the PO page. I hope it can also link back to the payments.
> [Image #1]
>
> It will be a hyperlink. the format should show. company|32,000$. when i click the button, it will jump to the payment group.

(The image is the desktop Purchase Orders table, Revenue / Payment / Status
columns, with the Payment column showing the `Company` / `Self` chip.)

## Context

The desktop Purchase Orders list has had a Payment column since per-order
commission (v1.43.0): a static chip reading `Company` or `Self` from
`orders.payment`. Meanwhile the Payments page (v1.92.0 onward) links Mercury and
PayPal transactions to POs, and the PO edit page shows the result as a ledger
with a "Net paid" figure (`GET /api/bank-transactions/by-order/:id`). Nothing
went the other way: from the list, a manager could not see whether a PO had
been paid or get to the payment that paid it without opening the PO and then
the Payments page and searching.

The list endpoint `GET /api/orders` said nothing about linked payments. The
Payments page read no URL — its filters were session-persisted state — so
there was no address for "the payments of PO-1234".

Managers only: Payments is manager-only, so the amount and the link are too.
A purchaser (or a manager previewing as one) keeps the plain chip.

## Acceptance criteria

- [x] `GET /api/orders` rows carry `linkedPaid`: the net of the PO's linked
      payments (one row per logical payment, refunds subtract, failed and
      reversed excluded — the same figure as the ledger's "Net paid"), `null`
      when nothing is linked or the caller is not a manager.
- [x] `GET /api/bank-transactions?orderId=PO-…` filters the feed to that PO
      exactly (not the substring `q` match).
- [x] On the desktop PO list, a manager sees `Company | $32,000` (or `Self | …`)
      as a button on every PO with linked payments; other rows keep the chip.
- [x] Clicking it opens `#/payments/po/PO-…`: the Payments page focused on that
      PO — a banner naming the PO with a clear button, only that PO's payment
      group(s) listed, the first expanded. The manager's own filters are not
      overwritten; clearing returns to `/payments` with them intact.
- [x] A purchaser hitting the link path is bounced like the rest of Payments.

## Out of scope

- The mobile PO list — it has no payment column.
- The PO edit page's "Open Payments" button still opens the unfiltered page.
  Pointing it at the same deep link is a one-line follow-up.

## Notes

- Amount = net linked payments, not the PO's cost. The ask's "32,000$" sits
  beside "link back to the payments", and the PO's own cost is already the
  Revenue/Cost columns' business.
- Plan: `~/.claude/plans/graceful-painting-lecun.md` (session-local).
