# A new worker with no session file searches logged out

**Fixed** in facebook-tracker 0.10.1 (RS-286): a missing file now has a
fingerprint of its own, so the worker parks. The empty-file step below is no
longer needed.

**Seen:** 2026-10-17, starting the four RS-275 workers (`nyc-1`, `phl-1`,
`va-1`, `va-2`) on the homelab VM.

## Symptom

A brand-new monitor container, with no account in its vault and nothing in
`configs/sessions/homelab-<x>/`, logged

```
[Login] Not authenticated and no credentials configured (the intended password-free setup).
[Search] Searching facebook for enterprise_ssd from New York, NY ...
```

The first item's login failed as expected, and the second item **searched
Marketplace logged out** through the worker's proxy. Every regional worker
already had a session file, so this had never been seen.

## Cause

When `login()` gives up (no session, no credentials), it parks by recording
`_session_blocked_on = session_file_fingerprint()`, the session file's
`(mtime, size)`. `search()` skips while `waiting_for_a_new_session()` is
true. With no file at all, the fingerprint is `None`, so nothing is recorded
as parked. The next job finds a page, sees no block, and searches
(`ai-marketplace-monitor/src/ai_marketplace_monitor/facebook.py`,
`session_file_fingerprint` / `waiting_for_a_new_session`).

## Fix in use

Give a new worker an empty storage state before its first start:

```bash
printf '{"cookies": [], "origins": []}\n' | ssh jinhu@10.10.10.73 \
  'cd recycle_servers/facebook_tracker && docker run --rm -i \
     -v "$PWD/configs/sessions/homelab-<x>:/data" alpine sh -c "cat > /data/fb_state.json"'
```

The session dir is created root-owned by Docker, so the file is written from a
container. With the file there, the worker parks (`[Login] Skipping
<item>: the saved session ... is not valid`) and searches nothing until a
login reaches it. Re-login from the ERP overwrites the file with a real
session.

The monitor itself still has the gap. The real fix is to record a parked
state that is not the file's fingerprint when the file is missing. That is a
vendored-monitor change on `recycle-patches`, followed by an image rebuild.
