---
id: RS-363
title: A booked PO's payment and Paid by are manager-only
type: bug
status: done
priority: P1
created: 2026-10-23
reporter: jinhu
branch: fix/payer-manager-only-once-booked
pr: 836
version: 1.318.2
related: [RS-353, RS-357, RS-358, RS-359]
---

## Ask

> fix this:
> Security flag: the automated review raised something in apps/backend/migrations/0199_accounting_payer_sync.sql, which came from #826, not this PR. The concern is that a non-manager changing a PO's payment or Paid by could void or reassign its accounting entries. I didn't look into it or change anything. It's worth a look by whoever owns the Paid-by work.
>
> It should be manager only

Asked which changes, the requester chose **"Once booked"**:
- A purchaser keeps setting and editing Paid by on their own PO.
- Once a manager has booked the PO in Accounting, only a manager can change
  its payment or Paid by.
- The purchaser's picker locks, with a note.

## Context

0199's `orders_sync_accounting_payer` trigger keeps a PO's live RMB Flow
entries in step with the PO's payer:
- a flip to the Business Account voids the PO's cost entries;
- a new person moves their Paid by, and since RS-357 clears their sign-off.

Only managers record entries. Until now, though, a purchaser could change
`payment` and `paid_by` on their own PO until Ready to Pay, through PO PATCH
or the hand-off, and so void or reassign a manager's book.

RS-358 had left this as the design ("the PO decides its payer"). The
requester decided otherwise for a PO whose cost a manager has booked.

The rule sits in the two write routes, not the trigger. The trigger can't
tell who saved the PO, and refusing there would also block the bank sync.

## Acceptance criteria

- [x] A purchaser's PO PATCH that changes the payment or Paid by of a PO with
      a live cost entry is refused with 403. The entry, and the PO's stage,
      are unchanged.
- [x] The same change through the hand-off is refused with 403.
- [x] A purchaser's save that leaves the payer as it is still goes through,
      including the hand-off's echo of the payer on file.
- [x] A PO with no live cost entry works as before: no entry, only voided
      ones, or only a commission entry.
- [x] A manager can still make the change, and the entries follow as before.
- [x] The PO payload says `payerLocked` for a purchaser on a booked PO. The
      desktop PO page, the phone PO page and both hand-off surfaces then
      disable Paid by and say why.

## Out of scope

- Deleting a booked, never-submitted draft. The delete keeps a manager's
  entries on their book, only unlinked, and is limited to drafts that were
  never submitted.
- The payer sync triggers themselves (0199, 0200, 0202).

## Notes

"Booked" means a live paid-out purchase entry. `payment` and `paid_by` drive
only the sync's purchase branch. Commission entries follow the commission
payer, which only managers can set.

Drafted as RS-360 (v1.317.5). Three other PRs reached `dev` while this one
waited on CI: #837, #838, and #839, which also took RS-360. So it took RS-363
and v1.318.2 on its last rebase.
