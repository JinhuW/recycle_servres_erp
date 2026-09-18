---
id: RS-068
title: Realized profit and the cost rule: review fixes before the 1.149 release
type: bug
status: in-progress
priority: P2
created: 2026-09-18
reporter: jinhu
branch: fix/review-findings-1.149.4
pr:
version:
related: [RS-063, RS-064]
---

## Ask

> /code-review high dev -> mian code review. not only the code , but also the business meaning

Then, on the four findings:

> fix them and merge to main

## Context

A `high`-effort review of the diff a `dev` → `main` release would ship
(`origin/main..origin/dev`: v1.147.1 – v1.149.3, RS-061 … RS-067) returned
four findings, all verified against source. Two sit in the meaning of the
manager-only **Realized profit** RS-064 introduced, one in the no-cost
submit guard from RS-063, one is a wasted query. None has reached `main`
yet, so this is the cheap moment to fix them.

| # | Where | Defect |
|---|---|---|
| 1 | `lib/po-cost.ts` `poRealizedLateral`, sold half | The cost of a sold unit was its line `unit_cost` plus fee share. A negotiated lot price — `orders.total_cost` pinned apart from the line sum, typically a price over `$0` lines — never entered it, so such a PO's realized gross profit read as roughly its revenue while the commission half of the same figure did use the lot price. |
| 2 | `services/poRealized.ts` | The commission netted out was `max(0, projected revenue − total_cost − other fees) × rate`: an unpriced line dropped out of the revenue but its cost stayed in. Every other commission figure — dashboard KPI and per-purchaser rows, the PO spreadsheet — is `Σ over priced lines of (sell price − fee-amortized unit cost) × qty × rate`, where an unpriced line drops out entirely. On a PO with one unpriced line the realized figure netted less commission than the purchaser is shown, so realized profit read high. |
| 3 | `services/orderAdvance.ts` cost guard | The guard fired on *every* Draft → non-Draft move, regardless of history. A legacy `$0` PO (43 in production) sent back to Draft by a purchaser's material edit — or, per `revertOrderToDraftTx`, by nothing more than the carrier poll's next scan — was then stuck: the manager's change-review approve got a raw 409 and the tracking poll logged `missing: cost` on every scan. The ticket and changelog for RS-063 both said "orders already past Draft are untouched". |
| 4 | `routes/orders.ts` list | `poRealizedLateral` ran for every list row for every role; only the JS mapper dropped it for purchasers, whose desktop list fans out over every page. |

Decisions:

- **What was paid for a sold unit** is its share of the negotiated lot price
  when the header states one (`total_cost > 0`, the codebase's own reading of
  a stated price — production carries five submitted POs with a pinned `$0`
  header over priced lines, which must keep costing their lines), else its
  `unit_cost`; plus the fee share, spread by the same cost-weighted rule
  `effUnitCost` uses for fees. For the normal PO, whose header mirrors
  Σ `qty_purchased × unit_cost`, this is the identity.
- **The commission netted out** is the projected commission as the dashboard
  and the spreadsheet show it — the per-line formula over priced lines —
  evaluated on the PO as bought and clamped at zero (RS-064's rule). It can
  still differ from the dashboard on a partially-sold or below-cost PO; that
  is by design. `total_cost` no longer enters the commission; it never did
  anywhere else.
- **The cost rule governs a PO's first submission.** A PO with a submission
  history (`order_events` `submitted`/`reverted`, the same `wasEverSubmitted`
  read delete and archive use) re-submits without it; the manager's
  change-review dialog is where a re-submitted edit is judged. A
  never-submitted `$0` Draft, however old, stays blocked — the reason RS-063
  gave for having no date cutoff. Known consequence: a purchaser who zeroes
  a cost *after* submitting can re-submit at `$0`, visible in the change-review
  diff like any other bad edit.
- **The realized LATERAL is gated in SQL**, with a NULL stub for
  non-managers so the SELECT and GROUP BY don't fork.

Production data check (2026-09-18, before the fix merged): 21 unarchived POs
carry a header that differs from the as-bought line sum — 5 with a NULL
header (PO-1312/1313/1314/1315/1327), 5 pinned at `$0` over priced lines
(PO-1348/1356/1359/1363/1364), 11 real lot prices (PO-1325/1330/1333/1337/
1338/1358/1360/1361/1362/1373/1442). None has the stale-mirror fingerprint
(`total_cost` equal to the *current*-qty sum but not the as-bought sum), so
no data migration ships with this.

## Acceptance criteria

- [x] On a PO with a negotiated lot price, `realized.cost` for a sold unit is
      its share of that price plus fee share; the commission is unchanged by
      the lot price.
- [x] On a PO with an unpriced line, `realized.commission` is the priced
      lines' projection × rate; the unpriced line's cost is still in
      `realized.cost` once it sells.
- [x] The five RS-064 cases (all lines priced, header mirrors the lines)
      produce the same figures as before.
- [x] A `$0` PO that had already left Draft, sent back by a purchaser edit,
      advances again — by the purchaser and by a manager stage-jump — while
      a never-submitted `$0` Draft is still refused.
- [x] The desktop stepper and the phone advance button no longer raise the
      "no cost" dialog on such a PO.
- [x] The purchaser variant of `GET /api/orders` and `/:id` joins a NULL stub
      instead of the realized subquery.

## Out of scope

- The dashboard's manager-lens cost-of-sold KPI has the same lot-price
  blindness as finding 1 (pre-existing, different screen).
- The spreadsheet/dashboard commission on a `$0`-line lot with a negotiated
  price treats the goods as free (pre-existing; it is the figure shown today).
- A test asserting the carrier poll's `missing: cost` warning.

## Notes

Precedent for a review-fix release: RS-022, RS-025, RS-038.
