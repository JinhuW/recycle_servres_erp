# facebook_tracker

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
TypeScript trackers elsewhere in this workspace.

## Layout

| Path | What it is |
| --- | --- |
| `ai-marketplace-monitor/` | Upstream monitor engine (AGPL-3). Our changes live on the `recycle-patches` branch — see below. |
| `facebook-marketplace-bot/` | Reference only. Stale Selenium; never run it. Its posting flow was reimplemented in `rs_poster`. |
| `rs_coordinator/` | Coordinator service (FastAPI + SQLite) and the config sharding generator. CLI: `rsc`. |
| `rs_poster/` | Buy-ad poster (Playwright). CLIs: `rs-poster`, and `rs-session` for password-free Facebook sessions. |
| `rs_messenger/` | Marketplace inbox bridge (Playwright). CLI: `rs-messenger`. Reports conversations to the coordinator, which routes them to Telegram and queues (optional, default-off) auto-replies for it to send. |
| `configs/` | `master.toml` (what the fleet searches), `fleet.toml` (which VM searches where), generated per-worker shards. |
| `deploy/` | Docker Compose files and the per-node bringup checklist. |
| `scripts/` | Deploy, measurement probes, and the release/vendor/secret checks. |
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

No Facebook password is stored anywhere in this system. Each account is logged
into once by hand, and the resulting browser session is what the fleet uses.

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
nothing is sent anywhere.

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

`configs/secrets.env` and `configs/sessions/` are never pushed. The VM's copies
are live credentials — the worker's Facebook cookies and its coordinator token
— and the laptop's belong to a different account and IP.

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

### Watching the browser

The homelab monitor drives a real Chromium on a virtual display, and you can
watch it live — the fastest way to tell a selector break apart from a
checkpoint, an empty result page, or a session that quietly logged out.

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
rsc msg reply <thread-id> "On our way — does Saturday work?"
rsc msg claim <thread-id>          # fence auto-reply out of a conversation
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

A launchd job reads the last 24h of `logs/monitor.out.log` each morning at 08:00
and writes `reports/keywords-<date>.md` — a review of which phrases are earning
their slot, which listings the gates are silently dropping, and where the fleet
has drifted from `master.toml`. It is **report-only**: it never edits configs,
never runs `rsc gen-configs`, and never touches a worker.

```bash
scripts/eval-keywords.sh            # run it now, last 24h
scripts/eval-keywords.sh 72         # a wider window

cp deploy/com.recycleservers.keyword-eval.plist ~/Library/LaunchAgents/
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

cp deploy/com.recycleservers.search-probe.plist ~/Library/LaunchAgents/
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
| Session auth — restore `storage_state`, present the session's pinned user agent, and fail with an actionable error rather than searching logged out | `utils.py` (`MonitorConfig.storage_state_path`), `marketplace.py` (`create_page`, `save_storage_state`, `get_session_user_agent`), `facebook.py` (`login`, `is_logged_in`) |
| TOTP 2FA auto-fill + "trust this device", for the optional password fallback | `facebook.py` (`handle_two_factor_auth`, `trust_this_device`) |
| Coordinator notification channel | `coordinator_notify.py` (new), `user.py` (registered on `UserConfig`) |
| Collect search results while scrolling. Marketplace unmounts cards that scroll out of view, so parsing after the scroll returned the tail of the ranking (ranks 56-115 of 115, none of the top 24) and dropped the best matches | `facebook.py` (`FacebookSearchResultPage._parse_visible_listings`, `get_listings`) |
| `title_prefilter` — reject a listing on its title before fetching its detail page, exempting titles too terse to judge | `facebook.py` (`FacebookMarketItemCommonConfig.title_prefilter`, `check_listing`) |
| One search URL builder, so a probe and the monitor cannot drift; per-city options no longer leak into the next city's URL | `facebook.py` (`base_search_options`, `city_search_options`, `build_search_url`) |
| Per-listing alert verdict, so a Telegram inbox can be reconciled against the scraper. `User.notify` returns whether the send succeeded instead of `None`, and the notify log line reports the outcome rather than announcing success before checking it | `monitor.py` (`[Alert]` line, `listing_alert` event), `user.py` (`notify`), `notification.py` (`_execute_with_retry`) |
| A 30-result floor on the scroll loop: below it, insist on more quiet rounds before believing a short result list, since a stalled loader and a finished search look identical | `facebook.py` (`MIN_RESULTS_BEFORE_STOP`, `get_listings`) |
| `Failed to get search results` fires only on an actually empty result set | `facebook.py` (`search`) |
| Structured AI verdict — the single evaluation call answers with one JSON object (rating, numeric `unit_count`, `count_phrase`, summary) parsed by a shared tolerant parser with a legacy two-line fallback; the AI cache key is versioned; a confident single-unit listing is suppressed in code whatever its score; exhausted retries raise instead of crashing unbound; an AI outage still fails open but logs at ERROR; the coordinator payload carries `ai_count`; completions are capped at a configurable `max_tokens` (default 8192) so OpenRouter prices the request at the cap, not the model's 65k output ceiling | `ai.py` (`AIResponse`, `parse_ai_answer`, both backends), `monitor.py` (unit-count gate, loud fail-open), `coordinator_notify.py` (`ai_count`) |
| Rich Telegram listing alert (price, location, Count, AI rating, summary) and a configurable `min_unit_count` (default 2, i.e. only a confident single unit is suppressed; `master.toml` sets 5) | `notification.py` (`_listing_alert`), `marketplace.py` (`min_unit_count`), `monitor.py` (gate) |

Before pulling upstream, rebase that branch rather than merging into it, then
refresh the pin with `scripts/check-vendor.sh update`.

## Version control

This repository tracks the locally-authored tree. The two vendored projects —
`ai-marketplace-monitor` and `facebook-marketplace-bot` — have their own git
repositories and are gitignored here; [VENDOR.md](VENDOR.md) says which commit
of each a given release expects, and why they are kept separate.

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

Neither repository has a remote. Give this one a private remote before treating
a clone as enough to redeploy from — and note that `recycle-patches` must never
be pushed to `ai-marketplace-monitor`'s `origin`, which is the upstream author's
repository.

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

The script refuses to tag when the tree is dirty, when `[Unreleased]` is empty,
when a vendored checkout has drifted from its pin or has uncommitted work, when
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
