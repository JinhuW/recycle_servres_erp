---
id: RS-350
title: Accounting review mode: another manager signs off each entry
type: story
status: done
priority: P2
created: 2026-10-22
reporter: jinhu
branch: JinhuW/capricorn
pr: 827
version: 1.315.0
related: [RS-340, RS-349]
---

## Ask

> Pls design an UI UX for review mode which for mangers to review all payments in the accouning page.
> Something that we can sign off by any other manager, can we can mark it as reviewed.

After seeing the design:

> The review mode is not required in the Phone. The rest of them looks good to me.
> Pls also cretae a buttom to enter the log page as well.

## Context

The Accounting book (v1.310.0, `routes/accounting.ts`, `DesktopAccounting.tsx`)
records the RMB that moved through the managers' own hands. One manager writes
each entry and nobody else ever has to look at it. Payments has a bank feed to
reconcile against; the book has none, so a second person is the only check it
can have. The sell order already needs the managers' sign-off before Done
(v1.226.0). Since RS-349 (v1.314.0) the book also holds about 41 entries a
migration wrote from Paid by and the payment receiver, which nobody has
looked at.

Each entry's history (`accounting_entry_events`) is shown only in its own
drawer. Activity, the workspace's log, unions the other four ledgers and
leaves this one out, and unlike them it is not append-only by trigger.

Design: [docs/superpowers/specs/2026-10-22-accounting-review-mode-design.md](../superpowers/specs/2026-10-22-accounting-review-mode-design.md),
with the mock linked from it.

## Acceptance criteria

- [x] `#/accounting/review` opens Review mode for a manager; a purchaser, or a
      manager previewing as one, is bounced.
- [x] *For you* lists every live entry the viewer didn't write that is To
      review or Changed since review, oldest first; the viewer's own entries
      are under *Waiting on others* and offer no sign-off.
- [x] Mark reviewed (button, the row's mark, or Space) records the viewer and
      time, moves the row below *Reviewed in this visit* with Undo, and
      selects the next entry.
- [x] The API refuses a review by the entry's author (403) and one sent for a
      version that has since changed (409).
- [x] Editing any field but the note on a reviewed entry clears the review;
      the entry reads Changed since review with was → now, and its editor
      can't review it. Editing only the note keeps the review.
- [x] Restoring a voided entry brings it back To review.
- [x] Query needs text, notifies the author and moves the entry to *Queried*;
      the author's answer or edit returns it to review with the question kept.
- [x] Each row and the side panel show the record, rate and duplicate checks;
      *Mark n reviewed* signs off only To review entries without a warning,
      after a confirm that lists them.
- [x] The book shows a Review column and filter, and the band a Reviewed strip
      for its scope; the header's Review mode button and the sidebar badge
      show the count for you.
- [x] The entry drawer carries the Review card, and its history logs every
      review, withdrawal, clear, question and answer.
- [x] *Log* on the Accounting page and in Review mode opens Activity with the
      Accounting area picked; its rows are the book's history, each opening
      its entry.
- [x] Activity's action filter offers Reviewed and Query.
- [x] `accounting_entry_events` refuses UPDATE and a direct DELETE.
- [x] Every string has its zh translation.

## Out of scope

- The phone: no Review screen, ticks or Log button there. The rules live in
  the API, so a phone edit still clears a review.
- A log page of Accounting's own: Activity is the log.
- Locking a reviewed entry or period: edits stay allowed and reopen the review.
- Every manager signing: one other manager is the control asked for.
- Receipts on an entry, bank Payments rows, and reviewing a void.

## Notes

- One reviewer, any active manager but the author. The author is whoever
  recorded the entry or last changed a field the review covers; backfilled
  entries have none, so any manager reviews them.
