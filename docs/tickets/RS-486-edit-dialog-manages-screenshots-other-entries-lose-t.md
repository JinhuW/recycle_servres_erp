---
id: RS-486
title: Edit dialog manages screenshots; Other entries lose the deleted-record banner
type: bug
status: done
priority: P2
created: 2026-10-31
reporter: jinhu
branch: rs-485-acct-edit-screenshots
pr: 1034
version: 1.396.0
related: []
---

## Ask

> The edit page should also inlcude the screenshot edit.
>
> also what is mean of The record this entry was for has been deleted. The money stays in the book.

## Context

The accounting entry Edit dialog (desktop `EntryDialog.tsx`, mobile
`PhAccountingSheet.tsx`) hid the screenshot box whenever it edited an existing
entry. Screenshots could only be added or removed from the entry drawer.

The yellow banner "The record this entry was for has been deleted" is meant for
a Purchase / Commission / Sale / After-sales entry whose PO, SO or AS was
deleted: the entry stays in the ledger unlinked and its money still counts.
`useAccountingEntryForm` decided "orphan" as *no target and kind unchanged*,
but an Other entry never has a target, so every Other entry (AC-1066, a
September courier fee, in the report) showed it.

## Acceptance criteria

- [x] The desktop Edit dialog and the mobile edit sheet list the entry's screenshots; one can be added (drop, pick, or paste on desktop) or removed.
- [x] Screenshot changes save immediately, as in the drawer, and the drawer shows the new list.
- [x] An Other entry never shows the deleted-record banner.
- [x] A linked kind whose record was deleted still shows it.

## Out of scope

Deferring screenshot changes until Save changes: the drawer already saves them
live, and two behaviours for the same list would confuse.
