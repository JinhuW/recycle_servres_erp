---
id: RS-044
title: Dev-to-main review findings before the prod cut (v1.138)
type: bug
status: done
priority: P2
created: 2026-09-13
reporter: jinhu
branch: session/20260913-001639
pr: 312
version: 1.138.4
related: [RS-039, RS-041, RS-042, RS-043]
---

## Ask

> /code-review high dev -> mian, fix all issue and merge to main

## Context

A `high`-effort review of the diff a `dev` → `main` release would ship
(`origin/main...origin/dev`: v1.138.0 – v1.138.3, RS-039..043) returned ten
findings, all verified against source.  None are on `main` yet, so this is the
cheap moment to fix them, as RS-038 was for the previous release.

The findings, and what each actually costs:

| | Where | Cost if shipped |
|---|---|---|
| 1 | `lib/sellOrderMarket.ts` | A confirmed bid is recorded per canonical part, but the import prices per (part, condition).  X/New at $100 and X/Used untouched at $40 writes a $80 "bid" the customer never quoted |
| 2 | `DesktopSellOrders.tsx` save | `bidParts` is cleared only by the post-save re-fetch; a save whose PATCH succeeds but whose status step fails re-sends the bids on retry, appending duplicate `bid:` events |
| 3 | `routes/inventory.ts` analysis | `liveCond` now drops Sold lines of an archived PO — contradicting its own comment and the list, which keeps them as the sales record |
| 4 | migration `0124` | Deletes lines from Shipped / Awaiting-payment sell orders unattended at boot, a step the runtime only takes after a manager confirms.  Already applied on dev; prod runs it on the main deploy |
| 5 | `DesktopOrders.tsx` payment chip | `linkedPaid` can be negative (a refund with no payment leg) and renders as `$-120` |
| 6 | `DesktopPayments.tsx` focus | The focused list shows every row linked to the PO, reversed legs included, with no total to reconcile against the chip.  `POST /:id/pair` also lets an ignored leg become linked |
| 7 | `routes/inventory.ts` transfer receive / discard | A 0122-restored In Transit line on an archived PO is received to Done with no archive cascade: hidden from every list, absent from `?status=Archived`, only reachable by id |
| 8 | `DesktopPayments.tsx` | `focusOrder` is percent-decoded twice; a `%25` in the hash throws in render |
| 9 | `services/orderAdvance.ts` | The `ARCHIVED_LINE_STATUS` comment says a filter on `orders.archived_at` "could not" work — the release adds exactly that join in four files |
| 10 | tickets | RS-042 (#307) shipped with no bump and stayed `in-review`; RS-040 was closed separately (#311) |

## Acceptance criteria

- [x] `PATCH /api/sell-orders/:id` takes `bidParts` as `{ partNumber, condition }`
      objects; a bid is recorded from the lines matching the confirmed
      (part, condition) only, and a `null` condition covers every line of the
      part.
- [x] The desktop sell-order editor clears its pending bid parts as soon as the
      PATCH resolves, so a retry after a failed status step re-sends no bids.
- [x] `GET /api/inventory/analysis` keeps counting Sold lines on an archived PO;
      archiving a PO drops only its unsold units.
- [x] `fmtUSD`, `fmtUSD0` and `fmtMoney` render negatives as `-$120` / `-¥120`.
- [x] The Payments page focus banner shows the PO's net paid, matching the PO
      list chip; leaving focus re-arms the auto-expand.
- [x] `POST /api/bank-transactions/:id/pair` refuses when either leg is ignored.
- [x] Receiving or discarding a transfer whose PO is archived lands the line at
      `Archived` with the audit row unarchive reads, not at Done / its prior
      status.
- [x] `focusOrder` is decoded once.
- [x] The `ARCHIVED_LINE_STATUS` comment states the two-authority rule.
- [x] RS-042 is closed with a version; RS-040 is closed.
- [x] Prod holds no non-Sold/Archived line on an archived PO that a Shipped or
      Awaiting-payment sell order names, checked read-only before the main
      merge (0124's only irreversible path).
- [x] Backend + frontend suites, typecheck green; `dev` then `main` carry the
      release.

## Out of scope

- A shared `stockLineFrag` / `isStockLine` helper across the nine archived-PO
  readers: each admits a different status set (Reviewing+Done, Done only,
  `<> Archived`, all-but-Sold), so a helper would wrap only
  `o.archived_at IS NULL` and hide which set each reader uses.
- Editing migration `0124`: it is deployed on dev.  Its prod effect is gated by
  the read-only check above instead.
- `lib/market.ts` internal averages still counting archived POs (RS-041 listed
  it out of scope).
- A hand-edited price after an import is still recorded as a bid (design gap,
  not a defect of this release).

## Notes

Precedent: RS-038 (v1.137.1, PR #299) for the previous release.  RS-040 was
already closed by #311 before this ticket was filed; only RS-042 needed the
status + version.  The launcher fix in #307 rides this release's changelog
section since it shipped without a bump.

Prod check for 0124, run read-only over `railway ssh -e production -s
Postgres` on 2026-09-13 before the main merge: 3 archived POs; 0 lines that
0124 targets at all (non-Sold/Archived, not on a pending transfer); 0 such
lines on any Draft, Shipped or Awaiting-payment sell order.  The migration is
a no-op in prod, as RS-041 predicted after PO-1390 was cleared by hand.
