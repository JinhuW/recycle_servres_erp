---
id: RS-089
title: Any manager reviews and moves a PO, whatever its warehouse
type: story
status: done
priority: P2
created: 2026-09-20
reporter: jinhu
branch: feat/rs-088-any-manager-reviews
pr: 383
version: 1.168.0
related: [RS-031, RS-032]
---

## Ask

> revert the feature and implement the following
> no matter which warehouse it is. All manager shuould review and move the PO.

"The feature" is RS-031.

## Context

RS-031 (v1.132.0, PR #285) made the moves into Reviewing and Ready to Pay —
and any stage-jump crossing them — the sole right of the manager linked to the
PO's warehouse (`warehouses.manager_user_id`, set in Settings → Warehouses).
`services/orderAdvance.ts` refused every other manager with a 403 naming who
could, and both PO pages locked the step and showed the same sentence.

Jinhu wants the pre-v1.132.0 rule back: every manager may take any PO through
every stage, regardless of warehouse. The Ready to Pay stage itself (RS-032,
shipped in the same PR) stays. The warehouse keeps its manager as a
contact/ownership fact in Settings; it just no longer gates stage moves.

## Acceptance criteria

- [x] `POST /api/orders/:id/advance` into Reviewing or Ready to Pay (and a
      stage-jump across either) succeeds for any manager, whether or not the
      PO's warehouse has a manager and whoever that is.
- [x] Desktop stepper and phone advance button no longer lock those steps for
      other managers; the "only {name} ({wh} manager) can move…" banner and
      tooltip are gone from both shells.
- [x] Purchasers unchanged: Draft → In Transit only.
- [x] Settings → Warehouses still shows and edits the warehouse manager.

## Out of scope

- Removing `warehouses.manager_user_id` or the Settings picker.
- Notifying anyone that a PO is waiting for review.

## Notes

- A pure deletion: no migration, no API shape change — only a 403 that no
  longer fires.
- The In Transit panel's hint ("When the box reaches {wh}, the warehouse
  manager checks it in…") was reworded to "a manager" in both locales — it
  described the gate as the process.
- Verified on the local stack with WH-LA1 assigned to Alex: Sofia took
  PO-1382 In Transit → Reviewing → Ready to Pay through the API, the desktop
  stepper offered Reviewing with no lock banner, and the phone page's
  *Advance to Reviewing* moved it.
- Plan: `~/.claude/plans/serene-snuggling-hollerith.md`.
