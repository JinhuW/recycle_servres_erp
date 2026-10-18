# Deployment

## Coordinator (once for the fleet)

```bash
cd deploy
set -a; source ../configs/secrets.env; set +a
docker compose -f docker-compose.coordinator.yml up -d --build
curl http://127.0.0.1:8500/healthz
```

Keep port 8500 off the public internet. Workers should reach it over Tailscale
or WireGuard; `RS_COORDINATOR_TOKEN` is a second lock, not the only one.

Verify Telegram before bringing workers up — a coordinator that cannot send is
a silent fleet:

```bash
rsc test-telegram
```

## Worker nodes (one per region)

Six workers cover the lower 48, one region each, every city searched at a
500-mile radius:

| Worker | Region | Cities | Proxy |
| --- | --- | --- | --- |
| `ne-1` | Northeast | Boston, New York, Philadelphia, Pittsburgh | `PROXY_NORTHEAST` |
| `se-1` | Southeast | Washington DC, Charlotte, Atlanta, Miami | `PROXY_SOUTHEAST` |
| `mw-1` | Midwest | Detroit, Chicago, Minneapolis, St. Louis | `PROXY_MIDWEST` |
| `sc-1` | South Central | Memphis, Dallas, Houston, New Orleans | `PROXY_SOUTH_CENTRAL` |
| `denver-1` | Mountain / Plains | Denver, Billings, Salt Lake City, Albuquerque | none (home base) |
| `wc-1` | West Coast | Seattle, Portland, Sacramento, Los Angeles, Phoenix | `PROXY_WEST` |

Mainland only — Alaska and Hawaii are out of scope, and nothing here reaches
them. `wc-1` carries five cities rather than four and is paced slightly slower
(55–90m instead of 45–75m) to keep its request rate in line.

Per-node checklist:

1. **Prepare the Facebook account** (by hand, in a normal browser):
   - Use a dedicated account, never the company page account.
   - Set the account language to **English (US)** — every selector is English.
   - Tick "keep me logged in" at login. Without it the session cookies die when
     the browser closes and there is nothing durable to export.
   - Browse Marketplace normally for a few days before automating it.

2. **Add the worker to `configs/fleet.toml`**: assign its region, session file
   path, and proxy env var.

3. **Create the session** — this is the only Facebook credential in the system.
   Capture it through the same proxy the worker will use, because Facebook
   binds a session to the IP and browser it was created on:

   ```bash
   set -a; source ../configs/secrets.env; set +a
   rs-session capture --proxy "$PROXY_SOUTH_CENTRAL" \
       --storage-state ../configs/sessions/sc-1.json
   ```

   A browser opens; log in by hand and only the resulting cookies are saved.
   Nothing you type is stored.

   Store the account's 2FA secret first and the code is filled in for you —
   worth doing before the first capture, since every later refresh needs one
   too:

   ```bash
   rs-session set-secret --storage-state ../configs/sessions/sc-1.json
   # prompts for the base32 key (or paste the otpauth:// URI from the QR code)
   ```

   Check it matches your authenticator before relying on it:

   ```bash
   rs-session totp --storage-state ../configs/sessions/sc-1.json
   ```

   If you would rather reuse a browser where you are already logged in, export
   its cookies and import them instead — pass that browser's user agent so the
   worker presents the same identity:

   ```bash
   rs-session import --cookies cookies.txt \
       --user-agent "$(: paste the browser's UA )" \
       --proxy "$PROXY_SOUTH_CENTRAL" \
       --storage-state ../configs/sessions/sc-1.json
   ```

   The exporter must include **httpOnly** cookies, or the `xs` session cookie
   will be missing and the import is rejected.

4. **Verify the session authenticates** before deploying:
   ```bash
   rs-session check --storage-state ../configs/sessions/sc-1.json
   ```

5. **Generate the worker config** (from the repo root):
   ```bash
   rsc gen-configs
   ```

6. **Bring it up**:
   ```bash
   cd deploy
   set -a; source ../configs/secrets.env; set +a
   WORKER_ID=sc-1 docker compose -f docker-compose.worker.yml up -d --build
   ```

7. **Confirm it started from the session** rather than a login page:
   ```bash
   docker compose -f docker-compose.worker.yml logs | grep -i "session restored"
   ```
   If that line is missing, the session file is not mounted or has lapsed. The
   worker will now stop with an error naming the `rs-session` command to run —
   it will not silently search while logged out.

8. **Confirm it reports in**:
   ```bash
   rsc status
   ```

## Session files on containerized workers

A containerized worker mounts **its own session directory**, not individual
files:

```
configs/sessions/
├── personal.json                 # local `aimm --config master.toml` run, not a container
├── personal.json.meta.json
└── denver-1/                     # one directory per containerized worker
    ├── fb_state.json             # mounted at /data/fb_state.json
    └── fb_state.json.meta.json
```

So capture a fleet worker's session into its directory:

```bash
mkdir -p configs/sessions/denver-1
rs-session capture --proxy "$PROXY_MIDWEST" \
    --storage-state configs/sessions/denver-1/fb_state.json
```

The generated config already points at `/data/fb_state.json`, so nothing else
changes.

### Why a directory and not two file mounts

Verified on a Linux container, not assumed:

- **A missing file becomes a directory.** Bind-mounting `sessions/mw-1.json`
  when that file does not exist yet makes Docker create a *directory* at that
  path on the host; the worker then dies with `IsADirectoryError`. On a fresh VM
  — where no session has been captured — that is the default outcome. A
  directory mount cannot fail this way.
- **The sidecar must be writable.** Mounted `:ro`, any `rs-session` or poster
  run inside the container fails with `Read-only file system`.

### The mount must stay read-write

Facebook rotates session cookies as the worker browses. A single Marketplace
search in the container changed `xs` — the session token itself — plus `fr` and
`wd`, and added `presence`. Those writes go back to the host file (Playwright
writes in place, so the inode and the host file's ownership and 0600 mode are
preserved). Drop the write path and every restart replays a stale `xs`, which
ages the session out far faster than it needs to.

## What persists, and where

| What | Where | Survives |
| --- | --- | --- |
| The session (`fb_state.json` + sidecar) | the worker's `/data` on its host, and a sealed snapshot in the coordinator | a restart; a rebuilt or moved worker restores the snapshot |
| The device (user agent, screen, viewport, locale, timezone, `datr`/`sb`) | `device_profiles` in the coordinator, cached as `/data/identity.json` | everything: it belongs to the Facebook account, not the host |
| The browser profile (cache, service workers) | nowhere | nothing |

**The device belongs to the account.** The coordinator keeps one device profile
per Facebook account, keyed by its uid (`accounts.fb_uid`, which the ERP's
*Assign to fleet* sets). Whichever worker runs the account presents it: a
restart, a rebuilt VM, or the account moving to another worker shows Facebook
the same browser. Two accounts never share one. `rsc identity list` prints
them. A worker whose account has no uid keeps the browser it always had.

**A session follows its slot.** A worker's session snapshot is restored onto
that same worker id when its `/data` holds no session, or holds the same
session gone stale (saved under the account's device before the snapshot was).
A live session of any other provenance is never replaced, and once the
account has a uid the coordinator only releases a snapshot of that login, so
a swapped-in login never inherits the previous one's cookies. The IP
Facebook sees is the slot's proxy, which goes wherever the slot runs. A worker
with no proxy egresses through its host's own IP, so it must stay on that host.

**A new login sets the old session aside.** When the ERP puts another account
on a worker, the worker moves the previous session to
`fb_state.json.<time>.previous-login` (never deleted) and signs in under the
new account's own device.

**Joining.** A worker that is logged in but has no device yet reports what its
browser presents, and its account's first profile copies that, so Facebook sees
nothing change. For the accounts that predate the uid, `rsc identity
learn-uids` prints each slot's session uid; check them against the ERP's pool,
then `--apply`.

**The browser profile itself does not persist.** `aimm` builds a fresh Chromium
profile per context and injects the session (cookies, localStorage and
IndexedDB, `indexed_db=True`) and the device into it. A persistent
`user_data_dir` would only survive on one host, which is what the device
profile already replaces.

## Keeping sessions alive

Facebook sessions expire (roughly 90 days of inactivity, often sooner) and are
invalidated by a password change, "log out of all devices", or a security
checkpoint. Workers refresh cookies automatically as they browse, but check
before a lapse bites:

```bash
rs-session info --storage-state configs/sessions/sc-1.json   # JSON, for cron
rs-session check --save-refreshed --storage-state configs/sessions/sc-1.json
```

A weekly cron running `rs-session info` and alerting when `days_remaining`
drops below ~14 is enough. When a session does lapse, re-run `rs-session
capture` — no other part of the system changes. The stored 2FA secret survives
a re-capture, so refreshing a session is one command with no code to look up.

`rs-session info` also reports `totp_configured`; treat a worker with a stored
session but no secret as a refresh that will block on a human.

If a check reports a **checkpoint**, open that account in a normal browser,
clear the challenge, and capture a fresh session. Do not retry the worker
against a checkpointed account; repeated attempts escalate to a ban.

## Adding or changing a region

Define it in `master.toml` under `[region.*]`, point a new `[worker.*]` at it in
`fleet.toml`, run `rsc gen-configs`, and deploy. `gen-configs` warns if two
workers would cover the same city.

Verify any city you add **before** deploying it:

```bash
python scripts/check-cities.py rs_west          # or no argument for every region
```

A wrong Marketplace location slug does not raise an error. Facebook falls back
to the logged-in account's own location, so the worker runs happily and alerts
on listings from the wrong part of the country. `sacramento` and `billings` both
do this — the working values are `sac` and the numeric id `112454482100538`.

## Scaling notes

- One account per IP. Two workers behind the same residential IP is the fastest
  way to lose both accounts.
- Match proxy geography to the region. A Houston-centred search from a Denver IP
  looks wrong to Facebook's heuristics.
- Region borders overlap on purpose. A 500-mile radius is not what Facebook
  actually returns — ranking, seller settings, and category placement hide
  listings that are geographically in range — so neighbouring cities seeing the
  same ground is coverage, not waste. The coordinator dedupes by item id, so it
  never costs a second alert.
- Stagger worker startups by a few minutes; a fleet logging in simultaneously
  from related IPs is a pattern.
