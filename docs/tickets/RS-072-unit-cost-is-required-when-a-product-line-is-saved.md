---
id: RS-072
title: Unit cost is required when a product line is saved
type: story
status: in-progress
priority: P2
created: 2026-09-18
reporter: jinhu
branch: session/20260918-064949
pr:
version:
related: [RS-063, RS-068]
---

## Ask

> update the current check for the cost, It should check when user submit the product in the PO.

Clarified in the same session: the check is per product line, at the moment
the line is saved — not on the Submit Order button — and the leave-Draft
guard from RS-063 stays as the backstop.

## Context

RS-063 (v1.148.0) refuses to let a PO leave Draft while its goods total is
$0, and RS-068 (v1.149.4) limited that to a PO's first submission. Both line
forms already print a red asterisk on Unit cost — the desktop line drawer and
the phone's add-item form — but the shared line rule
(`apps/frontend/src/lib/lineRequirements.ts`) deliberately left the cost out,
so a $0 line saved on every screen and the purchaser only heard about it when
the hand-off refused the whole order.

Every screen that writes a PO line asks that one helper whether the line is
complete: the desktop Submit page (drawer Confirm, the auto-confirm when the
next line is added, the Submit Order blocker list), the desktop edit page
(Confirm, Save, the stage change), the phone add-item form and the phone's
draft sync. Adding the cost there is the whole change on the capture side.

The edit page needs one exemption. 514 of the 1,467 production lines sit at
`unit_cost` 0 (43 POs, plus 17 that carry a negotiated lot price over $0
lines), and Save there requires every line to pass the rule whenever a line
or the stage is edited. A blanket cost rule would lock all of those POs, so
the editor asks for a cost only on a line that is new or that the user has
touched — the same shape the serial rule already uses. A line left alone is
left alone.

The backend keeps accepting `unit_cost >= 0`: a server rule would refuse
every edit to those legacy lines. The per-order leave-Draft check remains the
server side of the rule.

## Acceptance criteria

- [x] Desktop Submit: confirming a line (drawer Confirm, or adding the next
      line) with a blank or $0 unit cost is refused with
      "Still needed: Unit cost".
- [x] Desktop Submit: Submit Order lists the missing cost in the Can't-submit
      dialog for an unconfirmed $0 line.
- [x] Phone add-item form: Save is refused the same way.
- [x] Phone draft sync (a resumed draft holding a $0 line) reports the cost
      instead of silently not syncing, and the review page's Submit refuses
      to ship that line until it has one.
- [x] Phone edit of an existing line (opened from the PO detail) needs a
      cost > 0 — the form opens the field blank for a legacy $0 line.
- [x] Desktop Edit: a new line, or an edited existing line, needs a cost > 0;
      an untouched legacy $0 line does not block Save or a stage change.
- [x] The leave-Draft cost guard and its dialog are unchanged.
- [x] `lineRequirements` unit tests cover blank / 0 / '0' / negative / typed,
      the opt-out, and key order.

## Out of scope

- A server-side `unit_cost > 0` rule — it would refuse edits to the 514
  production lines already at $0.
- Backfilling $0 lines already in production.
- `DesktopInventoryEdit` (edits received stock through `/api/inventory/:id`)
  — that is not a product being submitted into a PO.

## Notes

- Touching a legacy $0 line on the edit page for any reason (qty, status, a
  spec field) now asks for its cost before Save. That is intended — the line
  is being re-submitted — but it is the one place a user meets the rule on
  data they did not enter.
- The phone kept a `syncNeedCost` message that promised a cost-less line
  "will be sent when you submit". Deleted rather than left false.
