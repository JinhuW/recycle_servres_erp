---
id: RS-162
title: Desktop PO page: Save greys out when there is nothing to save
type: bug
status: done
priority: P2
created: 2026-10-04
reporter: jinhu
branch: fix/po-save-disabled-when-clean
pr: "#487"
version: 1.203.1
related: []
---

## Ask

> In the PO page, if nonthing can save, then it should gary out.
>
> if user already move the status here, then we don't need to click the save again

## Context

On the desktop PO page (`#/purchase-orders/PO-n`), the footer's **Save** was
disabled only while a save was in flight. On a clean page it stayed dark and
clickable, and the only result of a click was a *Can't save — No changes to
save.* dialog.

The case the requester hit is the stage move. The *Mark as In Transit*
checkpoint writes its own fields and advances in one call, then the page
remounts clean (`DesktopApp.tsx` keys it on `id:orderReloads`). Save still
looked like something was waiting, so it read as "click me to keep the move".

Save stays clickable while blockers exist on purpose, so a click can list
what is wrong (`saveBlockers` in `DesktopEditOrder.tsx`). That reasoning
holds for a real blocker, like an incomplete line or a bad tracking number.
It never held for "no changes", because there is nothing to fix.

The phone shell already hides Save on a clean page (`pages/OrderDetail.tsx`).

A clean page only greys Save if the page *is* clean on open. One compare
wasn't. `commissionDirty` compared the rate with an exact float `!==` after
a `toFixed(2)` percent round trip, and 2,760 of the 10,001 values the
`NUMERIC(5,4)` column can hold fail that (e.g. 0.0035). Those orders opened
dirty, and the checkpoint answered them with a false "save first".

## Acceptance criteria

- [x] On a clean desktop PO page, Save is disabled (greyed, `not-allowed`
      cursor), and hovering it shows *No changes to save.*
- [x] After *Mark as In Transit* → checkpoint → done, the page lands on In
      Transit with Save greyed, and it is still greyed after a reload.
- [x] Any edit, or a staged stage move (*Save · Mark as ‹stage›*), turns
      Save back on. Undoing the edit or the stage greys it again.
- [x] A dirty page with a blocker (incomplete new line, invalid tracking
      number) keeps Save clickable, and the click still opens the blocker
      dialog.
- [x] An order whose commission rate is not a whole hundredth of a percent
      (e.g. 0.35%) opens clean.

## Out of scope

Both of these were judged with the requester, who chose grey-out only:

- **Manager stage moves committing without Save.** In Transit → Reviewing
  and later moves stay staged until *Save · Mark as ‹stage›* commits them.
- **The checkpoint carrying unsaved page edits.** A dirty Draft still gets
  "save first" from *Mark as In Transit*.

Also out of scope:

- **The phone shell**, which already hides Save on a clean page.

## Notes

Plan: `~/.claude/plans/lively-cooking-hammock.md`.
