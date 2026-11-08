---
id: RS-570
title: Jump from the duplicate-part dialog to the product to update its quantity
type: story
status: done
priority: P2
created: 2026-11-07
reporter: jinhu
branch: JinhuW/po-duplicate-item-jump
pr: 1169
version: 1.446.0
related: []
---

## Ask

> when user submit an PO and a duplicated item detected, Give user an option in the dialog that jump to that iteam detail page to update the quantity.

## Context

A PO with two products that share a Part # doesn't reach the server straight
away. The desktop pages first stop on the duplicate-part dialog
(`apps/frontend/src/pages/desktop/submit/DupPartDialog.tsx`), which lists each
repeated Part # with the products that carry it ("Part X — #1, #2"). It offers
two ways out: *Review products*, which closes it, and *Submit anyway* /
*Save anyway*. Two pages raise it: `DesktopSubmit.tsx`, the new-PO page
("Submit anyway"), and `DesktopEditOrder.tsx`, an existing PO ("Save anyway").

The usual cause is a module scanned or pasted twice. Today the fix means
closing the dialog, finding the first product in the table, opening its
drawer, finding Qty and adding the units, then removing the copy.

`findDuplicatePartNumbers` (`submit/line.ts`) collects each group's places in
list order, so the group's first entry is the product the later rows repeat.
The product detail is the `LineDrawer` a row click opens. When it holds a
duplicate, it already says "This Part # is already on #2", which points the
user at the copy to remove.

**A bug the jump runs into.** On the new-PO page, an edit to a product that is
already saved was never written. The drawer let you change it, but its Confirm
is disabled once the product is saved, and Submit sent only the products not
saved yet (`doSubmit`: `filter(l => !l._confirmed)`). Adding the next product
saves the one before it, so by the time Submit raises the dialog, the product
it points at is nearly always saved. Without a fix, the jump would lead
straight to a quantity change that was silently dropped. It was found by
checking the database row after a verify run: the screen said 6, the row said
4. The edit page and "add to an existing draft" were never affected, because
the former sends its `_dirty` lines and the latter sends every product from
the screen.

## Acceptance criteria

- [x] On the new-PO page, the duplicate-part dialog shows one button per
      repeated Part #: "Open {first product} to update quantity".
- [x] Clicking it closes the dialog and doesn't submit. It opens that product's
      drawer with Qty focused and its value selected.
- [x] It also works when that product's drawer was already the open one.
- [x] The existing PO's edit page has the same button. It does what *Review
      products* does there, which includes taking back a pending status move,
      and then opens the product.
- [x] *Submit anyway*, *Save anyway* and *Review products* behave as before.
- [x] The button has English and Chinese copy.
- [x] On the new-PO page, an edit to a product that is already saved is written
      when the PO is submitted. Until then its row reads "Not saved", and a
      reload warns before dropping it.

## Out of scope

- Automatic merging, where the quantities are added up and the copy is deleted
  for the user. The ask is to take the user to the product. The user still
  decides which row survives.
- Comparing against products on *other* POs or in inventory. The dialog only
  compares the products on this PO.
- The phone's capture flow, which has no such dialog. It only shows a toast at
  scan time.
- Re-enabling the drawer's Confirm for an edited saved product, so the edit
  could be written before Submit. Submit writes it either way, which is the
  path every user takes.

## Notes

- The button opens the group's **first** product, the one already on the PO.
  With three or more repeats it still opens only the first. That drawer's
  duplicate banner names the others to remove.
- Qty gets focus through an id on the input (`lineQtyInputId`) and a
  `requestAnimationFrame` focus (`focusLineQty`). This is the same pattern the
  edit page uses after a tab switch. It runs after `Modal`'s cleanup has handed
  focus back to the opener, and it works whether the drawer mounts fresh or was
  already open.
- On the edit page, the first product can be read-only, for example when it is
  held for a shipped sell order. Its Qty sits in a disabled fieldset, so the
  focus quietly does nothing, and the drawer says why the product is locked.
- The fix for saved-product edits: `_dirty` moved from `EditLine` to `Line`.
  `applyLinePatch` sets it when a saved product's field changes. It reads
  "saved" off the line *before* the patch, because the save's own patch sets
  the `#`. `savedLineEdits` turns those products into the edit page's own
  `editLineToPatch` shape, and Submit's PATCH carries them as `lines`.
- Verified on a throwaway database, because the shared local one was behind
  `dev`'s migrations. Debug note:
  `docs/debug-notes/2026-11-07-new-po-submit-dropped-saved-product-edits.md`.
- Filed as RS-569, renumbered to RS-570 after another session took RS-569 the
  same day.
