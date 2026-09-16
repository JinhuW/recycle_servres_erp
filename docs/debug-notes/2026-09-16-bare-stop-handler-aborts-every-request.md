# A bare `onClick={stop}` is `window.stop()`, and it aborts every in-flight request

**2026-09-16.** "Failed to fetch" on Ignore in the desktop Payments rail, every
time, on prod. The backend log had no record of the request, the telemetry
record said only `failureKind: fetch` with no path, and the browser's DevTools
showed the POST with no status code and no remote address. Two false leads
took the first half hour; the real signal took one call.

## The trap

`PaymentTr` in `DesktopPayments.tsx` had a local helper

```ts
const stop = (e: React.MouseEvent) => e.stopPropagation();
```

used by two navigate buttons and by the action rail, `<span className="pay-rail"
onClick={stop}>`. RS-053 (`04d0a68`, v1.144.0) turned the two buttons into
`RouteLink`s and deleted the helper as unused. The rail kept `onClick={stop}`.

Nothing failed: `lib.dom` declares `function stop(): void` on `window`, a
zero-argument function is a valid `MouseEventHandler`, and `tsc`, the test
suite and code review all passed. At runtime every rail click ran the button's
handler (the POST starts), bubbled to the span, and `window.stop()` cancelled
every request the document had in flight, including the one just issued. The
click then continued to the `<tr>` — `window.stop()` does not stop propagation
— and toggled the row open, which is why a `/suggestions` GET sat next to every
failure in the logs.

The same holds for any `window` method whose signature fits a handler:
`close`, `print`, `focus`, `blur`, `alert`, `postMessage`. `confirm`, `open`,
`fetch`, `scroll*` do not fit and would have failed to compile.

**Fix and guard:** the helper is back as `stopClick`, in every file that had
one (`DesktopPayments`, `DesktopShipping`, `Shipping`). A name that is not a
global turns the next accidental deletion into a TS2304 error instead of a
silent production bug. A lint rule (`no-restricted-globals`) would be the
proper scanner; the frontend has no ESLint yet.

## How to tell "killed in the browser" from "never answered" in one call

```js
performance.getEntriesByType('resource')
  .filter(e => e.name.includes('/api/'))
  .map(e => ({ name: e.name, dur: e.duration, status: e.responseStatus,
               proto: e.nextHopProtocol, bytes: e.transferSize }))
```

The failed POST read `dur: 1, status: 0, proto: "", bytes: 0` — no connection
was ever opened. A request the edge or origin refused shows a protocol and a
status; a request that hung shows a long duration. That single entry ruled out
Cloudflare, Railway, CSP, extensions and the service worker at once, and the
same request re-issued from the page console (which is not inside a click
handler, so nothing calls `window.stop()` after it) returned 200 and pointed
straight at the click path.

## False leads worth not repeating

- **"Not in the Railway log, so it never arrived" is right but not enough.**
  The Worker tail and Railway's edge HTTP log both lacked the request, which
  proves the browser never sent it — it does not say why. The resource-timing
  entry does.
- **The Chrome extension's network log reported `503` for the request.** There
  was no 503; nothing was ever on the wire. Treat that tool's status for a
  failed request as unreliable and read `performance` entries instead.
- **Telemetry could not name the request.** `handleFetchError` reports path
  and method only for `ApiError`; a raw `TypeError` from `fetch()` carries
  neither, so the `client-errors` record said "Failed to fetch" and nothing
  else. Attaching the path to fetch rejections in `lib/api.ts` is the
  follow-up (RS-057, out of scope).
- **The Chrome shell decision is made at load.** Resizing the window to
  desktop width does nothing until the page is reloaded; a fresh tab in a
  narrow window renders the phone shell, which has no Payments page at all.
