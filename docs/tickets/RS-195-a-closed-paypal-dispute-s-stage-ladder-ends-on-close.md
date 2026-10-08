---
id: RS-195
title: A closed PayPal dispute's stage ladder ends on Closed
type: bug
status: done
priority: P2
created: 2026-10-08
reporter: jinhu
branch: fix/dispute-ladder-closed
pr: "#538"
version: 1.221.2
related: [RS-018]
---

## Ask

> The case already close, But the progress bar has never changed.

(With a screenshot of Payments: PP-R-RLB-646159686 expanded, chip *Resolved*,
outcome *Refunded to us · $140.00*, and the stage ladder still on **Claim**.)

## Context

The expanded row of a disputed payment draws PayPal's stage ladder —
Inquiry → Claim → Pre-arbitration → Arbitration — since RS-018 (v1.124.0).
`DisputeDetail` in `pages/desktop/DesktopPayments.tsx` built it from
`lifeCycleStage` alone and highlighted that stage as the active step.

PayPal leaves `dispute_life_cycle_stage` wherever the case was decided. On
2026-10-08 prod held nine cases on `bank_transactions.dispute`; the seven
resolved ones all read `status: RESOLVED`, `lifeCycleStage: CHARGEBACK`, with
an outcome code. So the sync was right and the data fresh — but every closed
case kept **Claim** highlighted with two stages still ahead of it, because the
ladder had no closed state to move to. It read as a case still in play.

Chosen look (asked during planning, "All four + Closed"):

```
(1 Inquiry)──(2 Claim)┄┄(3 Pre-arb)┄┄(4 Arbitration)──[✓ Closed]
  grey         grey      dimmed       dimmed            highlighted
```

## Acceptance criteria

- [x] A resolved case's ladder ends on a highlighted **✓ Closed** step.
- [x] The stages it went through (up to `lifeCycleStage`) are grey, with solid
      bars between them.
- [x] Stages after `lifeCycleStage` are dimmed, with dashed bars into them; the
      bar into Closed is solid.
- [x] An open case renders as before: four steps, the current one active.
- [x] An unknown or null stage still hides the ladder.
- [x] Translated in en and zh.

## Out of scope

- The backend and the sync — they already store the right status.
- A Closed step on open cases.
- Colouring the Closed step by outcome; the outcome line under the timeline
  already says who won.
- Whether Inquiry should read as reached when a case opened straight as a
  claim.

## Notes

- Plan: `~/.claude/plans/wild-cooking-hollerith.md`.
- The ladder logic moved to a pure helper, `lib/disputeLadder.ts`, so it is
  tested without importing the Payments page.
- The dashed bar is a `repeating-linear-gradient`, not `border-top: dashed`:
  on `.so-step-bar`'s rounded 2px box, Chromium painted the dashed border as a
  solid line even though the computed style said `dashed`.
- Verified on a local stack (alex, 1440px and 760px, en and zh) with an open
  and a resolved case written onto two local PayPal rows, then set back to
  NULL. At 760px the card is as wide as the transactions table, which already
  runs past the window; the five steps need ~550px of it.
