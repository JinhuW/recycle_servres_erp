---
id: RS-040
title: Payment detail actions look like buttons
type: bug
status: in-review
priority: P2
created: 2026-09-12
reporter: Jinhu
branch: fix/payments-detail-actions
pr:
version: 1.138.1
related: [RS-020, RS-036]
---

## Ask

> refine this section. all button is plain text which is not UI UX friendly.
> help me polihs this UI in this section.

(With a screenshot of an expanded Payments row: a pending Mercury charge, then
"Group with…", "Mark as transfer", "Add to internal…", "Unassign" rendered as
bare text, then the note box and its Save note button.)

## Context

Clicking a row on the Payments page opens an expanded panel with the row's
legs, its settlement state, and every action a manager can take on it. All of
those actions were `btn sm ghost`, and a ghost button is transparent with a
transparent border. That is the right choice on the collapsed row's rail,
where the secondary buttons are hidden until hover and the row itself supplies
the context (v1.120.0). The expanded panel copied the class without the
reason: nothing there reveals on hover, the panel sits on the soft grey row
background, and six actions ended up reading as loose words with no
affordance at all.

## Acceptance criteria

- [ ] Every action in the expanded row (Group with…, Mark as transfer / Not a
      transfer, Unlink / Ungroup, Add to internal… / Internal transactions /
      Remove from record, Unassign) renders as an outlined button, the same
      `btn sm` the rest of the desktop uses.
- [ ] The actions sit in one bar under a hairline that separates them from
      the facts above, in two groups — what the money is, then which record
      or owner it belongs to — spaced apart, not labelled.
- [ ] Group with… and Add to internal… carry a chevron that turns while
      their picker is open.
- [ ] A row with nothing to offer (a failed or reversed charge with no PO)
      shows no bar and no hairline.
- [ ] Save note stays the only primary button in the panel.

## Out of scope

- The collapsed row's hover-revealed rail keeps its ghost buttons — that
  hiding is deliberate.
- `DesktopInternalTxns.tsx` has the same ghost-on-grey problem on the record
  page (Remove, Add transaction…, Delete record). Same fix, separate change.

## Notes

- Plan: `~/.claude/plans/cozy-swinging-bird.md` (plan-first, one reviewer).
- The grouping and the empty-bar case are pure CSS (`:empty`, `:has()`) so
  no JS boolean has to mirror the JSX's render conditions.
