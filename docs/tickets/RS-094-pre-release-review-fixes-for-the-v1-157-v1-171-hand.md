---
id: RS-094
title: Pre-release review fixes for the v1.157–v1.171 hand-off, package and Sold changes
type: bug
status: done
priority: P1
created: 2026-09-21
reporter: jinhu
branch: fix/prerelease-review-2026-09-21
pr: https://github.com/JinhuW/recycle_servres_erp/pull/388
version: 1.171.1
related: [RS-080, RS-083, RS-085, RS-089, RS-090]
---

## Ask

> /code-review max the chnage from dev to prod/main.

then, once the review had reported:

> Fix all issue once you find any bugs and release to prod if there is no decision need from me.

## Context

`dev` was 19 commits ahead of `main` (v1.157.0 → v1.171.0: the RS-080 status
spine, RS-083 phone folds, RS-084/085/086 commission and Sold, RS-088–093). A
max-effort review of that diff returned fifteen verified correctness defects
and a handful of low ones. None had been seen by a user yet — this is the
pre-release sweep — so the fix ships to `dev` first and then the whole span
goes to `main`.

What the review found (file → defect):

| # | Where | Defect |
|---|---|---|
| 1 | `HandoffDialog.tsx` HandoffSection | A section folds the instant its rule is met, so typing in it is cut off: the PayPal id field vanishes after the first character, a FedEx-15 folds at 12 digits and Confirm sends the prefix. |
| 2 | `orderHandoff.ts` handoffOrderTx | A hand-off that flips a company/PayPal Draft to Self or Cash keeps the saved `paypal_txn_id` and links the company payment to a self-paid PO. |
| 3 | `orderHandoff.ts` setOrderPackageTx | A number already on another member's standalone box is adopted onto the caller's PO with no ownership check. |
| 4 | `orderHandoff.ts` unlink / in-place rewrite | A box Shippo already marked delivered is unlinked on a label→pickup flip (re-enters "Needs you", create-po mints a duplicate PO) or rewritten to `purchased` on a re-typed number. |
| 5 | `handoff.ts` / `orderTxnRule.ts` | A NULL-warehouse Draft (routine since the RS-090 Review screen POSTs lines only) passes every readiness rule and dead-ends on Confirm with a raw 400; an API body omitting `warehouseId` hands it off with no warehouse. |
| 6 | `OrderDetail.tsx` Submit | No save-first gate on the phone; the sheet seeds delivery facts from the saved order, so unsaved fold edits are re-asked or silently replaced. |
| 7 | `OrderDetail.tsx` serverVersion | A typed-but-unsaved note or fee is discarded after the hand-off or commission sheet refetches. |
| 8 | `useHandoffForm.ts` | The checkpoint judges the cost rule from the page-load `order` prop, so a $0 Draft priced through the drawer's Confirm line shows Products "!" with Confirm disabled. |
| 9 | `DesktopEditOrder.tsx` / phone save | A tracking number with no resolved carrier marks the page dirty, Save returns 200 and the number is silently lost. |
| 10 | `poReadiness.ts` consumers | A screenshot upload or drawer Confirm line neither dirties the section nor refetches, so the readiness row keeps saying the thing is missing. |
| 11 | `OrderDetail.tsx` readiness | The phone rebuilds payment rows from four fixed keys and never renders the server's `unknownTxnId`. |
| 12 | `StagePanel.tsx` | Done note/files render only at Done/Sold, so a reopened PO's evidence is unreachable and un-removable on the desktop. |
| 13 | `useHandoffForm.ts` / `orderHandoff.ts` | A deactivated saved collector folds the Delivery section to ✓ and Confirm 400s; an empty API body accepts the stale id. |
| 14 | `DesktopEditOrder.tsx` onDone | `void onReload()` after the hand-off swallows a failed re-read. |
| 15 | `orderDraft.ts` | create-po links the box but never writes `handoff_method='label'`, so the new PO reports `missingDelivery` and asks for the number it already carries. |
| low | various | adoption under a new carrier never re-registers with Shippo; local readiness accepts pickup with no collector; an empty Draft reads "needs a cost"; `FIELD_LABEL` lacks tracking/carrier; commission-rate input not locked on a closed book; `PhCommissionFields` duplicate ids; stage look-back reports a backward move as the stage's closing fact; raw-English activity-log labels; a stale comment in `inventory.ts`; the `scan` banner during a new-Worker/old-Railway window. |

## Acceptance criteria

- [x] A checkpoint section that was ever unmet stays open while the dialog is up; only a met one folds and opens on *Change*.
- [x] Handing off as Self or Cash writes `paypal_txn_id = NULL` and links no bank transaction; a PATCH that sends `payment: 'self'` or `paymentMethod: 'cash'` clears it the same way (a notes-only PATCH does not touch it).
- [x] A standalone box created by another purchaser is refused with a message that names the Shipping page, not adopted; one created by the actor, the PO's owner, nobody, or adopted by a manager still links; adoption under a different carrier re-registers.
- [x] A PO whose linked box is `delivered` refuses a flip away from label and a re-typed number with a 409 on both PATCH and the hand-off; the package row is untouched.
- [x] GET lists `missingWarehouse` for a NULL-warehouse Draft; `/advance` and `/handoff` refuse on it for every actor; the checkpoint and both PO pages show "Pick the receiving warehouse" with a placeholder option instead of borrowing the first warehouse's name.
- [x] The phone refuses to open the hand-off or commission sheet, or to advance, while the page holds unsaved edits (the desktop's existing rule).
- [x] A tracking number without a resolved carrier blocks Save on both shells with "Pick the carrier" (or the invalid-number hint).
- [x] The checkpoint's Products row reads the page's live lines; a screenshot upload or Confirm line flips the readiness row without a reload; an empty Draft says it needs products.
- [x] The phone renders `poTxnUnknown` as an unmet payment row.
- [x] Done evidence renders on the desktop at Reviewing and Ready to Pay too.
- [x] A deactivated saved collector is cleared client-side (the section opens with the picker) and server-side (`/handoff {}` refuses with `missingDelivery`).
- [x] A failed reload after the hand-off surfaces an error dialog.
- [x] create-po writes `handoff_method='label'`; the new PO's blockers hold neither `missingDelivery` nor `missingTracking`.
- [x] The low items above are fixed; frontend and backend suites green; typecheck clean.

## Out of scope

The review's cleanup-only findings (orphan i18n keys, blocker kinds not shared
via `packages/shared`, OrderActivityLog formatting while hidden, per-remount
fetches on the phone products screen, `PackageJourney` cross-shell import, the
`realized` column absent from a manager's persisted column list) — quality,
not defects; a later `/simplify`. The desktop manager's Draft→Reviewing
shortcut going through the checkpoint is deliberate (RS-089). The old-SPA-tab
vs new-backend `Sold` window during the release is transient and handled by
deploy order, not code.

## Notes

Plan: `~/.claude/plans/glowing-napping-milner.md` (reviewed by a Plan subagent;
its changes: transition-gated PATCH clearing, the open-latch on the section,
a wider adoption allow-set, `missingWarehouse` enforced everywhere).
`missingWarehouse` is in `ENFORCED_EVERYWHERE` on purpose: with the Reviewing
warehouse gate gone (RS-089) nothing else stops a PO with no warehouse from
becoming stock with no location.
