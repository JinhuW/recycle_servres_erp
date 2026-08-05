# A bare `href="/path"` silently lands on the dashboard

**Symptom.** The Activity page's "Open record" button did nothing useful — it
navigated away and left you on the dashboard instead of the purchase order the
row described.

**Cause.** The SPA router is hash-based (`apps/frontend/src/lib/route.ts`): the
app's path is whatever follows `#`. The anchor was written as
`href={`/purchase-orders/${targetRef}`}` — a *real* navigation. The Worker
serves `index.html` for it, the fresh document has no hash, so `readPath()`
falls through to `'/'` and `pathToDesktopView` resolves that to `dashboard`.
Nothing errors; the record just never opens.

`navigate()` hides this distinction because it assigns
`window.location.hash` itself. Anchors don't go through `navigate()`, so they
have to spell the `#` out.

**Fix.** `activityRecordHref()` in `lib/route.ts` builds the href, `#` included,
and returns `null` when the event has no target so the button isn't rendered at
all. Covered in `apps/frontend/tests/route.test.ts`.

**Rule.** Any `<a>` pointing at an in-app route needs `#/…`, not `/…`. A
missing `#` is invisible in review and in typecheck — it fails only at click
time, and it fails quietly.
