---
id: RS-154
title: "Frontend robustness: one layout per load, unsaved-edit guard, cross-tab refresh, shared PO permission and material rules"
type: bug
status: backlog
priority: P2
created: 2026-10-02
reporter: jinhu
branch: fix/frontend-robustness
pr:
version:
related: [RS-153, RS-148]
---

## Ask

> ultrathink all these remaing works, create an detailed implementation plan to achieve the remaining items.

This is Batch 8b of the approved plan,
`docs/superpowers/plans/2026-10-02-code-review-remaining-work.md`. It covers
review findings M30, M34, M35, M36 and M39, and closes the plan's batches.

## Context

- **M34:** `DesktopApp` set `loadingOrderId` while it fetched a deep-linked
  PO and never cleared it when the route left the order, or when a second
  order took over. The "Loading…" state could stick.
- **M35:** leaving an edit screen (Escape, Cancel, Back) dropped unsaved
  typing without asking, and a reload or tab close did too. `Modal` closed on
  any click whose target was the backdrop, so a text selection dragged out of
  the panel and released over the backdrop closed the dialog.
- **M36:** `App.tsx` re-chose the shell on every resize across 720px. Rotating
  a tablet or snapping a window unmounted the shell mid-edit and lost its
  state.
- **M30:** two tabs whose access token expired together each called
  `/api/auth/refresh` with the same refresh cookie. The second call presented
  a rotated token, which reads as reuse and revokes the whole family. Both
  tabs were then signed out.
- **M39:** the desktop PO editor and the phone PO detail each derived edit,
  annotate, reopen and delete rights from the same facts, line by line. The
  backend's "material edit" key list lived only in the PATCH route. The phone
  counted a commission change as material and the backend did not.

## Acceptance criteria

- [ ] `loadingOrderId` clears when the route leaves the order and when another
      order replaces it mid-fetch.
- [ ] `Modal` closes only when the press and the release both land on the
      backdrop.
- [ ] `useUnsavedGuard(dirty)` registers dirty screens. The browser asks
      before a reload or close. `confirmDiscard()` asks through a
      `ConfirmDialog` before Escape, Cancel or Back throws edits away on the
      desktop PO editor, the sell-order editor, the phone submit form and
      desktop submit.
- [ ] The shell is picked once per page load. When the viewport crosses 720px,
      a "Switch to phone/desktop layout" button appears. It asks before
      discarding unsaved edits.
- [ ] A refresh runs under a `navigator.locks` lock. A tab that sees another
      tab refreshed after its request began retries without refreshing.
      Covered by unit tests with mocked locks and storage.
- [ ] `@recycle-erp/shared` exports `MATERIAL_PATCH_KEYS` and
      `isMaterialPatch`, and the backend PATCH uses them. The phone no longer
      counts commission as material.
- [ ] `lib/poPermissions.ts` `derivePoPermissions` is the one place both PO
      shells read their rights from. Unit tests cover purchaser, manager,
      archived, closed-book and never-submitted cases.

## Out of scope

- Computing "material" in the shells from the built PATCH payload's keys. The
  shells keep their dirty flags. They warn before a save, while the backend
  decides from the keys it receives. The shared list makes drift visible
  without a rewrite of both editors.
- Auto-switching the layout on resize was declined in the plan's decisions.

## Notes

- `confirmDiscard()` resolves `true` straight away when nothing is dirty, so
  every leave path awaits it unconditionally.
- The layout-switch button sits at the top centre. At the bottom it covered the
  editor's Save button.
- `refreshNow` and `tryRefresh` take the request's start time. Without it, a
  tab cannot tell a refresh that happened after its 401 from one that happened
  before.
