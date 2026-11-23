---
id: RS-609
title: eBay sales desk: listings page and eBay-only role
type: story
status: in-progress
priority: P2
created: 2026-11-23
reporter: jinhu
branch: feat/ebay-desk-backend
pr:
version:
related: []
---

## Ask

> I would like to create a deciated page for the ebay sell record and give the access to a dedicated user who has the access to the ebay pages.
>
> The person will make some of them as sold or not. 
>
> we can also move the inventory to the ebay listing. 
>
> pls think how to design the workflow.

Later, from the owner: one inventory lot can map to several eBay listings (a
lot of mixed specs is sold as one eBay item per spec); the inventory list shows
each lot's eBay links; the desk is about checking inventory, not shipping, and
is desktop-only.

## Context

eBay selling happens outside the ERP today, so stock sent to eBay isn't
reserved and eBay sales don't flow into revenue and commission. A dedicated
operator should work the eBay queue without seeing cost or suppliers. This
ticket is the role, the desk and the manual workflow; the eBay API sync is a
follow-up.

## Acceptance criteria

- [ ] A manager creates a member with role eBay; that member reaches only the
      eBay desk and the app shell's boot endpoints, and gets 403 everywhere else.
- [ ] A manager sends part of an inventory lot to eBay as one or more listings;
      the units are reserved and the sell-order picker offers less. Listing more
      than is free is refused.
- [ ] The operator links the eBay item #, marks units sold (whole or in parts)
      or ends a listing as not sold; ending gives the remainder back to stock.
- [ ] A confirmed sale becomes a sell order to customer eBay at Awaiting
      payment, with the eBay order # and fees in its note; a listing whose last
      unit sells becomes Sold.
- [ ] A Queued listing can be split into several listings of the same lot.
- [ ] Listing JSON never carries cost, supplier or purchaser.
- [ ] The inventory list and the lot page show the lot's eBay listings.

## Out of scope

The eBay API (publish, sync of sold orders): its own ticket. Shipping.
A phone layout for the desk.

## Notes

Plan: `~/.claude/plans/toasty-rolling-metcalfe-…` (PR A). Backend first; the
desk UI joins the same branch.
