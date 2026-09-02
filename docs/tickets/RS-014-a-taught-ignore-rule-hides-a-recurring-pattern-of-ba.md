---
id: RS-014
title: A taught ignore rule hides a recurring pattern of bank transactions
type: story
status: in-progress
priority: P2
created: 2026-09-02
reporter: Jinhu
branch: session/20260902-140951
pr:
version:
related: [RS-011]
---

## Ask

> Think of an UI UX and i can ignroe certain pattern of transcation in the mercury.
>
> like a ignore rule.

## Context

The Payments queue exists to be drained: every unlinked row is a payment nobody
has yet tied to a purchase order.  Rows that will *never* tie to one — card
autopay, monthly service fees, the bank's own charges — come back every month
and have to be dismissed by hand, one at a time, forever.  `POST /:id/ignore`
already exists but it is a single-row verdict with no memory, so the same
counterparty is re-ignored on every sync.

The repo already solved this exact shape once.  **Mark-as-transfer teaches a
rule**: it records the counterparty in `bank_transfer_counterparties`
(migration `0102`), reclassifies that counterparty's other rows immediately,
and re-applies on every future sync.  An ignore rule is that mechanism pointed
at `ignored` instead of `category` — which is why this ticket adds no new
concept for a user to learn, and why the design deliberately mirrors
`mark-transfer`'s guards rather than inventing its own.

The risk that shapes the whole design: **an ignore rule hides money.**  A
too-broad pattern silently drops real seller payments out of the queue — the
precise failure the queue is there to prevent.  Everything in the acceptance
criteria below about attribution, reversibility and never overriding a human
is there to bound that.

Decisions Jinhu made up front, before any code:

- **Teach from a row**, not a rule-builder page — the row's `Ignore` button
  gains a caret opening a sheet pre-filled from that transaction.
- **Retroactive by checkbox** — the sheet shows the count of existing matches
  with "ignore those too" pre-checked, so history can be cleaned in one action
  or deliberately left alone.
- **Rules live on the Payments page** as a tile + drawer, not a settings route.
- **Rules are source-scoped** (`mercury` or `paypal`), pre-filled from the
  taught row — same table serves both, as `bank_transfer_counterparties` does.

## Acceptance criteria

- [ ] The `Ignore` button on an unresolved row carries a caret; clicking the
      button still ignores only that row, and the caret opens the rule sheet.
- [ ] The sheet offers exactly three conditions, ANDed: counterparty is `<x>`,
      description contains `<y>`, direction is money-in/money-out.  At least
      one must be selected.
- [ ] The sheet shows a live count of existing transactions the pattern would
      match, updating as conditions are toggled.
- [ ] "Ignore those too" is pre-checked; unchecking it creates a rule that
      applies only to transactions arriving from the next sync onward.
- [ ] A rule never hides a transaction that is linked to a purchase order.
- [ ] A rule never overturns a human verdict: a row a person ignored or
      unignored by hand keeps that state through every subsequent sync.
- [ ] Every rule-hidden row is attributable to the rule that hid it, and says
      so on its status chip.
- [ ] A `Rules` tile on the Payments page shows the rule count and opens a
      drawer listing each rule with its hit count, author, and date.
- [ ] Deleting a rule un-hides the rows that rule hid, and only those — a row
      also matched by a surviving rule, or ignored by hand, stays hidden.
- [ ] "View matches" filters the queue to the rows one rule is hiding.
- [ ] Rule creation is refused on a row already linked to a purchase order.
- [ ] All new strings are translated EN + ZH.

## Out of scope

- Regular expressions, OR conditions, and amount ranges.  The three ANDed
  conditions cover the observed recurring patterns; an expression language is
  a much larger auditing surface for a feature whose failure mode is hiding
  money.
- Editing a rule in place — delete and re-teach.  Editing raises the question
  of what happens to rows the old version hid, for no gain at this volume.
- Rules that match across sources.  A counterparty name can mean different
  things at Mercury and PayPal.
- Mobile and vendor shells.  Payments is a desktop, manager-only page.

## Notes

Design: `docs/superpowers/specs/2026-09-02-bank-ignore-rules-design.md`.

Ticket number collided on allocation: `scripts/ticket.sh` scans the working
tree and `origin/dev`, but session `20260902-121934` held an unpushed RS-013 in
a sibling worktree.  Renumbered by hand to RS-014 — the same trap that already
bites version bumps and migration numbers in this repo.
