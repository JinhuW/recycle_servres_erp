---
id: RS-105
title: Ignore rules for bank transactions
type: story
status: in-review
priority: P2
created: 2026-09-24
reporter: jinhu
branch: feat/bank-ignore-rules
pr:
version:
related: []
---

## Ask

> I would like to create an editor that i can ignore certain type of transcations.
>
> for example all gas fee, kind of things. also help me ignore all transaction that unlinked before Aug 1.

## Context

Ignore is per-row (`POST /api/bank-transactions/:id/ignore`, v1.90.0). The
unlinked queue on prod is dominated by recurring card spend — gas stations,
meals, Uber, Ship Saving labels, rent — that is re-dismissed by hand after every
sync. 180 unlinked external rows posted before 2026-08-01 (179 Mercury, 1
PayPal) predate the reconciliation practice and will never be linked.

The rules are modelled on the counterparty-taught transfer rules (v1.94.0):
stored in a table, applied by every sync, retractable.

## Acceptance criteria

- [x] A manager can open an "Ignore rules" editor from the Payments page and add,
      edit, delete rules: source (any / Mercury / PayPal), a case-insensitive
      "contains" pattern matched against counterparty or description, a label.
- [x] Saving a rule ignores every currently open (unlinked, external, not
      failed/reversed) matching row and reports how many; the editor previews the
      count before saving.
- [x] Every sync re-applies the rules, so new matching rows never reach the
      unlinked queue — and a matching PayPal leg still pairs with its Mercury
      settlement first, so both legs go.
- [x] Deleting or editing a rule restores the rows it ignored unless another rule
      still claims them; rows a human ignored are untouched.
- [x] Un-ignoring a rule-ignored row by hand sticks: no rule re-ignores it.
- [x] Rule-ignored rows show the rule's label in the Ignored list.
- [x] Linked rows, transfers, and rows paired to a linked leg are never rule-ignored.
- [x] One-off: every unlinked external row posted before 2026-08-01 00:00
      America/Denver is ignored, pairs whole (migration).

## Out of scope

- Regex / glob patterns — "contains" covers every prod case seen.
- An amount cap per rule — delete/edit is the escape hatch.
- Ignoring transfers (they are already off the queue).
- A "make a rule from this row" shortcut on the row's Ignore button.
- Mobile shell — Payments is desktop-only.

## Notes

Plan: `~/.claude/plans/rippling-munching-thimble.md`.

- Deviation from the plan, found while implementing: the plan only ordered the
  sync's rule pass after `autoPair`, which covers a charge and its settlement
  arriving in the *same* sync. In prod the Mercury settlement trails the PayPal
  charge by days, so by the time it arrives the charge is already rule-ignored
  and `autoPair` (which skips ignored rows) would strand it. Fix: `autoPair`
  now admits rule-ignored rows (`ignore_rule_id IS NOT NULL`) to payment
  pairing only — a human's Ignore still takes a row out — and the rule pass
  spreads the ignore onto any un-ignored pair sibling, not just this pass's
  hits. Covered by the "every sync re-applies the rules, after pairing" test.
- Prod count for the one-off, measured 2026-09-24: 180 rows (179 Mercury, 1
  PayPal) before the pair spread.
