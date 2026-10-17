---
id: RS-282
title: Click a pool table cell to copy it; edit icon opens the editor
type: story
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/fleet-click-to-copy
pr: 706
version: 1.279.0
related: []
---

## Ask

> all information here, when i click it. it shoudl copy them.
>
> add an edit icon on it to allow me edit it

(Said over a screenshot of the manager's Facebook account pool table.)

## Context

In the manager's pool table (`pages/desktop/FacebookAccountPool.tsx`) a click
anywhere on a row opened the account editor, and a click on a masked password
only revealed it. Getting a login out meant opening the editor or selecting
text by hand. The purchaser's own-account cards already had per-field copy
buttons through the page's `copy()`; the manager's table had none.

## Acceptance criteria

- [x] Clicking UID, Password, 2FA code, Email, Email password, Recovery email,
      Cookie or Notes copies that value and toasts "<field> copied".
- [x] Password / email password copy without being revealed; an eye icon
      beside them still reveals.
- [x] 2FA copies the current code (`poolTotp`), not the key.
- [x] Copying a secret field (password, totp, emailPassword, cookie) still
      writes the `copied` audit line.
- [x] A row click no longer opens the editor; a pencil icon at the end of each
      row does.
- [x] Empty values show `—` and are not clickable.

## Out of scope

The purchaser's own-account cards (they already have copy buttons). Status and
holder cells: nothing useful to copy, and the holder keeps its worker link.
