---
id: RS-257
title: Type the count in Review mode
type: story
status: done
priority: P2
created: 2026-10-16
reporter: jinhu
branch: feat/review-count-input
pr: 658
version: 1.260.0
related: []
---

## Ask

> enable this editable instead of just use  - / +

(With a screenshot of Review mode on PO-1491, the `67` in a row's
`− 67 / 67 +` Counted cell circled.)

> both of them should work instead of replacing

## Context

Each row of desktop Review mode (`pages/desktop/DesktopBoxCheck.tsx`) shows its
count as `− n / qty +`. The number was plain text, so recording a short box
took one click of − per missing unit: 27 clicks to take a 67-stick line down
to 40.

Every count change already goes through one setter, `setCount`. It clamps to
`0..qty`, ignores an unchanged value, and takes the line's tick away when the
count drops below qty (v1.190.0). A typed count goes through the same setter,
so the rules − meets apply unchanged. No backend change.

## Acceptance criteria

- [x] The count in each Review mode row is a text field. Clicking it selects
      the number, so typing replaces it.
- [x] Enter, or leaving the field, saves the typed count. Escape puts the old
      count back and leaves the field without leaving Review mode.
- [x] A typed count above qty saves as qty. An empty field saves nothing.
- [x] Typing a count below qty takes the line's tick away, exactly as − does.
- [x] Digits typed in the field never start a scan or fire a shortcut. After
      Enter, ↑↓ / Space / + − work again.
- [x] A scan while the count field has focus goes to the scan box, not into
      the count.
- [x] Switching to another window mid-edit saves nothing, and the typed text
      is still there on return.
- [x] The field is disabled wherever − / + are: count not loaded, PO
      archived, line held for a shipped sell order, line at qty 0. It keeps the
      row's amber / red / green colour.
- [x] The − / + buttons and the + − keys stay and still step the count by
      one. Typing and stepping work on the same number, in any order.

## Out of scope

- Pack mode's stepper (`DesktopSellOrderPack.tsx`, the same `− n / qty +`
  cell). It wasn't asked for, and the same field could follow there.
- Phone: Review mode is desktop only.
- Saving on every keystroke. It would store the `6` of a `67` and take the
  tick away on the way.

## Notes

- The count saves on Enter or blur only, through the existing `setCount`. A
  window blur (the field is still the active element) is not a leave.
- Inside the field, + / = / − step the typed number between 0 and qty
  instead of starting a scan, so the page's count keys keep their meaning;
  Enter saves it. Found while checking the diff, after the plan.
- Any other printable non-digit key in the field is read as a scanner. It goes to the
  scan box with any digits typed before it, and no count is saved. A label
  made only of digits would still read as a count. Part labels carry letters,
  so that case is accepted.
- Plan: `~/.claude/plans/bubbly-bubbling-popcorn.md`.
