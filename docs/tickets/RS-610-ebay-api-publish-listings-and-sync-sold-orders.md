---
id: RS-610
title: eBay API: publish listings and sync sold orders
type: story
status: in-progress
priority: P2
created: 2026-11-23
reporter: jinhu
branch: feat/ebay-api-sync
pr:
version:
related: [RS-609]
---

## Ask

> Sync with eBay API

(The owner's choice when asked how the ERP should talk to eBay, while the eBay
desk of RS-609 was being designed.)

## Context

RS-609 gives the eBay operator a desk where listings are posted and sales
recorded by hand: the item # is typed in, and each sale is marked sold from
what the operator saw on eBay. This ticket connects the ERP to the seller's
eBay account so that a Queued listing is published from the desk, a price
change or an End reaches eBay, and eBay's sold orders arrive on the desk as
sales to confirm. A person still confirms each sale before it becomes a sell
order.

## Acceptance criteria

- [ ] Settings ▸ eBay (managers only) connects the seller account through
      eBay's consent page, shows the username, "Reconnect by <date>" and the
      last sync ("Last sync 4 min ago, 2 new sales" or eBay's error), and has
      Reconnect, Disconnect and Sync now. No policy or location pickers: the
      account's defaults are used and the card names any that are missing.
- [ ] The consent callback refuses a state that is unknown, expired, reused or
      another user's. The refresh token is stored sealed and no response ever
      carries a token.
- [ ] `POST /api/ebay/listings/:id/publish` (manager or eBay operator) creates
      the inventory item, offer and listing, and the listing becomes Listed
      with its offer id, item # and URL. eBay's errors come back verbatim. A
      retry after a partial failure reuses the offer eBay already has.
- [ ] A price change on a published listing is revised on eBay first, and End
      withdraws it on eBay first; if eBay refuses, the ERP changes nothing.
- [ ] Every 10 minutes, and on Sync now, eBay orders for the desk's listings
      become Detected sales, once each however often the sync runs. A
      cancelled order dismisses a Detected sale; a confirmed one is flagged for
      a manager and never undone automatically. The sync never raises a sell
      order. Two runs never overlap.
- [ ] Setup is documented (RuName redirect, env vars, business policies).

## Out of scope

- Picking shipping, payment or return policies or the location in the ERP
  (the owner chose the account defaults).
- Pushing quantity to eBay after a sale is confirmed: eBay lowers it at
  checkout, and the ERP's remainder lags by the unconfirmed sales.
- Revising title, condition or photos of a live item, and the sweep that marks
  listings ended on eBay outside the ERP.
- Creating an eBay inventory location from a warehouse address.

## Notes

- Plan: "PR B: eBay API sync" of the eBay desk plan.
- Unverified until the sandbox run: the eBay category ids per ERP category,
  the item-specific names, whether `commerce.identity.readonly` is granted to
  the keyset, and the exact error a withdraw of an already-ended offer gives.
