---
id: RS-357
title: A Paid by that follows the PO clears the entry's sign-off
type: bug
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: review-follows-po-payer
pr: 831
version: 1.317.2
related: [RS-350, RS-354, RS-355]
---

## Ask

> Still open lgtm. start the implementation

(Answering: "if a PO's payer changes from one person to another, its
entries' Paid by follows, but a sign-off already on them stays. Say if
you'd rather that send the entry back for review.")

## Context

Review mode (RS-350, v1.315.0) clears an entry's sign-off when any field but
the note is edited. The entry then reads *Changed since review* and goes back
to the queue (`PATCH /api/accounting/entries/:id`, `routes/accounting.ts`).
Since v1.317.0 (RS-354, RS-355) an entry's Paid by also changes without
anyone editing the entry. When a PO's payer moves from one person to
another, `accounting_sync_payer` (migration 0199, run by triggers on
`orders` and `bank_transactions`) moves the PO's live paid-out entries of
that kind. It sets `manager_id` and writes an `edited` event with
`synced: 'po'`, but leaves `reviewed_by` / `reviewed_at` alone. So a reviewed
entry kept its sign-off while showing a payer the reviewer never saw.

0199 had already run on the dev database, and a deployed migration is never
edited, so the fix replaces the function in a new migration.

## Acceptance criteria

- [x] A reviewed entry whose Paid by follows its PO to another person reads
      *Changed since review*. Its reviewer and sign-off time are cleared,
      and its author stays as it was.
- [x] The `edited` event that move writes carries `clearedReview: { by, at }`,
      as an edit through the route does. The review queue's *Changed since
      review* diff then shows Paid by from → to and names the earlier
      reviewer, and Activity shows *review cleared*.
- [x] An entry that wasn't reviewed keeps its state: To review stays To
      review, Changed stays Changed, and an open question stays open, not
      answered.
- [x] The history line reads *Paid by followed the PO. Review cleared* when it
      cleared a sign-off (en + zh).
- [x] Review mode doesn't name a person for a change the PO made: the queue
      row's line under the id reads *Paid by followed the PO*, not *changed
      by ‹author›*, and the entry's review card names it the same way
      instead of "—".
- [x] Applies however the PO's payer moved: the PO page, a commission
      screenshot, a hand-off, or another entry's Paid by writing back to the
      PO.

## Out of scope

- Making the PO's editor the entry's author. The trigger doesn't know who
  saved the PO, so the original author still can't sign it off and any other
  manager can.
- Voids by the Business Account path: a voided entry is already out of
  review, and Restore already resets the review.
- A backfill. On prod, review mode (0197) arrives in the same release as
  0199, so nothing is signed off when 0199's one-off backfill runs. The dev
  database is overwritten from prod every night.

## Notes

- Plan: `~/.claude/plans/wild-honking-pumpkin.md` (session plan, not in repo).
- Found in the browser check: the queue row's subline read *changed by Alex
  Chen* and the review card's read *— · date* for a move nobody typed, since
  the author stays and the event has no actor. The review queue's `cleared`
  now carries `followedPo` (the last edit since clearing had `synced: 'po'`).
  The same check showed the subline running into the next column whenever
  it was longer than the 112px id column, *changed by ‹long name›*
  included. It now wraps.
