---
id: RS-508
title: Fix sell-order numbering, bid recording and review findings before release
type: bug
status: done
priority: P1
created: 2026-11-02
reporter: jinhu
branch: JinhuW/walrus
pr: 1061
version: 1.409.1
related: [RS-509, RS-510]
---


## Ask

> /code-review all dev changes and merge to main, then release to prod.
>
> pls. create an fix plan , then start the implementation

## Context

The pre-release review of `origin/main...origin/dev` (RS-495–RS-503,
v1.401.0–v1.407.0) found ten defects. Three write wrong data on prod: the
series-keyed `#` lookup added in v1.404.0 (`plannedNos`), and the bid data
points from the vendor price import (`recordBidDataPoints`), which record hand
edits as bids, stack on every re-import and are never withdrawn. These are
fixed before `dev` is released to `main`.

## Acceptance criteria

- [x] A new lot of a part on an order numbered before v1.404.0 joins its own part's `#`, falling back to its series' `#` only when the part has none.
- [x] A part whose price was edited by hand after a price import is not sent as a bid; untouched imported parts still are.
- [x] Saving bid prices again replaces this order's earlier bid point for the part instead of adding a second one.
- [x] Closing a sell order withdraws its bid points, falls `last_price` back to the previous reading, and names the withdrawn prices in the `closed` event.
- [x] The price import is disabled while the draft's currency differs from the saved one; the preview formats in the preview's currency.
- [x] Collapsing a series fold that holds a just-added lot collapses it.
- [x] `deploy/railway-uptime/check.sh` exits 0 when `ALERT_URL` is unset.
- [x] A cash PATCH / handoff on an order id that does not exist answers 404, not the cash-retired 400.
- [x] The unreachable `ambiguous` branch of the price import is gone.

## Out of scope

- Die-code false positives in `chipDieCode` (any three letters; bare `HYNIX`
  prefix): needs an allowlist of real die codes — own ticket.
- Ledger mismatch converting at today's rate rather than the booked one: needs
  the booked rate per entry — own ticket.
- Re-validating a legacy cash PO that flips between the cash check and the
  write transaction.
- Bids still set `ref_prices.last_price`: a newer quote is newer market data,
  and Done records the `sale:` point over it.

## Notes

Plan: `~/.claude/plans/mellow-sauteeing-wilkes.md` (session-local).
