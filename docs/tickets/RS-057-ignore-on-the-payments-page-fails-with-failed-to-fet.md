---
id: RS-057
title: Ignore on the Payments page fails with Failed to fetch
type: bug
status: in-progress
priority: P1
created: 2026-09-16
reporter: jinhu
branch: fix/payments-rail-window-stop
pr:
version:
related: [RS-053]
---

## Ask

> debug and fix thsi error while i am trying to ignore an payment activity:

(With a screenshot of the desktop error dialog: "Something went wrong — Failed
to fetch".) Follow-ups in the same session: "i think you should check the
railway log", a DevTools screenshot of the request — `POST
/api/bank-transactions/a4a22b5f-…/ignore` with no status code and no remote
address — and "also check if that commit may break other workflows".

## Context

The request never left the browser. Its resource-timing entry showed a 1 ms
duration, `responseStatus 0` and no protocol; the Cloudflare Worker tail and
the Railway edge log had no record of it, while the same request issued from
the page's console returned 200. The Chrome extension's network log reported
`503` for it, which was wrong and cost twenty minutes.

Commit `04d0a68` (RS-053, v1.144.0) replaced two `onClick={(e) => { stop(e);
navigate(…) }}` buttons in `PaymentTr` (`DesktopPayments.tsx`) with `RouteLink`
and deleted the now-unused-looking helper `const stop = (e) =>
e.stopPropagation()`. It was not unused: the action rail still had
`onClick={stop}`. With no local `stop` in scope the bare name resolves to the
DOM global `window.stop()` — lib.dom declares it as `() => void`, which is a
valid `MouseEventHandler`, so `tsc` stayed green. Every click on the rail then
ran the button's handler (fetch starts), bubbled to the span, and
`window.stop()` cancelled every in-flight request in the document:
`TypeError: Failed to fetch`. Ignore, Unignore, Not the same and Group all
died this way; Link survived only because it opens a picker before it POSTs.
And because `window.stop()` does not stop propagation, the click went on to
the row's `onToggle`, so every rail click also expanded or collapsed the row.

Shipped to prod in v1.144.0 (#333). The fix restores the helper under a name
that is not a `window` global (`stopClick`), so the next time someone deletes
it the file fails to compile instead of the page failing silently. The same
rename is applied to the two other files that carried a `stop` helper
(`DesktopShipping.tsx`, `Shipping.tsx`) so the trap has no surviving instance.

The row from the report (`a4a22b5f`, Mercury −$0.56, Ship Saving) was ignored
during the diagnosis by a page-console request; nothing to redo.

## Acceptance criteria

- [x] Ignore, Unignore, Not the same and Group on the desktop Payments rail
      complete with 200 and the row leaves the list; the row does not toggle
      open on a rail click.
- [x] `grep -rn "onClick={stop}" apps/frontend/src` is empty, and no
      `stopPropagation` helper in the frontend is named after a `window`
      function, so deleting one again is a TS2304 compile error.
- [x] Frontend typecheck and test suite green.

## Out of scope

- `handleFetchError` (`lib/errorToast.ts`) reports a raw `TypeError` with no
  path or method, which is why the client-error telemetry could not name the
  request that died. Attaching the path/method to fetch rejections in
  `lib/api.ts` would make this class of bug a two-minute diagnosis. Separate
  ticket.
- A lint rule (`no-restricted-globals`) is the proper scanner for bare DOM
  globals used as handlers; the frontend has no ESLint, so that is its own
  change.
- Three behaviour changes in the same RS-053 commit that are deliberate but
  worth a product decision, reported and not touched here: the "likely PO"
  chip on an Unlinked payment row now navigates to the PO instead of expanding
  the row where Link lives (`DesktopPayments.tsx:906`); order and sell-order
  ids inside the PO and inventory edit forms are now one-click exits with no
  unsaved-changes guard (`DesktopInventoryEdit.tsx`, `DesktopEditOrder.tsx`
  archive-conflict list); sidebar, phone tab bar and Analysis tabs went from
  `<button>` to `<a>` and no longer activate on Space (Enter still works).

## Notes

- Debug note: `docs/debug-notes/2026-09-16-bare-stop-handler-aborts-every-request.md`.
- An audit of the full `04d0a68` diff found no other removed declaration that
  shadows a `window` global; every other removed name (`setView`, `onEdit`,
  `navigate` imports) would have failed `tsc` if still referenced.
