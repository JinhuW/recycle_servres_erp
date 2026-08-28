# A 200 write plus a cached GET looks exactly like a failed save

**Date:** 2026-08-28
**Area:** `apps/backend/src/index.ts` (`CACHEABLE_PREFIXES`), and any endpoint that is edited and re-read in one user action
**Severity:** medium — the write lands, the UI shows the pre-write value, and the user re-enters the data

## Symptom

Editing a warehouse's shipping address in Settings → Warehouses appeared not
to save: after Save, the card was unchanged and re-opening the modal showed
every shipping field blank. The data *was* in the DB the whole time.

## Cause

`/api/warehouses` responses carried `Cache-Control: private, max-age=60`.
`WarehousesPanel` saves and then immediately calls `reload()`, so the browser
answered that reload out of its own **pre-edit** copy — never reaching the
origin — and the modal re-seeded its `draft` from that stale object.

The tell is in the server log, and it is an *absence*:

```
<-- GET   /api/members                 200      ← modal opened
<-- PATCH /api/warehouses/WH-BOSTON    200 36ms ← the save
<-- GET   /api/members                 200      ← modal opened again
```

`GET /api/warehouses` never appears — not on panel mount, not after the save —
while `GET /api/members`, which is *not* in `CACHEABLE_PREFIXES`, hits the
origin both times. **That asymmetry is the whole diagnosis.** Two components
that fetch on the same user action, one logged and one not, means the missing
one was served from a cache, not that the code failed to call it.

## How to recognise it next time

A "my edit didn't save" report where the write endpoint returns **200** is not
a write bug. Before touching the write path:

1. Grep the request log for the *read* that should follow the write. If it is
   missing, the client never asked — look at caching, not at SQL.
2. `curl -D - <origin>/api/<thing>` and compare `cache-control` against a
   sibling endpoint that behaves correctly. A 401 still shows the header, so
   this works without credentials.

The service worker is a red herring here: `apps/frontend/src/sw.ts` registers
`NetworkOnly` for `/api/*`. The staleness was the plain browser HTTP cache.

## Fix

Dropped `/api/warehouses` from `CACHEABLE_PREFIXES`. It was the one entry in
that list that is edited and re-read inside a single user action; the others
(`lookups`, `categories`, `workspace`) load once at boot into module caches.
The header is now also restricted to `GET`/`HEAD` — the prefix match had been
stamping a cache lifetime onto POST/PATCH responses too.

## Trap left standing

`/api/lookups`, `/api/categories` and `/api/workspace` keep the 60 s cache, so
the same 60-second lie is available to any *new* screen that edits one of them
and re-reads it in the same action. If you add such a screen, take the prefix
off the list rather than working around it on the client.

Covered by `apps/backend/tests/cache-headers.test.ts`.
