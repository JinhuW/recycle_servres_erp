---
id: RS-075
title: In Transit chip names the carrier and links its tracking page
type: story
status: in-progress
priority: P2
created: 2026-09-18
reporter: Jinhu Wang
branch: session/20260918-202813
pr:
version:
related: []
---

## Ask

> update this UI. when it is in transit. It should also have a link for the
> tracking link. for example. In Transit | UPS (Local, Fedex)

(With a screenshot of the desktop PO list's STATUS column, the bare *In
Transit* pill outlined.)

## Context

Since v1.142.0 a PO leaves Draft through the hand-off dialog, which records
how the goods are coming (`orders.handoff_method`: pickup or label) and, for a
label, inserts the tracked package linked to the order. None of that reaches
`GET /api/orders`, so the desktop list shows a bare *In Transit* pill and a
manager scanning the in-transit rows has to open each PO to find its tracking
number. The PAYMENT column already renders `Company | $760` as a chip-link;
the status chip takes the same shape.

## Acceptance criteria

- [ ] On the desktop PO list, a PO in transit by carrier shows `In Transit | UPS`
      (or FedEx / USPS); the whole chip is a link to the carrier's tracking page
      for that number, opening in a new tab.
- [ ] Clicking that link does not toggle the row's line drawer.
- [ ] A PO handed off as a local pickup shows `In Transit | Local`, not linked.
- [ ] A PO that left Draft before the hand-off existed (no method, no package)
      shows plain `In Transit`, as today.
- [ ] `GET /api/orders` rows carry `handoffMethod` and `tracking { carrier,
      trackingNumber, trackingUrl }` (null when no package is linked); both
      additive, so a frontend deployed ahead of the backend still renders the
      plain pill.
- [ ] Other stages are unchanged.

## Out of scope

- The phone PO list keeps its plain status chip; the API fields are there for
  it to pick up later.
- Prepaid labels bought from the *Shipping labels* wizard (`shipments`) are not
  consulted: buying one never moves a PO to In Transit, and every carrier
  hand-off since v1.142.0 inserts a package with the same tracking number.

## Notes

- Tracking wins over the method: a PO with a linked package shows the carrier
  even if `handoff_method` were pickup.
- A PO with several packages shows the newest — one chip, one link.
