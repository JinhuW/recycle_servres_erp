---
id: RS-026
title: Group a pending payment leg with its settled sibling
type: task
status: in-progress
priority: P2
created: 2026-09-04
reporter: jinhu
branch: fix/rs-026-pair-pending-legs
pr:
version:
related: [RS-024]
---

## Ask

> also debug the reason, why these two can not group togther.
>
> — then, once the cause was found:
>
> still group them not matter the status

## Context

Two rows on Payments, same day, same −$11,760: the settled PayPal charge to
Kar-Deng Louie (`8XP89628U5370762W`) and the Mercury pull that funds it
(`cef69e68…`, "PAYPAL *MENTOSJAI"), which Mercury reports as *pending* for a
day or three before it posts.  v1.127.0 (RS-024) refused to pair any leg that
had not settled — in `autoPair`, in the picker's `pairEligibleFrag`, in
`POST /:id/pair`, and in the frontend's "Group with…" gate — so one payment sat
as two Unlinked rows with no way to join them.

RS-024's rule was written for the case that prompted it, a pending **PayPal
charge**, whose Mercury leg genuinely does not exist yet.  The mirror case is
the common one in production: the charge is settled and the *pull* is the
leg still in flight.  Both rows exist; the pair is real.

Decision: **a pending leg pairs like a settled one**, automatically and by
hand.  Failed and reversed legs stay unpairable — they are records of money
that never moved, or came back.

## Acceptance criteria

- [ ] A pending leg (either side) is auto-paired on the sync, is offered by the
      picker, and is accepted by `POST /:id/pair`.  Only a failed or reversed
      leg is refused.
- [ ] A group is badged *Pending* while any of its legs is; the `?settle=`
      filter agrees with the badge.  A reversed PayPal leg still reads
      *reversed* whatever its sibling is doing, and stays out of the PO's paid
      total.
- [ ] The expanded row shows which leg is the pending one.
- [ ] A pair whose leg later *fails* dissolves on the next sync, without a
      human tombstone, so the retried pull can pair with the same charge.
- [ ] Transfer pairing still requires settled legs.

## Out of scope

- The PO payments ledger (`/by-order`) still reads the PayPal leg alone, so a
  PO whose Mercury pull is pending reads as cleared there until it posts; a
  Mercury leg that *reverses* inside a pair is likewise invisible to the
  ledger's total.  Pre-existing; noted, not fixed.
- Any change to the 3-day auto-pair window.  A pending Mercury row is dated
  by its creation, the same day as the charge, so the window is not the
  problem.

## Notes

**Dead-first, not pending-first.**  The first draft derived a group's state
as "pending if any leg is pending, else the display leg's" — which would have
read a *reversed* PayPal charge paired with a pending pull as pending, and
counted it back into the PO's `net`.  `groupSettleFrag` (`banktx/match.ts`)
checks the display leg for a dead state before looking at siblings, and both
the list's badge and its filter use that one expression.

**Why the dissolve clears only `pair_id`.**  Mercury pulls fail and are
retried under a new id — prod carries several same-amount `failed` rows from
one payment.  Setting `no_auto_pair` (what a human Ungroup does) would stop the
surviving charge pairing with the retry on its own.  Transfer pairs are left
alone, and the count is logged.

**Found on the way:** the by-hand test could not use the list's
`pairCandidate` outside the 3-day window (only `/pair-candidates` looks 30
days back); it assigns a leg instead, which `autoPair` honours and the picker
does not.
