# Facebook tracker

Facebook Marketplace tooling for Recycle Servers LLC. Three halves:

- **Monitor** — a fleet of worker VMs, each pinned to one region, searching
  Marketplace for used server hardware, filtering with an LLM, and reporting
  matches to a central coordinator that dedupes and alerts one Telegram chat.
- **Poster** — publishes "we buy your used servers" ads with photos, and keeps
  them near the top of the feed by reposting on a schedule.
- **Messenger** — bridges each account's Marketplace inbox to the same
  Telegram chat, and (only when explicitly armed) sends one templated
  auto-reply per new conversation so a seller is never left hanging while a
  human gets to the alert.

Python (the two upstream projects it builds on are Python), unlike the
TypeScript ERP and Reddit tracker elsewhere in this monorepo.

## Layout

| Path | What it is |
| --- | --- |
| `ai-marketplace-monitor/` | Upstream monitor engine (AGPL-3). Our changes live on the `recycle-patches` branch — see below. |
| `facebook-marketplace-bot/` | Reference only. Stale Selenium; never run it. Its posting flow was reimplemented in `rs_poster`. |
| `rs_coordinator/` | Coordinator service (FastAPI + SQLite) and the config sharding generator. CLI: `rsc`. |
| `rs_console/` | Read-mostly facade the ERP and the fleet dashboard read through; serves the dashboard at `/`. Loopback + Cloudflare tunnel only. |
| `rs_poster/` | Buy-ad poster (Playwright). CLIs: `rs-poster`, and `rs-session` for password-free Facebook sessions. |
| `rs_messenger/` | Marketplace inbox bridge (Playwright). CLI: `rs-messenger`. Reports conversations to the coordinator, which routes them to Telegram and queues (optional, default-off) auto-replies for it to send. |
| `rs_router/` | Messenger router (stdlib only): bridges mautrix-meta Matrix rooms to the coordinator's messages API and sends the replies queued for the bridge. CLI: `rs-router`. |
| `configs/` | `master.toml` (what the fleet searches), `fleet.toml` (which VM searches where), generated per-worker shards. |
| `deploy/` | Docker Compose files and the per-node bringup checklist. |
| `scripts/` | Deploy, measurement probes, and the release/vendor/secret checks. |
| `infra/` | Terraform for the coordinator's own Railway Postgres (project `facebook-tracker`), and why it is not shared. |
| `docs/` | `architecture.drawio`: the whole system as one draw.io diagram. |
| `CHANGELOG.md` · `VERSION` · `VENDOR.md` | What changed, which version, and which revision of the vendored projects it expects. |

## How it fits together

```
master.toml + fleet.toml  --rsc gen-configs-->  configs/generated/worker-<id>.toml
                                                          |
                        worker VM (one region, one FB account, one proxy)
                                                          |
                          search -> keyword filter -> OpenRouter rating >= 4
                                                          |
                                    POST /api/v1/listings (coordinator channel)
                                                          |
                    coordinator: dedupe by Facebook item id -> SQLite -> Telegram
```

Each worker is **statically pinned to one region**. There is no runtime
dispatch and no random city selection: a worker's scope changes only when
`fleet.toml` is edited and configs are regenerated. Workers never message
Telegram directly, so a listing visible from two adjacent regions still
produces exactly one alert.

## Fleet coverage

Six workers divide the lower 48, each city searched at `radius=500`. Two
corrections, both measured 2026-08-20 and both worth knowing before you touch
that number: **the parameter is in kilometres** (500 reads back as "Within 311
mi", and 805 is what a real 500 miles looks like), and **changing it makes no
difference** — the same search at 60, 100, 161 and 500 returned byte-identical
result sets. Coverage comes from the number of centres, not the radius:

| Worker | Region | Cities |
| --- | --- | --- |
| `ne-1` | Northeast | Boston, New York, Philadelphia, Pittsburgh |
| `se-1` | Southeast | Washington DC, Charlotte, Atlanta, Miami |
| `mw-1` | Midwest | Detroit, Chicago, Minneapolis, St. Louis |
| `sc-1` | South Central | Memphis, Dallas, Houston, New Orleans |
| `denver-1` | Mountain / Plains | Denver, Billings, Salt Lake City, Albuquerque |
| `wc-1` | West Coast | Seattle, Portland, Sacramento, Los Angeles, Phoenix |

Neighbouring circles overlap on purpose: the radius is not what
Marketplace actually returns, so extra centres surface listings that ranking or
category placement would otherwise bury. Coverage is mainland only — Alaska and
Hawaii are out of scope and no region reaches them.

**Radius is not the coverage knob — the city list is.** Measured 2026-08-20 on
the RAM phrase, chasing a Louisville lot (item 955960664200505) the fleet never
captured. Every row below is the monitor's own URL builder and result parser, so
"absent" means the sweep genuinely could not see it:

| search | results | target | Louisville-area results |
| --- | ---: | :---: | ---: |
| `columbus` r=100, 7d, local pickup (what the fleet runs) | 115 | absent | 0 |
| `columbus` r=250 / r=500, same filters | 115 | absent | 0 |
| `columbus`, `deliveryMethod` dropped | 978 | absent | 0 |
| `columbus`, `daysSinceListed` dropped | 310 | absent | 0 |
| `columbus`, every filter dropped | 978 | absent | 3 |
| `cincinnati` r=100 (89 mi from the seller) | 115 | absent | 0 |
| **`louisville` r=100, identical filters** | 115 | **position 1** | **64** |

No filter is responsible — stripping all of them still does not surface it, and
the *same* filters from Louisville put it first. Neither is radius: 100, 250 and
500 from Columbus are indistinguishable. Results are anchored to the city in the
URL path, and Columbus's result set contains essentially no Louisville-area
inventory at any radius. A metro is covered only when it has its own entry in
`search_city`.

This is also why a listing can be plainly visible in your own browser and
invisible to the fleet: your browser searches from whatever location your
account is set to, the worker searches from the city in `search_city`.

City values are Facebook location slugs, and a wrong one **fails silently** —
Facebook searches from the account's own city instead of erroring. Verify
before deploying:

```bash
python scripts/check-cities.py            # every region in master.toml
python scripts/check-cities.py rs_west    # or just one
```

## Authentication: sessions, not passwords

Workers hold no Facebook password. Each account is logged into once by hand,
and the resulting browser session is what the fleet uses. (The coordinator's
vault *can* hold a password per account, opt-in, so that the console's
"Re-login" can finish without a person — see "Managing logins from the ERP"
under the fleet dashboard. The worker still never keeps it.)

```bash
# Log in manually; only the resulting cookies are kept.
rs-session capture --storage-state configs/sessions/denver-1.json

# Or reuse a browser you are already logged into.
rs-session import --cookies cookies.txt \
    --user-agent "<that browser's user agent>" \
    --storage-state configs/sessions/denver-1.json

rs-session check   # confirm it authenticates, and when it expires
rs-session info    # same, as JSON, for cron
```

A session is pinned to the environment it was born in: `rs-session` records the
user agent and proxy in a `<session>.json.meta.json` sidecar, and both the
monitor and poster present that same identity. Capture through the worker's own
proxy (`--proxy`) so the session's IP matches where it will be used — Facebook
challenges sessions that move.

Sessions last on the order of weeks and are invalidated by a password change,
"log out of all devices", or a security checkpoint. When one lapses, the worker
stops with an error naming the exact command to run; it never searches while
logged out. See [deploy/README.md](deploy/README.md) for the refresh routine.

### Two-factor codes

Every worker account has 2FA on, so every capture needs a six-digit code. Store
each account's TOTP secret once and `rs-session` produces the code itself —
there is no reason to fetch it from a web authenticator by hand:

```bash
# Once per account. Omit --secret to be prompted (keeps it out of shell history).
rs-session set-secret --storage-state configs/sessions/sc-1.json \
    --secret "otpauth://totp/..."      # or the bare base32 key

rs-session capture --storage-state configs/sessions/sc-1.json   # fills 2FA in itself

rs-session totp --all --dir configs/sessions   # every account's current code
rs-session totp --storage-state configs/sessions/sc-1.json --raw | pbcopy
```

The secret is the base32 key Facebook shows under Settings → Security →
Two-factor → Authentication app → "Set up another way", or the whole
`otpauth://` URI from the QR code. Codes are plain RFC 6238, computed locally —
nothing is sent anywhere. Web generators sellers link to, such as
client.2zie.com/2fa, run the same arithmetic in the browser; see
[the 2zie note](../../docs/debug-notes/2026-10-17-2zie-2fa-is-plain-totp.md).

Secrets live in the same `<session>.json.meta.json` sidecar as the user agent
and proxy: 0600, gitignored, sitting beside cookies that are an equally live
credential. Per-account overrides come from `FB_TOTP_SECRET_<WORKER>` (e.g.
`FB_TOTP_SECRET_SC_1`); a plain `FB_TOTP_SECRET` covers the single-account case
inside a worker container. `rs-session check` prints whether a secret is stored,
and `rs-session info` reports `totp_configured` for cron.

A stored secret outlives the cookies next to it — a session expires in weeks, a
TOTP secret mints codes until the account re-enrolls. Keep them on the operator
machine, which is where captures happen; workers only need one if you configure
the password fallback, which is not the intended setup.

**Why not OAuth.** Facebook's OAuth / Graph API cannot do this. There is no
Graph endpoint that reads or searches Marketplace listings; the only official
Marketplace APIs are write-only catalog feeds in a closed partner program for
vehicle, rental, and real-estate dealers, which would not cover server hardware
and grants no read access regardless. An OAuth access token is also not a web
session — it cannot authenticate a browser to facebook.com. Session cookies are
the only mechanism that works.

## Setup

```bash
python3.12 -m venv .venv && . .venv/bin/activate
pip install -e ./ai-marketplace-monitor -e ./rs_coordinator -e ./rs_poster \
    -e ./rs_messenger
playwright install chromium

cp configs/secrets.env.example configs/secrets.env   # then fill it in
set -a; source configs/secrets.env; set +a
```

## Running

Phase 1, a single worker with no coordinator (useful for validating your search
criteria before building out the fleet):

```bash
aimm --config configs/master.toml
```

Full fleet: see [deploy/README.md](deploy/README.md).

### Deploying to the homelab worker

**Always deploy with the script.** It ends by proving the container is running
this tree, which is the whole point:

```bash
scripts/deploy.sh          # test, regenerate config, sync, rebuild, restart, verify
scripts/deploy.sh sync     # config-only change: skip the image rebuild
scripts/deploy.sh check    # verify only — is the VM running this tree right now?
```

**Every deploy must carry a version no deploy has carried before.** Before it
ships anything, `deploy.sh` runs a version gate — `scripts/check-release-tag.sh`
plus one question for the VM — and all four conditions have to hold:

| | |
| --- | --- |
| clean working tree (this tree only) | rsync ships the working tree, not the tag, so uncommitted edits make the tag a lie about what is running |
| `facebook-tracker/v$(cat VERSION)` exists | only `scripts/release.sh` writes those tags, and it refuses to reuse one |
| nothing under this tree changed since the tag | commits made after the tag would otherwise ship wearing the previous release's number |
| the VM does not already run it | a tag deployed twice is still a deploy with no bump behind it |

So the working order is always: write `CHANGELOG.md` under `[Unreleased]`, run
`scripts/release.sh patch`, then `scripts/deploy.sh`. `check` is exempt (it
writes nothing); `sync` is **not** — a config change to the live fleet is
exactly the kind of change "what is deployed?" has to be able to name.

This exists because the pipeline had no such gate: `deploy.sh` read `VERSION`
for its Telegram notification and asked nothing of it, while `release.sh` — the
only script that ever bumps that file — was one nobody was obliged to run. The
📦 Releases topic logged deploy after deploy as the same `0.4.0`, and that
number was not a release at all: no tag, no release commit, just a hand-edited
`VERSION` in a dirty tree. When every line says the same version, the release
log cannot answer the one question it exists to answer.

Re-running a deploy that failed partway is the one legitimate same-version
deploy, so it has an explicit escape hatch which names itself in the
notification:

```bash
scripts/deploy.sh --redeploy   # ship a version the VM already runs
```

`check` is the one to reach for whenever you are about to explain live
behaviour from local source. It md5s every module inside the container against
this tree, diffs the mounted `config.toml` against `configs/homelab.toml`, and
greps the boot log for the errors that get buried within seconds:

```
  code:   MATCH (351ccddb2b7a8fd84842fd0104a638af)
  config: MATCH
  uptime: started 2026-08-21T01:17:45Z, restarts 0, running true
  boot:   clean
```

This exists because of a real afternoon lost: `aimm-recycle:latest` is not
rebuilt automatically, so the container ran an image from hours earlier.
`title_prefilter` and `build_search_url` were in this tree and in the patch
table below, and absent from the running process — every conclusion drawn from
reading local source was wrong about the live system, and nothing said so. A
marker grep only finds the patches someone remembered to list; the checksum
finds everything.

Two traps the script handles that a manual `up -d` does not:

- **`up -d` will not recreate a container when only the image changed** under a
  tag it already holds. The script forces `--force-recreate`.
- **The image bakes in `ENV AIMM_WEBUI_HOST=0.0.0.0`**, so *removing* the
  variable from compose leaves 0.0.0.0 in force. It has to be overridden, not
  omitted — and 0.0.0.0 does not expose the web UI, it stops it starting.

The sync runs with `--delete`, and `scripts/deploy.rsync-filter` lists what it
never pushes and never deletes. The VM's own files are live credentials written
there by hand: its secrets, sessions, per-worker tokens and proxy list. A dev
checkout's copies belong to a different account and IP, and a checkout without
them would have `--delete` remove the VM's. The dev machine's Facebook logins
and 2FA, read by `rs-session capture`, never leave it.
`scripts/tests/test-deploy-filter.sh` checks both with a real rsync.

### Did it alert, and did the alert arrive?

Every listing that clears the rating threshold logs one verdict line saying
whether the message actually left the process:

```
[Alert] SENT     rating 4 >= 4 to recycle | 955960664200505 | 8x 32GB DDR4 ECC RDIMM | https://...
[Alert] NOT SENT rating 5 >= 4 to recycle | 118820441003377 | Dell R730 memory lot   | https://...
```

```bash
scripts/worker-status.sh alerts     # every verdict, oldest first
```

Those rows and the messages in the Telegram chat should correspond one to one.
A row with no message, or a message with no row, is a real discrepancy; an
empty list means nothing scored high enough, which is the common case — over
one measured 24 h window only 8 of 325 rated listings reached 4.

This exists because the log used to say only "Sent recycle a message", printed
before the send was checked, and every notification backend returns `False` for
a refused send rather than raising. So a quiet Telegram chat and a broken
Telegram chat looked identical in the log. `NOT SENT` now names the failure,
and the listing stays un-cached so the next sweep retries it.

The same verdict is emitted as a `listing_alert` structured event
(`delivered`, `score`, `threshold`, `listing_id`, `url`), so it is queryable in
the OpenSearch dashboards alongside the skip reasons.

### System faults page once

When something the whole fleet depends on breaks — OpenRouter out of credits is
the usual one — every worker sees it on every listing. The ops chat used to get
a *"AI evaluation DOWN"* / *"recovered"* pair from each worker each time the
provider flapped: hundreds of messages in a day, which is how an alert channel
gets muted.

Now a worker only *reports* the crossing, and the coordinator decides whether
it is news:

- A worker calls the AI down after 3 straight failed evaluations (each of which
  already retried 10 times), and back up after 3 straight successes. One flaky
  call is not an incident.
- The coordinator (`POST /v1/incidents`, `rs_coordinator/incidents.py`) keeps
  one incident per key. The first `down` report pages ops once, naming the
  worker and the error; every further `down` from any worker is absorbed. The
  incident closes, with one *recovered* note, when every worker that voted
  `down` has reported `up` (a vote nobody renews for 24 h expires, so a worker
  stopped mid-outage cannot hold it open).
- A relapse inside `RS_INCIDENT_COOLDOWN_HOURS` (default 6) re-opens silently
  and closes silently. So a provider that flaps all day costs **two messages per
  six hours, fleet-wide**, and a genuine "it broke again tonight" still pages.

The page rides the durable outbox as an `ops` alert, so a Telegram hiccup delays
it rather than losing it. A worker with no control plane configured (or one
that cannot reach it) applies the same one-page-per-cooldown rule locally, so no
single process can flood the chat either way. Listings are still withheld, not
alerted, for as long as the AI is down, and re-scanned when it returns.

```bash
curl -s -H "Authorization: Bearer $RS_ADMIN_TOKEN" http://127.0.0.1:8500/v1/incidents
```

### Daily fleet verification

HEALTHY in `rsc status` only means the container is up and heartbeating. A
checkpointed or freshly-flagged account heartbeats HEALTHY all day while every
search comes back empty, so productivity has to be checked separately.
`scripts/fleet-verify.py` does that once a day on the VM, from `jinhu`'s
crontab at 21:05 UTC (after the 10:00 UTC sweep has had 6–9 h to finish), and
posts one table to the Telegram chat:

```
Fleet verify — 4/5 OK, 1 need attention
window 09-07 09:50 – 09-08 01:38 UTC

worker    verdict      beat     srch empty  eval alrt
denver-1  OK           live       36     0   580    1
mw-1      ATTENTION    live       47     0   759   12
...
mw-1: container exited
```

Per worker it joins three local sources — the coordinator (liveness, state,
session expiry, open challenges), OpenSearch `fb-tracker-*` events since the
sweep started (`search_start` / `search_empty` / `ai_eval` / `listing_alert`),
and `docker ps -a` — and flags a worker that is not running, stale, non-HEALTHY,
expiring within 14 days, carrying an open challenge, that started no search in
the window, that got any empty search (the checkpoint signature), or that
searched but evaluated nothing. It reads the shipped events, not the
container's `ai-marketplace-monitor.log`, which an inotify loop floods.

```bash
python3 scripts/fleet-verify.py --dry-run          # print, send nothing
python3 scripts/fleet-verify.py --mute mw-1        # a worker parked on purpose
python3 scripts/fleet-verify.py --hours 24         # fixed window
tail logs/fleet-verify.log                         # on the VM: every run
```

Exit 0 is all clear, 2 is "something needs attention", 1 is "the check itself
could not run" — so a silent day in the chat is never a broken check. This is
an on-VM cron rather than a `/schedule` cloud routine because a cloud agent can
reach neither the coordinator (loopback-only) nor docker on the VM, and could
not fix anything it found. `scripts/sweep-report.py` (the by-city funnel) is
the same shape and can be added to the same crontab when wanted.

### Watching the browser

The homelab monitor drives a real Chromium on a virtual display, and you can
watch it live — the fastest way to tell a selector break apart from a
checkpoint, an empty result page, or a session that quietly logged out.

The quickest way in is the fleet dashboard: every worker row has a **Watch**
button (and the *Needs a human* card links straight to the stuck worker),
which opens `https://fbc-api.recycleservers.com/vnc/<worker-id>` — the live
screen in a browser tab, no tunnel and no VNC client. It opens view-only;
tick **Take control** to clear a checkpoint, and it drops back to watching
when the tab is hidden. See [Fleet dashboard](#fleet-dashboard) for how the
console reaches the browser and which workers are listed.

From a terminal, the older route still works:

```bash
scripts/monitor-view.sh          # prints the ssh tunnel command for a viewer
scripts/monitor-view.sh shot     # saves reports/monitor-screen.png
```

`shot` needs nothing installed on either machine: `scripts/vnc-screenshot.py`
speaks RFB and writes the PNG with `zlib` alone, because neither the container
nor the VM has ImageMagick, vncsnapshot or PIL.

The session is shared, so anything you click goes to the same browser the
scraper is using. Watch; do not drive, unless you are clearing a checkpoint.

**There is no web UI.** The compose files publish 8467 and set
`AIMM_WEBUI_HOST=0.0.0.0`, and that combination *prevents* the UI from
starting — aimm refuses a non-loopback bind without credentials, logging one
`[WebUI] Failed to start` line at boot while the monitor carries on searching.
The only credentials it accepts are `FACEBOOK_USERNAME` / `FACEBOOK_PASSWORD`,
which `facebook.py` also reads as the marketplace login, so turning the UI on
means putting a real Facebook password on the box and re-arming the password
fallback this project exists to avoid. VNC is the supported route.

Posting:

```bash
rs-poster validate                 # checks ads, photos, pacing budget
rs-poster post --ad buy_servers --city "Denver, CO" --dry-run
rs-poster post --ad buy_servers --city "Denver, CO"
rs-poster renew                    # reposts only what is due
rs-poster status
```

Messenger:

```bash
rs-messenger poll --dry-run        # print what the selectors extract; touches nothing
rs-messenger poll                  # one pass: read inbox, sync, send queued replies
rs-messenger run --interval 300    # the same, on a jittered loop
rs-messenger status                # offline: config, session, lock
```

Coordinator:

```bash
rsc gen-configs      # regenerate worker shards after editing configs
rsc serve            # run the API locally
rsc status           # fleet health + recent finds + alert backlog
rsc test-telegram
rsc msg threads      # Messenger conversations the fleet has reported
rsc msg show <thread-id>
rsc msg reply <thread-id> "On our way — does Saturday work?"   # via the bridge
rsc msg reply --via playwright <thread-id> "..."   # force the scraper fallback
rsc msg claim <thread-id>          # fence auto-reply out of a conversation
```

Router (mautrix-meta bridge, on the homelab VM — see `configs/matrix/README.md`):

```bash
rs-router status                   # config, homeserver identity (whoami)
rs-router poll --dry-run           # one sync: print portals + new messages, send nothing
rs-router run --interval 2         # the loop: report messages, deliver queued replies
```

### Messenger routing and auto-reply

`rs-messenger` shares the poster's saved session **and its account lock**, so
one Facebook account never posts and messages at the same time. Each poll it
re-reports the N most recent conversations wholesale; the coordinator dedupes
by message fingerprint (the inbox equivalent of the listing dedupe key), so
re-reporting is free and only genuinely new inbound messages reach Telegram.
Alerts ride the same durable outbox as listing alerts: a Telegram outage
delays them, it cannot lose them.

Auto-reply is **off until you set `RS_AUTOREPLY_ENABLED=1`** on the
coordinator, and stays deliberately timid once on:

- at most one automated reply per thread, ever — its only job is to keep a
  seller warm until a human reads the alert;
- never on a thread that already has *any* outgoing message, and never on one
  an operator claimed (`rsc msg claim`, or implicitly by `rsc msg reply`);
- capped fleet-wide per rolling day (`RS_AUTOREPLY_MAX_PER_DAY`, default 20)
  and confined to waking hours (`RS_AUTOREPLY_HOURS`, default `14-4` UTC —
  roughly 8am-10pm Denver);
- every queued auto-reply is announced in the Telegram chat, so the bot never
  talks to a seller behind the operator's back. The template
  (`RS_AUTOREPLY_TEMPLATE`) answers honestly and asks for part numbers,
  quantities and photos — the things a human needs to quote.

The reply itself is typed by `rs-messenger` on its next poll, paced at no more
than one send per minute, and acked back only after the text is seen in the
conversation pane. Messenger's DOM is the least stable thing this project
reads; `rs-messenger poll --dry-run` prints exactly what the selectors
extracted and is the first thing to run when the bridge goes quiet.

### Fleet dashboard

One page answers "which account is searching which cities for which phrases,
and is it alive?" — served by the console facade itself, at the tunnel
hostname's root (`https://fbc-api.recycleservers.com/`, or
`http://127.0.0.1:8600/` on the VM). Paste the VM's `RS_CONSOLE_TOKEN` once;
the browser keeps it.

What is on it, top to bottom: four KPIs (accounts live, cities searched now,
active search phrases, listings reviewed today); a **Needs a human** card that
appears only when a checkpoint is open or the control plane flagged an
account; the **Accounts** table (liveness, state, session days left, last
search, heartbeat, alerts from its cities in 7 days, and who the account is:
the vault's Facebook login and the session's Facebook user id — click a row
for its city list, vault account, stored secrets, browser identity, backup
age, proxy env var, session file and pacing); the **Search phrases**
card (per item: the literal search-bar text, the title gate, the reject
list); the shared **Search settings**; and **Coverage** — every centre by
region, lit when a reporting worker searches it, with a count of alerts each
city produced this week. The search box filters accounts, cities and phrases
at once.

Behind it is one new facade route, `GET /v1/fleet`, which joins what the
dashboard could not otherwise see together: `fleet.toml` (worker → region,
proxy env, pacing), `master.toml` (regions, items, settings), the mounted
`homelab.toml` (what the phase-1 monitor actually searches — matched to a
region by city set, so the ramp reads as "Southeast" rather than "28
cities"), and from the coordinator: worker health, the vault's account list
(`GET /v1/accounts` — identity and which secrets are stored, never a value or
a proxy URL) and each worker's session metadata (`fb_user_id` is the `c_user`
cookie of the backed-up session, i.e. the public profile id). A proxy leaves
as its env-var name and as `proxy`: the URL with any login cut out, plus the
IP, city, region, country and ISP it exits from. The console asks
`ipinfo.io` *through* the proxy (`rs_console/proxy_exit.py`), caches the
answer 6 h (a failure 5 min), and waits at most 3 s for it, so a slow proxy
reads `pending` instead of holding the page; a worker with no proxy shows the
VM's own exit. A proxy's username and password never leave, and a literal URL
in a config is still dropped, not exposed.
The document degrades rather than fails: a coordinator outage sets
`health.error` and the configured fleet still renders, which is when someone
is most likely looking; an older coordinator without `/v1/accounts` simply
yields no account block.

**Watching a worker's browser from the page.** The **Watch** button on a row
opens `/vnc/<worker-id>`, a page that runs the vendored noVNC client
(`rs_console/rs_console/static/novnc`, MPL-2.0, version in its `VERSION`
file) against a WebSocket the console itself bridges to the worker's
x11vnc. Every monitor container already runs x11vnc on its own port 5900,
unauthenticated and unpublished; the console shares the `rs-fleet` network
with them, so `rs-monitor-ne:5900` resolves by container name and no VNC
port is ever exposed. Which workers are reachable is the closed list in
`RS_VNC_TARGETS` (`deploy/docker-compose.console.yml`, `<RS_WORKER_ID>=
<container>:5900` pairs) — a worker not on it gets no page, no ticket and
no socket. The browser cannot put a bearer header on a WebSocket, so the
page first POSTs `/v1/vnc/<worker>/ticket` with the console token and opens
the socket with the single-use, 60-second ticket it gets back; the token
never enters a URL. The viewer is view-only until **Take control** is
ticked, because the session is shared with the scraper. To make the
coordinator's Telegram escalation alerts link there too, register the
public page on the account:

```bash
rsc vault set-account --account <id> --vnc-url https://fbc-api.recycleservers.com/vnc/<worker-id>
```

`deploy/docker-compose.console.yml` mounts `master.toml` and `fleet.toml`
read-only and reads `RS_WORKER_ID` from `secrets.env` to join the monitor's
heartbeat row. It mounts every worker config (`configs/homelab*.toml`)
writable, one file at a time, for saved settings (below). `scripts/deploy.sh`
rebuilds and recreates the console; the coordinator is not part of its
restart, so after a deploy rebuild that by hand when it changed (for
`/v1/accounts` and `fb_user_id`):

```bash
ssh jinhu@10.10.10.73 'cd ~/recycle_servers/facebook_tracker && \
    docker compose -f deploy/docker-compose.coordinator.yml up -d --build coordinator && \
    docker compose -f deploy/docker-compose.console.yml up -d --build console'
```

**Settings saved from the ERP.** The ERP's *From a search to an alert* card
edits the search settings each stage reads: sweep times, listing window,
delivery, results per search, intervals, the title prefilter, seller rating
rules, the alert rating, minimum units, the AI model, the prompt and rubric,
and each item's phrases, keywords and anti-keywords. It saves through
`PUT /v1/config/settings`. `rs_console/settings.py` lists exactly what can
change; regions, proxies, sessions, credentials and notification targets
cannot. One worker's cities can too: the ERP's worker page saves them through
`PUT /v1/workers/<id>/cities` into that worker's config only. That needs the
config named by worker in the console's `RS_WORKER_CONFIGS`
(`ne-1=/config/workers/homelab-ne.toml`); a bare path takes the fleet-wide
values only. Any Marketplace location is accepted, not just master.toml's
regions, and a wrong slug fails silently, so check a new one on Marketplace.
Saved values are kept in `/state/settings.json` on the
`rs-console-state` volume, not in `master.toml`, which stays the default for
anything never saved. The console writes them into every worker config in
place, and the monitor reloads its config between jobs. That reload restarts
its jobs, so **a save starts a sweep straight away**. `scripts/deploy.sh`
sends the worker configs through `python -m rs_console.settings render`, so a
deploy keeps saved values instead of putting master's back. To see the saved
values: `docker exec rs-console cat /state/settings.json`. To drop all of
them, delete that file and run `scripts/deploy.sh sync`, which renders the
worker configs from the tree again.

**Busy cities are searched more often.** A worker's config says *which*
cities it searches; the coordinator decides *how often*, at search time, so a
change never rewrites a config or restarts a sweep. It ranks each worker's
cities by alerts sent plus alerts a partner reacted to over a window (default
30 days): the top 20% are searched 3 times a day, the next 20% twice, the rest
once, and a city with no alerts in the window is never promoted. A manager can
pin a city to a count. The day is split into the worker's `start_at` times:
before each item's sweep the monitor sends its config cities and the slot it
is in to `POST /v1/workers/<id>/search-plan` and searches only the cities due
in that slot, a 3×/day city in every slot and a once-a-day city in one slot
picked by a hash of its slug. **With one `start_at` time everything is searched
once a day**, as before; set three (e.g. `["02:00", "10:00", "18:00"]`) from the
ERP's search settings to turn the tiers on. A monitor that cannot reach the
coordinator, or runs on an interval instead of `start_at`, searches every city.
The rule and the pins live in the coordinator's `city_tier_settings` and
`city_tier_pins` tables; the ERP edits them through the console's
`GET/PUT /v1/city-tiers`, and `/v1/fleet` marks each city with its `per_day`,
`pin` and `score`.

**It is built to be absorbed by the ERP.** The page is plain HTML/JS with no
build step, and its markup uses the ERP's own tokens and classes (`card`,
`kpi`, `chip`, `data-table`, `seg`), so moving it means adding a
`coordinator.get('/fleet')` forward to the ERP's `/api/coordinator` proxy
and re-expressing `fleet.js`'s render functions as React components on the
existing Facebook-tracker page. The data contract is `/v1/fleet`; nothing in
the page depends on the facade beyond that route and the three it already
forwards (`/v1/challenges`, `/v1/stats/reviews`, `/v1/stats/alert-hits`).

**Re-login, and where its credentials come from.** The **Re-login** button
(on the console's viewer page and the ERP's fleet page) queues a one-shot
`relogin` directive on the coordinator (`POST /v1/workers/<id>/relogin`,
forwarded by the console); the worker collects it within about ten seconds,
from a directive poll (`POST /v1/workers/<id>/directives`, worker token)
that runs between its five-minute heartbeats, and starts once the browser
is free — at once between sweeps, at the next search mid-sweep. It drops its
session cookies — keeping the browser's
device cookies, so Facebook sees the same browser signing in again rather
than a new device — and runs the full login. Username and password come
from the vault through `/v1/auth/credentials`, which releases them only
when the account has a password stored **and** `allow_password_login` set;
the 2FA code comes from the vault's TOTP secret. Without those, the login
form is left open for a person to finish in Watch → Take control, and the
worker adopts that session within about 15 seconds. Each step of the login
(`picked_up`, `typing`, `submitted`, `challenge`, `waiting_for_human`,
`logged_in`, `failed`) goes out as its own heartbeat (`login_step`,
`login_step_at`). The coordinator keeps the latest step with the request time
(`relogin_requested_at` while it waits, `relogin_last_requested_at` after),
and the ERP's Watch page shows them as they land, flagging a captcha or code
that needs the person watching.

**Managing logins from the ERP.** The ERP's Account information table has
an **Edit credentials** form per worker that writes to the vault through
the console: `PUT /v1/accounts/<account-id>` (coordinator, admin token;
console, console token) with any of `worker_id`, `fb_username`, `region`,
`allow_password_login` and a write-only `secrets` object (`password`,
`totp_secret`, and the e-mail code fields). A field left out keeps its
value; an empty secret keeps what is stored; `null` clears it. The TOTP key
is validated as `rsc vault set-account` validates it, a worker cannot be
registered on an account another account owns (409), and the answer is the
same presence-flag view `GET /v1/accounts` serves — no value is ever read
back, and the coordinator's audit line names fields, not values. This is
the one route on the console's allowlist through which a credential enters
the fleet, which is the trade: the ERP's console token can now set a
worker's login, but still cannot read one. `rsc vault set-account` on the
VM remains the fallback and the only way to set a proxy or VNC URL.

### Messenger router (mautrix-meta → Telegram forum topics)

The flat alert stream above answers "did someone message us"; it does not scale
to *following* several buyers at once. The router adds that: a real Messenger
bridge ([mautrix-meta]) puts each buyer in their own Matrix room, and a small
worker (`rs-router`) reports those rooms to the coordinator, which opens **one
Telegram forum topic per conversation** in a war-room supergroup. Staff answer
inside a topic; the reply travels back out over Messenger through the bridge.
Full bring-up is in `configs/matrix/README.md`; the stack (Conduit +
mautrix-meta + rs-router) runs on the homelab VM via
`deploy/docker-compose.matrix.yml`.

Two automations now share one Facebook account, so the design keeps them from
colliding:

- **Identity.** The FB Marketplace thread id is the join key across all three
  surfaces — the coordinator `threads` row, the mautrix-meta portal (its
  `m.bridge` room state), and the legacy scraper's `/marketplace/t/<id>`. So the
  bridge and `rs-messenger` reporting the same message dedupe by fingerprint,
  and a thread's Matrix room and Telegram topic are remembered on its row
  (`matrix_room_id`, `telegram_topic_id`).
- **Sending.** Outbound replies are partitioned by `transport`: `rs-router`
  drains only `matrix` rows, `rs-messenger` only `playwright` rows, so a reply
  is never sent twice. mautrix-meta is primary; the scraper is the fallback.
  Staff replies typed in a topic queue as `matrix`; `rsc msg reply --via
  playwright` forces the fallback when the bridge is down.
- **Behaviour, not protocol, is what gets an account banned.** Replies are
  human-authored and relayed verbatim, so their latency and wording stay human.
  No mass-send, and auto-reply stays off. The bridge keeps its own stable
  messenger.com session (never the Playwright jar), on the same residential IP.

The war room must be a **separate** Topics-enabled supergroup from the
listing-alert chat (`TELEGRAM_WARROOM_CHAT_ID`), for the same reason the
priority topics needed one: turning Topics on changes the chat id. The
coordinator sends per-buyer alerts there and long-polls it for staff replies —
the first time it reads Telegram rather than only writing to it.

[mautrix-meta]: https://github.com/mautrix/meta

## Tuning what gets found

Everything lives in `configs/master.toml`:

- `[item.*]` — search phrases, keyword/antikeyword filters, price bands. The
  `extra_prompt` on each item is what teaches the model that we are a
  commercial buyer, not a consumer; it is the highest-leverage knob for
  precision.
- `rating` (default 4) — the AI score needed to alert. Lower it to 3 for a
  wider net, raise to 5 for only standout deals.
- `min_seller_rating` (4.5) — Facebook's own rating of the seller, out of 5.
  Below it the listing is dropped before the AI is asked. The rating comes
  from the listing page itself, so it costs no extra page visit.
- `exclude_unrated_sellers` (false) — whether a seller Facebook shows *no*
  rating for is dropped too. Off, and it should stay off: on Marketplace an
  unrated seller is the ordinary private seller who has never completed a
  tracked sale, not a bad one. Turning it on discards most of the fleet's
  catch. Skips are logged as `seller_rating` / `seller_unrated`.
- `search_interval` / `max_search_interval` — pacing. Do not go below ~30m.

After editing, regenerate worker configs with `rsc gen-configs` and restart the
workers.

### Daily keyword review

A launchd job on the Mac runs each morning at 08:00. It pulls the last 24h of
the live monitor's log from the homelab VM (`docker logs --since 24h rs-monitor`
over `ssh jinhu@10.10.10.73`, saved as `logs/monitor-live.log`;
`RS_MONITOR_HOST` / `RS_MONITOR_CONTAINER` override the host and container) and
writes `reports/keywords-<date>.md`: a review of which phrases are earning their
slot, which listings the gates are silently dropping, and where the fleet has
drifted from `master.toml`. It is **report-only**: it never edits configs,
never runs `rsc gen-configs`, and never touches a worker. When the VM or the
container cannot be read, it fails rather than review a stale local log.

```bash
scripts/eval-keywords.sh            # run it now, last 24h
scripts/eval-keywords.sh 72         # a wider window
```

The plist hardcodes the main checkout,
`~/Development/recycle_servers/recycle_servres_erp/trackers/facebook`, so install
it from there:

```bash
cp ~/Development/recycle_servers/recycle_servres_erp/trackers/facebook/deploy/com.recycleservers.keyword-eval.plist \
    ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.recycleservers.keyword-eval.plist
```

Two pieces, so the measuring is separable from the judging:

- `scripts/eval-keywords.py` does the counting — unwraps Rich's line wrapping,
  attributes skips to items, recomputes which antikeyword actually matched a
  title (the log prints the whole rule list, not the term that fired), and
  diffs `master.toml` against `configs/generated/`. Needs 3.11+ for `tomllib`,
  so it runs under `.venv-aimm/bin/python`.
- `scripts/eval-keywords.prompt` is the reviewer's brief. It carries the rules
  this project already paid for — the title-only gate, "lot" pulling in pickup
  trucks, bare brands being unusable — so the report argues from measurement
  instead of re-deriving them. Edit this to change what the review looks for.

The raw evidence is kept beside each report as `reports/evidence-<date>.md`, so
any claim can be traced back. Both are pruned after 60 days.

**The refusal table in older reports ranks nothing.** `Failed to get search
results` was logged unconditionally after every search — 110 of 110 cycles —
so it counted how often a phrase was searched, not whether Facebook refused it.
Fixed on 2026-08-20: the line now fires only when a search really came back
empty, and carries a `search_empty` event. Reports written before that date
still show the flat distribution, and a phrase in one of them is dead only once
a probe confirms it.

### Daily search probe

The keyword review reads the log; this reads Marketplace. A launchd job at 07:45
opens the fleet's own search URL in a browser — built by the monitor's
`build_search_url`, parsed by the monitor's result-page parser, filtered by the
monitor's title gate — and writes `reports/search-probe-<date>.md`: how many
results came back, how many were rejected without opening a page, and the
position at which Facebook stopped matching the query. Report-only, like the
review, and pruned after 60 days.

```bash
scripts/probe-search-url.sh                                   # one phrase per item
scripts/probe-search-url.py --item server_ram --city dc \
    --phrase "samsung micron sk hynix ram"                    # one specific search
scripts/probe-search-url.py --all-phrases                     # everything, slow

# Like the keyword review's plist, this one hardcodes the main checkout.
cp ~/Development/recycle_servers/recycle_servres_erp/trackers/facebook/deploy/com.recycleservers.search-probe.plist \
    ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.recycleservers.search-probe.plist
```

It exists because "the URL looks right in my browser" and "the log is full of
laptops" were both true at once, and only a probe that shares the monitor's own
code can tell you which half of the pipeline is at fault. Each run costs one
full result page per phrase in Facebook traffic, so keep the phrase count small.

## Upstream patches

`ai-marketplace-monitor` is a vendored upstream checkout. Our changes are on the
`recycle-patches` branch, kept deliberately small so upstream merges stay easy:

| Change | Files |
| --- | --- |
| Session auth — restore `storage_state`, present the session's pinned user agent, and fail with an actionable error rather than searching logged out. A worker that cannot log in — no session file, a lapsed one, or a password login stuck on a checkpoint — parks on that page until a session lands or an operator finishes it in Watch | `utils.py` (`MonitorConfig.storage_state_path`), `marketplace.py` (`create_page`, `save_storage_state`, `get_session_user_agent`), `facebook.py` (`login`, `is_logged_in`) |
| TOTP 2FA auto-fill + "trust this device", for the optional password fallback | `facebook.py` (`handle_two_factor_auth`, `trust_this_device`) |
| Coordinator notification channel | `coordinator_notify.py` (new), `user.py` (registered on `UserConfig`) |
| Collect search results while scrolling. Marketplace unmounts cards that scroll out of view, so parsing after the scroll returned the tail of the ranking (ranks 56-115 of 115, none of the top 24) and dropped the best matches | `facebook.py` (`FacebookSearchResultPage._parse_visible_listings`, `get_listings`) |
| `title_prefilter` — reject a listing on its title before fetching its detail page, exempting titles too terse to judge | `facebook.py` (`FacebookMarketItemCommonConfig.title_prefilter`, `check_listing`) |
| One search URL builder, so a probe and the monitor cannot drift; per-city options no longer leak into the next city's URL | `facebook.py` (`base_search_options`, `city_search_options`, `build_search_url`) |
| Per-listing alert verdict, so a Telegram inbox can be reconciled against the scraper. `User.notify` returns whether the send succeeded instead of `None`, and the notify log line reports the outcome rather than announcing success before checking it | `monitor.py` (`[Alert]` line, `listing_alert` event), `user.py` (`notify`), `notification.py` (`_execute_with_retry`) |
| A 30-result floor on the scroll loop: below it, insist on more quiet rounds before believing a short result list, since a stalled loader and a finished search look identical | `facebook.py` (`MIN_RESULTS_BEFORE_STOP`, `get_listings`) |
| `Failed to get search results` fires only on an actually empty result set | `facebook.py` (`search`) |
| Structured AI verdict — the single evaluation call answers with one JSON object (rating, numeric `unit_count`, `count_phrase`, summary) parsed by a shared tolerant parser with a legacy two-line fallback; the AI cache key is versioned; a confident single-unit listing is suppressed in code whatever its score; exhausted retries raise instead of crashing unbound; an AI outage fails closed — unevaluated listings are withheld and re-scanned, with a one-time "AI evaluation DOWN" / "recovered" Telegram ops note per incident; the coordinator payload carries `ai_count`; completions are capped at a configurable `max_tokens` (default 8192) so OpenRouter prices the request at the cap, not the model's 65k output ceiling | `ai.py` (`AIResponse`, `parse_ai_answer`, both backends), `monitor.py` (unit-count gate, loud fail-open), `coordinator_notify.py` (`ai_count`) |
| Rich Telegram listing alert (price, location, Count, AI rating, summary) and a configurable `min_unit_count` (default 2, i.e. only a confident single unit is suppressed; `master.toml` sets 5) | `notification.py` (`_listing_alert`), `marketplace.py` (`min_unit_count`), `monitor.py` (gate) |
| Listing details moved to the END of the AI prompt, after all static instruction text, so every call for the same item shares an identical prefix and provider-side prompt caching (OpenAI engages at 1024+ prefix tokens) discounts the instruction block on every call after the first | `ai.py` (`get_prompt`) |
| Priority-grouped alerts — the AI's `unit_count` buckets each alert (🔥 high 50+, ⚡ medium 10-49, 🐢 low 5-9), the emoji prefixes the title, and Telegram routes each bucket to its own forum topic (`telegram_topic_high/medium/low` = `message_thread_id`s, shown as the group's sidebar; create them with `scripts/setup-telegram-topics.py`). Unset topics and uncounted listings fall back to the General topic | `notification.py` (`alert_priority`, `PRIORITY_EMOJI`, `notify`), `telegram.py` (`telegram_topic_*`, `_topic_for_priority`), other backends accept and ignore `priority` |
| The sweep counter stays out of the AI cache key — `ItemConfig.searched_count` increments every sweep and was hashed into `item_config.hash`, rotating the AI-verdict cache key so it never hit across sweeps and every lingering listing was re-billed each sweep (~10× spend, measured 43k evals / 4k unique listings over 3 days); the `ai_eval` event now also reports `cached` so spend is auditable | `marketplace.py` (`ItemConfig.hash`), `monitor.py` (`ai_eval` event) |
| Alert delivery report — each successfully sent Telegram alert's `message_id` (captured from the Bot API response, previously discarded) is POSTed fail-open to the coordinator's `/v1/alerts/telegram` with the listing id, search city/phrase, priority topic and AI verdict, so partner emoji reactions can be joined back to listings for the alert hit rate. Off unless `alert_report_url`/`alert_report_token` are set; a timed-out send (delivered-unknown, no Message) reports nothing by design | `telegram.py` (`_sent_messages` capture, `_after_listing_alert`, `_post_alert_report`, `alert_report_*` fields), `notification.py` (`_after_listing_alert` hook in `notify`) |
| Live re-login — a second daemon thread polls `/v1/workers/{id}/directives` every 10 s (`directive_poll_interval`), dropping to every 60 s after three failed polls so an older coordinator costs little, and each login step is reported at once as a heartbeat carrying `login_step`/`login_step_at`, so the ERP's Watch page can follow a re-login as it runs | `facebook.py` (`_on_directives`, `_directive_loop`, `_report_login_step`, `login`, `relogin_now`), `control_plane.py` (`poll_directives`) |
| Session kept in step between sweeps — while idle, the worker checks its browser's login every minute (`session_check_s`). A logged-in browser the console thinks is expired, parked or not, is saved, backed up and reported HEALTHY; a HEALTHY session that lapses is reported SESSION_EXPIRED, without navigating the page. An idle, logged-in session is re-saved and backed up every 30 minutes (`session_save_s`), and SIGTERM (`docker stop`, a redeploy) saves the live session before exit. `save_storage_state` still refuses a logged-out jar | `facebook.py` (`session_check_due`, `check_session`, `save_storage_state`, `stop`), `monitor.py` (`_relogin_pending`, `_check_sessions`), `cli.py` (SIGTERM handler) |
| Heartbeat repeater — the first `report_state` starts a daemon thread that re-sends the last reported state to the coordinator every 5 minutes (`heartbeat_interval`). Before this a worker heartbeated once per search, at the top of `search()`, and one sweep over the city list runs for hours, so a healthy worker spent most of the day looking silent. The repeater only restates what the main thread last said (it never touches the Playwright page, which is not thread-safe); the login is still re-checked only at the top of each search | `facebook.py` (`heartbeat_interval`, `report_state`, `_send_heartbeat`, `_heartbeat_loop`, `stop`) |

| System faults page once, fleet-wide — an AI outage is declared only after `RS_INCIDENT_DOWN_AFTER` (3) straight failed evaluations and cleared after `RS_INCIDENT_UP_AFTER` (3) straight successes, and the crossing is POSTed to the coordinator's `/v1/incidents`, which dedupes across every worker (one DOWN page per key per `RS_INCIDENT_COOLDOWN_HOURS`, one recovered note per paged DOWN). Without a control plane, or when it is unreachable, a local gate applies the same one-per-cooldown rule to this process. Replaces the per-process flag that sent a DOWN/recovered pair for every listing while OpenRouter flapped | `ops_incidents.py` (new: `OutageTracker`, `LocalIncidentGate`), `monitor.py` (`_report_incident`, `evaluate_by_ai`), `control_plane.py` (`report_incident`) |
| Funnel counts — each search page, card, title-gate pass, real page visit, keyword-gate pass, not-yet-alerted listing, fresh AI verdict and delivered alert is counted into a buffer and POSTed to `/v1/stats/reviews` once per search page (previously one POST per verdict and one per alert), feeding the ERP's search-to-alert card; the report that counts a search names its `search_city`, which colors the cities searched today on the ERP's fleet fold | `facebook.py` (`count_stage`, `flush_stage_counts`, `_examine_listings`), `monitor.py` (`_count_stage`), `marketplace.py` (`count_stage`), `control_plane.py` (`report_review_stats`) |

Before pulling upstream, rebase that branch rather than merging into it, then
refresh the pin with `scripts/check-vendor.sh update`.

## Version control

This tree lives at `trackers/facebook/` in the ERP monorepo
(`JinhuW/recycle_servres_erp`), and its releases are tagged
`facebook-tracker/vX.Y.Z`, kept apart from the ERP's own `v*` tags. Releases are
judged on this subtree alone — ERP commits and edits elsewhere in the repo never
block one. It was imported on 2026-10-16 from the now-archived
`JinhuW/facebook_tracker` with its history rewritten, so commit hashes cited
before then resolve only in that archived repo.

Only the locally-authored tree is tracked. The two vendored projects —
`ai-marketplace-monitor` and `facebook-marketplace-bot` — are separate git
checkouts, gitignored here; [VENDOR.md](VENDOR.md) says which commit of each a
given release expects, and why they are kept separate. The vendored monitor has
no remote of ours: `recycle-patches` must never be pushed to
`ai-marketplace-monitor`'s `origin`, which is the upstream author's repository.

Two guards run on demand and again on every release:

```bash
scripts/check-vendor.sh           # do the vendored checkouts match VENDOR.md?
scripts/check-vendor.sh update    # ... they were meant to move; re-pin them
scripts/check-secrets.sh          # would this commit leak a credential?
scripts/check-secrets.sh --all    # ... check every tracked file
```

`check-secrets.sh` scans for credential paths and for credential-shaped content.
It skips test fixtures deliberately — a suite needs a password-shaped string on
every other line, and a scanner that cries wolf is one people learn to bypass
with `--no-verify`. For anything else it is wrong about, append `pragma:
allowlist secret` to the line. It has a test of its own
(`scripts/tests/test-check-secrets.sh`) that plants real-shaped secrets and
demands they be caught, which is how it was found to miss a Playwright
`storage_state` file entirely.

## Releases

One version covers the whole system: the coordinator, the poster, the configs,
and the pinned revision of the vendored monitor. They only ever ship together,
so versioning them apart would just make "what is deployed?" harder to answer.
[CHANGELOG.md](CHANGELOG.md) is the record; `VERSION` and both `pyproject.toml`
files are kept in step by the release script, and `rsc --version` reports it
from the running process rather than from whatever is checked out locally.

```bash
# Write what changed under [Unreleased] in CHANGELOG.md first, then:
scripts/release.sh --dry-run minor   # run every check, change nothing
scripts/release.sh minor             # bump, changelog, commit, tag
scripts/release.sh 0.4.2             # or an exact version
```

While the major version is `0`, a **minor** bump carries a breaking change —
which here almost always means *the fleet will not come up until you do
something*: a renamed environment variable, configs that must be regenerated, a
credential no longer accepted. Those go under **Breaking** in the changelog with
the command to run.

The script refuses to tag when the bump does not move `VERSION` (or moves it
backwards), when the tree is dirty, when `[Unreleased]` is empty, when a
vendored checkout has drifted from its pin or has uncommitted work, when
`configs/generated` is not what `rsc gen-configs` produces, or when any suite
fails. That list is not defensive padding — a release that quietly ships stale
shards brings the fleet up healthy and searching the wrong cities, which is the
most expensive way this project can fail.

## Tests

```bash
AIMM_PYTHON=$PWD/.venv-aimm/bin/python \
    .venv-coordinator/bin/python -m pytest \
    rs_coordinator/tests rs_poster/tests rs_messenger/tests

# The vendored monitor has its own venv. test_facebook.py needs
# pytest-playwright, which the runtime environment does not install.
.venv-aimm/bin/python -m pytest ai-marketplace-monitor/tests \
    --ignore=ai-marketplace-monitor/tests/test_facebook.py
```

`AIMM_PYTHON` is what lets `rs_coordinator/tests` validate every generated
worker config against the monitor's real loader, in the monitor's own
environment. Without it those tests skip, and a config that the fleet cannot
load passes CI — the generator prints `wrote ...` and exits 0 either way.

`scripts/release.sh` runs all three suites, so the fastest way to check
everything at once is `scripts/release.sh --dry-run patch`.

## Constraints worth knowing

- **Facebook has no want-to-buy listing type.** Buy ads are ordinary item
  listings worded as buy ads (with a placeholder price), optionally shared into
  local buy/sell groups. Expect occasional removals.
- **Automating Marketplace violates Facebook's ToS.** Accounts get
  checkpointed or banned. Use dedicated accounts, one per IP, keep the pacing
  limits in `ads.toml` and `master.toml` conservative, and treat every worker
  account as replaceable.
- **Selectors break.** The poster's are centralized in
  `rs_poster/rs_poster/selectors.py`; run `rs-poster post --dry-run` after any
  Facebook UI change. Worker accounts must be set to English (US).
- **AGPL-3.** Internal use imposes no obligations. `rs_coordinator` and
  `rs_poster` are separate processes talking over HTTP; keep it that way and do
  not distribute the patched monitor.
