---
id: RS-156
title: Pre-release review fixes for v1.200.1
type: bug
status: in-progress
priority: P2
created: 2026-10-02
reporter: jinhu
branch: fix/prerelease-review-v1-200
pr:
version:
related: [RS-154, RS-155]
---

## Ask

> /code-review high dev->prod.  fix all issue and release.

## Context

A `/code-review high` of `origin/main...origin/dev` (v1.194.2 → v1.200.1) returned
10 findings. By the time it finished, another session had already released v1.200.1
to prod (#475, 15:16 UTC on 2026-10-02). So these defects are live, and the fix goes
out as v1.200.2.

Each finding was checked against `origin/dev` at v1.200.1:

1. **Anonymous intake photos at or under the byte cap were never checked.**
   `shrinkImageToFit` returned early on size, before the strict check. A small file that
   wasn't an image at all was stored in R2 as sent, even though FEATURES.md says such a
   photo is refused.
2. **`seed.mjs` would wipe a production database on the compose host.** The guard
   counts the compose service host `postgres` as local. That host is the real database
   on a self-hosted prod stack, and `seed.mjs`, unlike `migrate.mjs --reset`, had no
   `NODE_ENV` check.
3. **A declined browser Forward or typed address left the refused page behind the
   current one.** The undo pushed a copy of the page after the refused entry. A later
   in-app Back then landed on that page without asking, and any edits made since were
   lost.
4. **The PO list cast the cursor's value without checking it.** A crafted cursor gave
   an unhandled 500 and a line in the error sink. Every other list falls back to page
   one.
5. **PO PATCH checked committed sell-order claims on line ids from other POs.** A
   stray id gave a 409 that named another PO's sell order, where elsewhere an unknown
   id does nothing.
6. **Graceful shutdown depends on Railway's draining window.** This is already done in
   ops: the backend has `drainingSeconds = 30` on prod and dev, which was checked
   read-only. Only the comment needed it.
7. **The hand-off locked the order `FOR UPDATE`.** Every other non-deleting order lock
   is `FOR NO KEY UPDATE`, so the hand-off blocked FK inserts under the order.
8. **The phone shell's `setView` navigated without asking.** This can't happen today:
   its only caller is the dashboard, where no editor is mounted. It is hardened anyway.
9. **The intake's daily byte budget mixed units.** It added raw photo sizes to stored,
   already shrunk sizes, so it refused submissions near the cap that would have fit.
10. **`uniqueWindowPairs` copied each bucket on every insert.** Prod has about 633 bank
    rows, so the cost is small.

## Acceptance criteria

- [ ] An anonymous intake photo under the byte cap whose header can't be read, or
      whose pixel count is past the cap, is refused (400). A small valid photo is
      stored unchanged.
- [ ] `seed.mjs` and `migrate.mjs --reset` refuse to run with `NODE_ENV=production`,
      whatever the host, unless the named override is set.
- [ ] After a declined Forward or typed address, the page's real predecessor is one
      Back away, and the refused page is one Forward away. The same holds for a
      multi-step Forward.
- [ ] `GET /api/orders` with a malformed cursor answers 200 with page one, for each
      sort column.
- [ ] A PO PATCH that names another PO's line id with a low qty is a no-op for that
      line, not a 409.
- [ ] The shutdown comment and CLAUDE.md state the 30s draining window.
- [ ] The hand-off locks the order `FOR NO KEY UPDATE`.
- [ ] The phone shell's `setView` asks before leaving unsaved edits.
- [ ] The daily byte budget counts each incoming photo at most at the upload cap,
      which is the most that can be stored for it.
- [ ] `uniqueWindowPairs` builds its buckets in linear time, with the same pairs as
      before.

## Out of scope

- A sorted-sweep rewrite of `uniqueWindowPairs`. Prod volume doesn't need it.
- Calendar-checking the cursor timestamp. `CURSOR_TS_RE` accepts `2026-13-45…`, and
  every list shares that regex.

## Notes

- Plan: `~/.claude/plans/zesty-growing-barto.md`, reviewed by a subagent before
  approval.
- **#3 design:** each history entry the app shows or leaves carries an `erpSeq`,
  assigned in creation order. A landed entry with a lower seq is a Back, which is
  undone by pushing the shown entry back, as before. Anything else, including an
  unstamped entry the browser just added, is a Forward or a new entry. It is undone by
  stepping `history.back()` until the shown entry is current again. That keeps the
  refused page ahead of the current one, not behind it.
