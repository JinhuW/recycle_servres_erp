---
id: RS-163
title: Pre-release review fixes for v1.203.0–v1.203.1
type: bug
status: done
priority: P1
created: 2026-10-04
reporter: jinhu
branch: fix/prerelease-review-v1-203
pr: "#488"
version: 1.203.2
related: [RS-160, RS-162]
---

## Ask

> /code-review high dev -> prod. deploy to prod after fixing all issue

## Context

`/code-review high` of `origin/main...origin/dev` covered two releases:
v1.203.0 (RS-160, a PO has a manager) and v1.203.1 (RS-162, the desktop PO
page's Save greys out when clean). It returned nine findings. Neither release
had reached main (still v1.202.1), so the fixes ship in the same release, as
v1.203.2.

Each finding was checked against `origin/dev`:

1. **The phone PO page compared the commission rate as raw floats.** The
   input is seeded through a `toFixed(2)` percent, and 0.35 / 100 is not
   0.0035. So a PO at 0.35 % opened with unsaved changes, every next-step asked
   to save first, and saving re-seeded the same string. A manager could not
   move that PO from the phone. v1.203.1 fixed the same compare on the desktop
   only.
2. **The hand-off never asks the takeover question.** *Judged, no change.*
   RS-160 put the hand-off out of scope on purpose: it is the purchaser's
   submission door, and the next manager move asks anyway. Reconfirmed with
   the requester on 2026-10-04.
3. **A manager was never re-checked against their current role.** A manager
   demoted to purchaser, or deactivated, stayed every PO's manager. Their name
   kept showing, every move asked about them, and no one was stamped
   automatically again.
4. **The takeover question came from the client's copy of the PO.** A list
   row or a PO page loaded before another manager took the PO into review
   showed no manager. It asked nothing and sent no `takeManager`. The server
   kept the other manager, and the mover never got the question.
5. **`manager_changed` and the move's `advanced` event shared the
   transaction's `NOW()`.** The timeline breaks that tie on a random UUID, so
   the two appeared in either order.
6. **The 0156 backfill read only moves into Reviewing.** Runtime also stamps
   on moves into Ready to Pay and Done. So a PO a manager jumped from In
   Transit straight past Reviewing started with no manager, and the next
   manager to touch it was stamped silently.
7. **Review mode asked the same question twice.** A manager who answered
   *Keep ‹X›* on *Move to Reviewing* was asked again on *Approve for payment*
   in the same visit.
8. **`setOrderManagerTx` ran an extra `SELECT name`** inside the row-locked
   transaction.
9. **The takeover answer was translated into `takeManager` at four call
   sites.** The phone also carried it in a boolean state that each close path
   had to clear.

## Acceptance criteria

- [x] The phone PO page opens clean for a PO at 0.35 %, 1.45 %, 0.55 % or
      0.07 %, and next-step moves it without "save first". Desktop and phone
      share one basis-point compare (`rateEq`).
- [x] A PO's manager counts only while that user is an active manager.
      Otherwise `GET /api/orders/:id` and `GET /api/orders` return
      `manager: null`, and the next manager move into Reviewing, Ready to Pay
      or Done stamps the mover with no question. The event names the old
      holder as `from`.
- [x] `/advance` accepts `fromManagerId` (string or null). From a manager, a
      value that differs from the PO's manager (read under the row lock) is
      refused with 409 `{ code: 'managerChanged', manager }`. Nothing is moved
      or written. A purchaser's value is ignored.
- [x] Every client door sends the manager it showed. On `managerChanged` it
      asks again about the manager the server named, then moves. Cancelling
      that question moves nothing.
- [x] `manager_changed` always sorts after the `advanced`/`submitted` event of
      the same move.
- [x] Migration 0158 fills a PO still without a manager from the latest move
      into Reviewing, Ready to Pay or Done made by a user who is still an active
      manager.
- [x] In one review-mode visit, *Keep ‹X›* on the way in carries to Approve,
      even after a line edit reloads the page. It only carries while X is
      still the manager.

## Out of scope

- The hand-off asking the takeover question (#2, see above).
- 0158 takes the *latest* managed move, like 0156. Runtime keeps the *first*
  manager, because the column is sticky. The history doesn't say which
  manager a stamped-then-taken-over PO ended with any better than this.

## Notes

Plan: `~/.claude/plans/mossy-brewing-gosling.md`.
