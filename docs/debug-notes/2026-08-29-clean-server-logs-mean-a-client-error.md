# Clean server logs + a user seeing an error = look in the browser

**2026-08-29.** "Something went wrong" on the Activity page, only after
scrolling a while. Railway was searched first and found *nothing*: 2,000 prod
deploy-log lines with zero 5xx, zero stack traces, zero `app.onError` records.
Every `/api/activity` call — bare, `?cursor=`, `?area=`, `?action=` — answered
200 in 13–47 ms. 800 events were scrolled on prod without reproducing it.

The clean logs were the answer, not a dead end. **Nothing in this stack recorded
browser-side failures**, so a fetch that never resolved, a response the SPA
couldn't parse, or a render crash left no trace anywhere — while the user stared
at a dialog. Both halves looked healthy because only one half was ever observed.

## Traps, in the order they cost time

**The two error screens are different screens.** `errDialogTitle`
("Something went wrong", `lib/i18n.tsx`) is the *fetch-failure dialog*.
`errBoundaryTitle` ("This page stopped responding", `ErrorBoundary.tsx`) is the
*render-crash fallback*. Which one a user names tells you whether a request
failed or a component threw. Don't hunt a render crash when they quote the
dialog.

**"No body text, just the title" was a real clue.** The dialog renders
`err.message` as its body under that hardcoded title, so a throw carrying no
message fell back to "Something went wrong. Please try again." — the headline,
twice. Fixed in `errorToast.ts`; the body now prefers anything actually known.

**`ERROR_LOG_DIR` is unset on Railway.** `docker-compose.yml` sets it, Railway
does not, so `appendErrorRecord` is skipped entirely there and `errors.jsonl`
does not exist in prod or dev. Only `console.error` reaches `railway logs`.
Anything that must be greppable in prod has to go to stdout — the JSONL sink is
a Docker-deployment bonus, not the primary path.

**`X-Request-Id` was already there and unused.** `index.ts` has set it on every
response and CORS-exposed it since the beginning, with a comment saying it's
"so clients can surface it in bug reports". No client read it. It now rides on
`ApiError` and into the dialog, and joins a user's screenshot to a server log
line.

**Railway's request id is not the app's.** The HTTP log shows 22-char base64url
ids (`6NX5iqz4SpCeWeJmHn5Ytg`) — Railway's own. The app generates a separate
UUIDv4 for `X-Request-Id` and the JSONL `requestId`. Two different ids; don't
try to grep one for the other.

**Browser automation lies about infinite scroll.** An apparent "auto-load has
stalled" was measured in a tab that was `document.hidden` — Chrome throttles
IntersectionObserver (and rAF) in background tabs, so the sentinel never fires
and a freshly-created observer never delivers its initial callback either. That
looked exactly like a real stall and cost the most time of anything here. Check
`document.visibilityState` before believing any scroll/observer measurement
taken through CDP.

## What to do next time

`grep client-error` in the Railway logs. Client failures now post to
`POST /api/client-errors` (authenticated, from `handleFetchError` and
`ErrorBoundary`) and land on stdout as one JSON line carrying the message, the
redacted path, the status, the user, and `failedRequestId` — the id of the call
that actually failed, which joins straight to that request's own log line.

If it's still not there: the report is capped at 5 per page load and deduped on
message+path, and it's authenticated, so a crash on the login screen reports
nothing.
