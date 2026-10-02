---
id: RS-151
title: "Supplier name keys and bank pairing: non-Latin names, unpair, bounded pairing windows, currency"
type: bug
status: done
priority: P2
created: 2026-10-02
reporter: jinhu
branch: fix/suppliers-bank
pr: "#470"
version: 1.198.3
related: [RS-105, RS-150]
---

## Ask

> ultrathink all these remaing works, create an detailed implementation plan to achieve the remaining items.

This is Batch 7b of the approved plan,
`docs/superpowers/plans/2026-10-02-code-review-remaining-work.md`, covering
review findings M28 and M20–M23.

## Context

- **M28:** `suppliers.match_key` compressed a name to A–Z/0–9, so every
  non-Latin name keyed as `''|zip`. Those clients collided on the unique
  index, and suggestions matched them all together.
- **M20:** `/unpair` cleared `pair_id` but left the link that pairing had
  spread onto both legs, so the PO's paid figure counted the payment twice.
  Prod had one such case: PO-1383, $2,800, with the two legs six days apart.
- **M21:** `autoPair` read every unpaired row ever, on every sync.
- **M22:** amount-only pairing bucketed across all time, so a stale
  same-amount row blocked a fresh 1:1 match. It also needed no sign the
  Mercury row was PayPal at all, and transfer pairing accepted any external
  Mercury row of the opposite amount.
- **M23:** nothing recorded a bank row's currency. Every amount comparison
  assumed USD, as every PO is.

Prod checks, read-only, 2026-10-02:
- Suppliers: 1, with no empty keys. Suggestion dismissals: 0.
- All 6 transfer pairs carry `PAYPAL;`. All 51 amount-matched payment pairs
  name PayPal on the Mercury leg.
- All rows are USD.

## Acceptance criteria

- [x] Migration 0151 adds `supplier_name_key()`, which keeps the alnum
      compression and falls back to `U:` + the lower-cased trimmed name. The
      generated `match_key` and both of its indexes are rebuilt exactly, and
      `''` dismissals are dropped. Suggestions, adoption and the create-409
      lookup all call the function.
- [x] Ungroup keeps the link, owner and internal transaction on the PayPal leg
      and clears them on the other. Migration 0152 groups PO-1383's legs,
      guarded on both ids, the PO, the amount and their unpaired state.
- [x] `autoPair` reads the last 120 days plus pending rows. Its amount-only
      and transfer matches each need a unique counterpart inside the window.
      An amount-only match needs a PayPal marker on the Mercury leg; a
      transfer match needs the ACH descriptor.
- [x] Migration 0153 adds `bank_transactions.currency`, set by both providers.
      Reconciliation is USD-only, `/link` and `/pair` refuse other currencies,
      and the feed shows a "{CUR} · not reconciled" chip.

## Out of scope

- Converting foreign-currency rows. No such row exists, and every PO is USD.

## Notes

- The local `fakeProvider` helpers in tests gained `currency: 'USD'`. Without
  it the new upsert column got `undefined`, and that source's sync failed into
  its own result slot, silently.
