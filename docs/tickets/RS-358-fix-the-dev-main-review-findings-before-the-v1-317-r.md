---
id: RS-358
title: Fix the dev→main review findings before the v1.317 release
type: bug
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/monkfish
pr:
version: 1.317.3
related: [RS-349, RS-350, RS-351, RS-352, RS-353, RS-354, RS-355, RS-356, RS-357]
---

## Ask

> Once all workspace merged to dev, then you run a full throught /code-review from dev to main, the release to prod.

## Context

`dev` carried v1.314.0 → v1.317.2 (RS-349 to RS-357) ahead of prod's v1.313.1.
Most of it is the Accounting work: the RMB Flow, Review mode, and Paid by
synced between an entry and its PO by triggers (migrations 0196–0200). Once no
other session had work heading to `dev`, `/code-review xhigh` ran over
`origin/main...origin/dev` and raised fourteen candidates. Nine are fixed
here. Five are left, with the reasons under *Out of scope*.

## Acceptance criteria

- [x] **A cost entry can't move a reviewed PO's payer.** Recording or editing
      a paid-out purchase entry on a Ready to Pay or Done PO, with a Paid by
      other than the PO's, is refused (409), as PO PATCH refuses it. The
      payer is reimbursed through the commission, so it is part of the closed
      book.
- [x] **A new owner takes over a payer that was the old owner.** A manager
      reassigning a self-paid PO (PO page or hand-off) moves `paid_by` with
      it when it named the old owner, with an Activity line, as Self meant
      before a payer was named. A manager who paid stays. A payer the same
      request picked also stays.
- [x] **The review count shows under the Accounting parent.** RMB Flow
      carries it as a child, and the folded Accounting parent shows it too.
- [x] **Review mode's money panel reimburses only the purchaser who paid.**
      Box Check's *Self pay* row and *Purchaser earns* add the cost only when
      the purchaser is the payer, the rule the Commission tab and phone sheet
      use (`costReimbursedToOwner`).
- [x] **The entry form locks only what the server refuses.** On a PO the
      Business Account paid, a refund or clawback (direction in) can be
      recorded. An entry restored there stays editable while its record,
      direction and payer stay.
- [x] **A restored entry catches up with its PO's payer**, as RS-354 asked.
      It re-runs the sync for its PO, which it skipped while voided.
- [x] **Withdrawing a sign-off puts back what it cleared.** The sign-off
      keeps the question, answer and *Changed since review* mark on its
      event. Undo restores them, so the entry reads Queried or Changed
      again, with its diff.
- [x] **Review diffs name any payer.** Paid by from → to resolves purchasers
      and deactivated managers, not only active managers.
- [x] **The bank sync no longer runs the payer sync for nothing.** 0201
      splits the `bank_transactions` trigger. Inserts and deletes always run
      it; updates run it only when the link or the settlement actually moved.
      The upsert writes `settle_status` on every re-fetched row.

## Out of scope

- **0199's backfill reassigning hand-recorded cost entries** (0198 named the
  purchaser on every self-paid PO). On the prod→dev copy of 2026-10-23 the
  book held no hand-recorded cost entries, and 0199 voided or moved nothing.
  0198/0199 already ran on dev and aren't edited. Prod gets the same check
  just before the release.
- **A purchaser's PO edit moving a manager's entry.** That is the RS-354/355
  design: the PO decides its payer. The move clears the entry's sign-off
  (RS-357), so a manager sees it.
- **Split commission payments collapsing onto one payer.** RS-354 asked for
  one linked value per PO.
- **Relinking an entry booked to a deactivated manager is refused.** The
  relink writes that payer to the new PO, which must name someone active.
- **A possible deadlock between the bank trigger and an entry save on the
  same PO.** It needs both to rewrite the same two entries at once, and
  Postgres aborts one of them. Locking the PO inside the trigger would invert
  PO PATCH's order (orders, then the PayPal row it links), trading a rare
  deadlock for another.
