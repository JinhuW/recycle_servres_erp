# Fleet deploy fails on every VM: the GHCR read token is dead

**Date:** 2026-10-16 · **Symptom:** `scripts/deploy-workers.sh <tag>` prints,
for every worker,

```
Error response from daemon: Get "https://ghcr.io/v2/": denied: denied
Unable to find image 'ghcr.io/jinhuw/reddits_tracker:<tag>' locally
docker: Error response from daemon: error from registry: denied
FAILED: <ip>
```

and ends `Done with failures: <every ip>`.

## What happened

`GHCR_READ_TOKEN` in the gitignored `scripts/secrets.env` is a classic PAT
with only `read:packages`, made on 2026-08-14 for the first fleet deploy. By
2026-10-16 it was dead: GitHub's API answered 401 and the GHCR token endpoint
403. A 401 doesn't say whether it expired or was revoked; the token's page
under GitHub → Settings → Developer settings → Tokens (classic) does. Nothing
warns before a classic PAT expires, and nothing else uses this token, so the
next deploy is the first thing to notice.

## The fleet was not touched

The remote command is
`login && pull && { stop || true; } && rm -f tracker || true && run …`.
`&&` and `||` have equal precedence and group left, so a failed `login` skips
`pull`, `stop` and `rm`, the `|| true` swallows the failure, and `run` then
fails on its own pull. The old `tracker` container keeps running. Confirm
with `GET /api/workers`: every worker still heartbeats, with its old
`startedAt`. Two side effects:

- The error you see is `docker run`'s, not the login's. If the tag were
  already cached on the VM, it would be a container-name conflict instead.
- The first ssh step still rewrote `/opt/reddits_tracker/.env` from
  `secrets.env`, so the next container restart picks up whatever that file
  holds now.

## How to diagnose fast

```sh
source scripts/secrets.env
curl -s -o /dev/null -w '%{http_code}\n' -u "$GHCR_USERNAME:$GHCR_READ_TOKEN" \
  "https://ghcr.io/token?scope=repository:jinhuw/reddits_tracker:pull&service=ghcr.io"
# 200 = the token can pull; 403 = dead, or missing read:packages
```

Don't test it with a local `docker login ghcr.io`: that replaces the Mac's
stored GHCR credential, the one `docker buildx … --push` uses.

## Fix

1. Make a new classic PAT with only `read:packages` and an expiry you put in
   the calendar.
2. Set it as `GHCR_READ_TOKEN` in `scripts/secrets.env`.
3. Run the check above (expect 200), then rerun
   `scripts/deploy-workers.sh <tag>`.

Running workers don't need the token. A VM reboot restarts `tracker` from
the image already on the VM, so only a deploy is blocked.
