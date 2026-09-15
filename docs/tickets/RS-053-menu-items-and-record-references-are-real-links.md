---
id: RS-053
title: Menu items and record references are real links
type: story
status: in-progress
priority: P2
created: 2026-09-15
reporter: jinhu
branch: feat/record-links
pr:
version:
related: []
---

## Ask

> When i hold command and click the menu in this ERP system, it should open a new tab, instead of keep rendering the current tab.

> also when i click the PO number in the inventory, it should route to the PO page. keep in mind, ALL po/sell/payment linked in other page should be a link.

## Context

The frontend is a hash router (`apps/frontend/src/lib/route.ts`): `navigate()`
sets `location.hash` and stamps a depth counter for the back button. Every
menu — the desktop sidebar, the phone tab bar, the Inventory ▸ Analysis strip —
and every jump to another record was a `<button onClick={() => navigate(…)}>`.
A button has no URL, so ⌘-click, ctrl-click and middle-click were plain clicks
and the current tab re-rendered. Only two in-app anchors existed (the client
drawer's order list and the activity feed's "Open record"), and several ids
were not clickable at all: the PO id in the inventory lots table, the source
PO on an inventory item, the "Promoted to SO-…" note on a vendor bid, the
sell orders linked to an inventory item.

## Acceptance criteria

- [ ] Every desktop sidebar item, both Inventory tabs and the phone tab bar's
      route tabs are `<a href="#/…">`: ⌘/ctrl/middle-click opens a new tab,
      plain click routes in place and the browser Back button still works.
- [ ] The PO id in the inventory lots table opens `#/purchase-orders/<id>`;
      the thumbnail next to it still opens the lightbox.
- [ ] Every PO id shown on another page is a link: inventory item page
      (location card, summary, archived banner), payments rows and match
      suggestions, shipping rows and "Complete PO" buttons, sell-order history,
      the PO list's open icon, mobile shipping cards.
- [ ] Every sell-order id shown on a desktop page is a link: vendor bid
      "Promoted to", inventory item's linked and blocking sell orders, the
      archive-conflict dialog, the sell-order list's id cell and view/edit icons.
- [ ] Every payment reference is a link: the PO list's payment chip and the
      PO page's "Open payments" both land on `#/payments/po/<id>`.
- [ ] A link inside a clickable row (payments, shipping, mobile cards) does not
      also toggle or open the row.
- [ ] Right-click on any of them offers "Open link in new tab" / "Copy link
      address"; no anchor shows the browser's default blue underline.
- [ ] `hrefFor` / `onLinkClick` are unit-tested in `src/lib/route.test.ts`.

## Out of scope

- Sell-order lines → their source PO: `routes/sellOrders.ts` doesn't return
  the line's `order_id`; needs a backend field first.
- Dashboard "Recent" rows and mobile Inventory cards: their payloads carry no
  `order_id`.
- PO ledger rows → an individual bank transaction, and PayPal txn ids on
  shipping rows: there is no transaction route.
- Sell-order links on the phone (archive dialog): the mobile shell has no
  `/sell-orders` route, so the phone keeps plain text.
- The activity feed's row target: the row is a `<button>` that toggles details
  and the "Open record" anchor appears when expanded; restructuring the row is
  a separate change.
- Selection controls that show an id inside a `<button>` (Payments PO picker,
  Submit's and the phone's draft pickers): an anchor inside a button is invalid
  HTML, and these pick rather than navigate.
- Vendor portal browse/mine tabs: component state, no URL.

## Notes

- The PO page's "Open payments" used to open the unfiltered Payments list; it
  now opens the list focused on that PO, the same screen the PO row's payment
  chip already opened. Small behaviour change beyond the literal ask.
- Plan: `~/.claude/plans/joyful-baking-bumblebee.md` (session-local).
