---
id: RS-359
title: Fix the v1.317 prod release review findings
type: bug
status: done
priority: P2
created: 2026-10-23
reporter: jinhu
branch: JinhuW/polyp
pr: 834
version: 1.317.4
related: [RS-349, RS-350, RS-353, RS-354, RS-355, RS-357, RS-358]
---

## Ask

> /code-review max review all code change from dev to prod, relese it once you fix all identified issues.

## Context

`/code-review max` ran over v1.313.1 → v1.317.x, the Accounting work of RS-349
to RS-357: the RMB Flow backfill (0196), Review mode (0197), Paid by naming a
person (0198), and the triggers keeping an entry's Paid by in step with its
PO (0199–0201). While it ran, another session shipped that range to prod as
v1.317.3 (RS-358, #833). The review re-checked every finding against that
release, so these fifteen, and the smaller ones after them, are live in prod.

Migrations 0196–0201 have run on prod, so the database fixes are a new
migration (0202). A read-only check of prod on 2026-10-23 found 42 entries,
all backfilled (20 commissions, 22 sales). None was reviewed, queried or
restored, and no sell order had a bank row linked. So nothing on prod was
affected yet, and no data needs repair.

## Acceptance criteria

Four-eyes and the payer sync (0202):

- [x] **A payer the PO moves is written by the manager who moved it.** When a
      PO-side change (PO page, commission screenshot, bank link/unlink/pair,
      another entry's write-back, a restore) moves an entry's Paid by, that
      manager becomes the entry's author. They can't sign the move off; the
      entry's old author can. Routes name the actor with `actAsTx`
      (`app.actor_id`). A purchaser's save or the bank sync keeps the author.
- [x] **Only a restore of a Business Account void exempts an entry.** An entry
      voided and restored by hand is voided again once its PO is paid from the
      Business Account. An entry restored from that void stays restored.
- [x] **A sign-off or void that commits during a payer move isn't lost.** The
      sync locks the PO's entries before reading them.
- [x] **Events read in the order they were written.** `created_at` defaults
      to `clock_timestamp()`, so a restore shows before its catch-up edit.
- [x] **A question stays with the manager it was asked of.** The addressee
      is stored (`query_to`) and survives the payer moving. Answering, the
      badge's *asked* count, and the Undo of a sign-off all read it.

Accounting routes:

- [x] **The purchaser can take a self-paid cost's refund.** A purchase entry
      in either direction may name the PO's purchaser as Paid by. Refunds and
      a flip to *in* now save.
- [x] **An unchanged payer isn't judged again** on an entry that writes
      nothing to a PO. Changing the direction or kind of an entry booked to a
      deactivated manager saves.
- [x] **A voided entry's question can't be withdrawn** (409).
- [x] **A sale the Business Account also received gets a warning.** A live
      Mercury/PayPal deposit linked as the sell order's payment adds a
      *businessReceived* warning in Review mode, which keeps the entry out of
      the bulk sign-off. It is a warning, not a refusal, because a sale can
      arrive partly in cash to a manager.
- [x] **A deleted draft's entries are a new version.** The delete unlinks them
      itself, moves their version, and clears a sign-off. The `unlinked`
      event carries the record change, so the review diff shows
      *PO-… → —*, and a stale page can't sign it off.

PO payer (orders):

- [x] **Only a payer the request picks is judged**, against the owner the PO
      will have. An echo of the payer on file passes, even a manager
      deactivated since, so the hand-off and saves no longer fail on a field
      nobody touched. A request that hands the PO to a new owner can't pick
      the old owner as payer.
- [x] **A move plus another change logs the payer once.**

Frontend:

- [x] **A Paid by change is material** on the desktop and phone PO pages. A
      purchaser gets the *back to Draft* warning, and the phone can save a
      payer-only change.
- [x] **Paid by follows On behalf of** on the PO pages and Submit. A payer
      that named the old owner moves to the new one, and the old owner isn't
      offered.
- [x] **Switching purchase ↔ commission drops the picked PO**, so no payer,
      lock or default from the other kind carries over.
- [x] **Review mode:**
  - Moving off an entry closes its question/answer form.
  - Undo uses the current tab and filter, and ignores a second press.
  - Bulk sign-off goes out in batches of 200.
  - Counts say *1 entry*.
  - The new warning renders in en and zh.
- [x] **The entry form's payer lock can be undone:** a changed payer can be
      put back.
- [x] **Accounting survives an older backend's summary** (no `review`).
- [x] **The folded sidebar keeps the Accounting icon** under its count.

## Out of scope

- **A manager who restores an entry can sign it off.** Whether a restore
  needs a second manager is a product decision, not a bug.
- **Tabs opened before v1.317 crashing on an Accounting row in Activity.** It
  was transient and passed with the release.
- **Cleanups the review listed:**
  - the review-state rules duplicated between TS and SQL, and between client
    and server;
  - `useMemberNames` calling the costly `/api/members`;
  - unit tests for the older pure helpers.

  Correctness came first.
- **Repairing prod data.** The 2026-10-23 check found nothing affected (see
  *Context*).

## Notes

- `app.actor_id` is set with `set_config(…, true)`, local to the transaction.
  A route that can move a payer calls `actAsTx` before its first write. A path
  that doesn't (the bank sync) just leaves the author as it was.
- The race test (`accounting.test.ts`, *a sign-off that commits while the PO
  moves the payer*) fails without 0202's lock-first step. It was run that way
  once to prove it.
- The frontend half was built by a parallel agent from this ticket's
  decisions. It was then reviewed here.
