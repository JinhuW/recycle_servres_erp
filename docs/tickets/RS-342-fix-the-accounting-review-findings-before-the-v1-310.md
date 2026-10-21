---
id: RS-342
title: Fix the Accounting review findings before the v1.310 release
type: bug
status: done
priority: P1
created: 2026-10-21
reporter: jinhu
branch: accounting-review-fixes
pr: 814
version: v1.310.2
related: [RS-340, RS-341]
---

## Ask

> /code-review xhigh dev to main, fix all issues and release to prod.

## Context

PR #812 (Accounting, RS-340, v1.310.0) reached `dev` after the xhigh review of
the release had run, so RS-341 didn't cover it. It got its own high-effort
review before going to prod. That review found nothing blocking. It found four
low-severity defects, all in code this release ships:

- **Payer re-filled on every edit** (`routes/accounting.ts`, PATCH). Any save
  of a commission entry re-ran the "nobody on file" fill. A Paid by a manager
  had cleared on purpose came back on the next note edit, with an Activity
  line under the editor's name. The screenshot rule this follows fires only
  on upload.
- **Payer not moved with a corrected manager.** The form defaults the manager
  to whoever is signed in. An entry booked as A, filled A as payer, and then
  corrected to B left the PO saying A.
- **Inactive manager preset** (`useAccountingEntryForm.ts`). A preset naming a
  manager no longer active (a balance holder, or a sale's receiver since
  deactivated) wasn't among the select's options. The select showed someone
  else, and the save was refused with "managerId must be an active manager".
- **Refund read as owed** (`AccountingCard.tsx`). The sale card's suggested
  amount subtracted the ledger's net, which includes the cases' refunds. A
  ¥10,000 order paid in full with ¥1,000 refunded suggested ¥1,000 still owed.

## Acceptance criteria

- [x] PATCH fills Paid by only when kind, link or direction changed. A note
      edit after Paid by was cleared leaves it cleared.
- [x] Changing a commission entry's manager moves Paid by to the new manager
      only while Paid by is still the old manager. Nobody on file, someone
      else, the company or a linked bank row stay as they are.
- [x] A new entry whose preset manager isn't an active manager opens on the
      signed-in manager.
- [x] The sale card suggests the order total less what was booked on the order
      itself (`owedOnSale`). Case refunds don't count.

## Out of scope

- Re-checking Paid by when an entry is voided or moved. FEATURES already says
  those never clear it.

## Notes

- Found by a review of `156fb97d..bfcd64eb`. The same pass confirmed the
  authorization, lock order, migration 0191, keyset cursor and en/zh keys.
