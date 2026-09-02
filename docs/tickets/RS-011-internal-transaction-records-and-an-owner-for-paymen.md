---
id: RS-011
title: Internal transaction records, and an owner for payments with no PO
type: story
status: done
priority: P2
created: 2026-09-01
reporter: Jinhu
branch: session/20260831-225948
pr: 242
version: 1.119.0
related: []
---

## Ask

> Maybe it worth to create an interal transcation record and it can group all
> related payment. for example the transfter from mercury to paypal. etc.
>
> use can also put certain transaction to our internal payment or link to
> internal payments.
>
> cuz i also hope to create an note for it

And, a few minutes later:

> each payment will be great can assign to a member when it is not linked to a PO

## Context

Both halves are the same gap: **a bank transaction that isn't a seller payment
has nowhere to say what it is or whose it is.**  The Payments page offers three
verdicts — link it to a PO, flag it `transfer`, or ignore it — and none of them
carries text or a person.

- `pair_id` (`0100_bank_transactions.sql`) is structurally two legs, one Mercury
  + one PayPal, equal *signed* amounts, and it collapses them into a single feed
  row.  `sync.ts → transferPair()` already pairs the obvious Mercury↔PayPal
  transfer.  It cannot hold three legs, cannot span two Mercury rows, and has
  nowhere to write why.
- `category = 'transfer'` (`0101`, `0102`, `0104`) is a two-value enum that drops
  a row out of the unlinked queue.  It says *"not a seller payment"*, not *which*
  movement it belongs to.
- **There is no user-editable text on `bank_transactions` at all.**
  `description` and `counterparty` are provider-owned and rewritten by every
  sync's upsert, so neither can hold a note.
- Nothing records who a payment *belongs to*.  `linked_by` records who reconciled
  a row; an unexplained $600 therefore sits in the queue with no way to put it on
  the person who can explain it.

So the two asks become two independent pieces of state that compose:

| | Internal transaction | Assignee |
|---|---|---|
| Answers | *what* this money was | *whose* it is |
| Cardinality | many transactions → one record | one member per transaction |
| Effect on the queue | leaves it (`category = 'transfer'`) | **stays in it** |
| While PO-linked | not allowed | not allowed (DB CHECK) |

Assigning a member deliberately does **not** resolve the row.  The point of
putting a payment on a person is that it still needs explaining — it gets an
owner and a filter, not a verdict.

## Acceptance criteria

- [ ] A manager can create an internal transaction with a title and a note, and
      edit both later
- [ ] Any number of bank transactions can be filed under one record, from the
      Payments row or from the record's own transaction search
- [ ] A filed transaction leaves the Unlinked queue and shows which record it
      belongs to; removing it from the record does not silently return it
- [ ] The record shows its members' money correctly: a −$5,000 Mercury leg and
      the matching +$5,000 PayPal leg net to $0, while a payment pair (the same
      money seen twice) counts once
- [ ] A manager can assign an unlinked payment to a member, and unassign it
- [ ] An assigned payment **stays** in the Unlinked queue, shows its owner, and
      can be found with an Assignee filter (including "Unassigned")
- [ ] A payment linked to a PO cannot be assigned, and linking a PO to an
      assigned payment clears the owner — including on the automatic sync path,
      which must not error or stall
- [ ] Automatic pairing leaves an assigned or filed transaction alone rather than
      restructuring it behind the manager's back
- [ ] Both new views are manager-only at all three frontend gates and at the API

## Out of scope

- **Letting the assigned member see their own payments.**  The whole
  `/api/bank-transactions` router is hard-403 for non-managers and there is no
  mobile payments surface at all, so assignment is manager-side routing in this
  cut.  Giving an assignee their own view is the obvious follow-up.
- **Bulk select** on the Payments table — the page has no checkbox pattern today.
  A group is built one row at a time, or from the record's Add-transaction
  search, which is the better path anyway.
- **Auto-suggesting the counterpart leg** when building a record.  The existing
  candidate query requires equal *signed* amounts, so it cannot serve an
  opposite-sign transfer without a second matcher.
- **A human-readable ref** (`IT-0001`).  Nothing needs to cite these records
  elsewhere yet.

## Notes

- Naming: "transfer" already means two things here (warehouse transfer orders,
  and `category='transfer'`), so the record is an *internal transaction*
  everywhere in the UI rather than a third meaning of the same word.
- The asymmetry between the two kinds of state is deliberate: linking a PO
  **clears** an assignee but **refuses** a filed transaction.  The owner tag is
  triage state with no other home; a membership is part of a record that carries
  someone's written note.
- Plan review caught that the new `assignee_id IS NULL OR order_id IS NULL`
  constraint has four writers, not two — `pair` and `autoPair` both propagate a
  lone order link onto their new sibling.  Missing the second would have aborted
  the whole sync transaction on every run.
