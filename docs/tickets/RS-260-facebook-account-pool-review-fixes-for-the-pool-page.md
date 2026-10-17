---
id: RS-260
title: Facebook account pool: review fixes for the pool page
type: bug
status: in-progress
priority: P2
created: 2026-10-17
reporter: jinhu
branch: fix/fb-pool-review
pr:
version:
related: [RS-259]
---

## Ask

> /code-review high for the work that codex just commited.

> pls process with a fix.

## Context

v1.261.0 shipped the account pool page without a ticket. A high-effort
`/code-review` of that commit found ten issues; RS-259 (the backend store,
v1.262.0) rewrote the page's state handling in the meantime and removed four
of them on its own — the free-text holder that never matched a purchaser (the
API now resolves a holder by member name), the take that toasted success after
a refused take, the dead non-null fallback in `update()`, and the missing
ticket. This ticket carries the six that survive in the v1.262.0 code.

## Acceptance criteria

- [ ] `cookieUid` reads `c_user` from a header line with spaces around `;`
      and `=`, from a JSON list of `{name, value}` cookies and from a JSON
      object keyed by name; the backend's `cookie_uid` and the page's cookie
      check agree because both call it.
- [ ] A 2FA key may be pasted as an `otpauth://` link in the editor and in an
      import row; what is stored is the base32 secret, and a link without a
      `secret` is refused as an invalid key.
- [ ] A code column never reads "No 2FA key" for an account that has one: the
      previous code stays until the next is computed, and on a page without
      `crypto.subtle` the column shows a placeholder, the copy button explains,
      and nothing is copied in silence.
- [ ] One timer drives every live code on the page.
- [ ] The pool dialogs rely on the shared Modal's focus trap; the page-local
      `usePoolDialogFocus` is gone.
- [ ] The table's `#` header and the purchaser card's UID label go through
      `t()`.

## Out of scope

- A member picker for the holder field (the API resolves the name; a misspelt
  name still leaves `holderId` null).
- Re-rendering only the visible rows each second: the shared clock removes the
  N timers, each `PoolCode` still re-renders for its countdown.

## Notes

- Review findings and their status against v1.262.0 are in the first
  comment of the PR.
