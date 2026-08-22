# Changelog

What changed in the Facebook Marketplace tracker, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions are [semantic](https://semver.org/spec/v2.0.0.html). While the major
version is `0`, a **minor** bump is what carries a breaking change — and here
"breaking" mostly means *the fleet will not come up until you do something*: a
renamed environment variable, a config that must be regenerated, a credential
that is no longer accepted. Those are called out under **Breaking** with the
command to run, because a worker that silently keeps running while doing less is
this project's most common failure mode.

One version covers the whole system — the coordinator, the poster, the configs,
and the pinned revision of the vendored monitor (see [VENDOR.md](VENDOR.md)).
They only ever ship together, so versioning them apart would only make "what is
deployed?" harder to answer.

## [Unreleased]

### Added

- **The Messenger bridge.** A buyer replying to a buy ad was invisible to every
  line of code in this tree; now the conversation reaches the same Telegram
  chat as the listing alerts, and can be answered without opening Facebook.
  - New package `rs_messenger` (CLI `rs-messenger`): `poll` reads the N most
    recent Marketplace conversations with the same saved session the poster
    uses — and the same account lock, so one account never posts and messages
    at once — reports thread snapshots to the coordinator, then fetches queued
    replies and types them into the conversation, paced at no more than one
    send per minute and verified to appear in the pane before being acked.
    `run` polls on a jittered interval and stops outright on a checkpoint or
    expired session rather than retrying Facebook. `poll --dry-run` prints
    exactly what the selectors extracted without touching the coordinator or
    the composer — the drift check for the least stable DOM this project reads.
  - Coordinator message store and routes (`/v1/messages/sync`,
    `/v1/messages/outbound`, `/v1/threads/...`): thread snapshots are
    deduplicated by message fingerprint the same way listings are by item id,
    so re-reporting a whole inbox every poll is free; each *new* inbound
    message becomes a Telegram alert through the durable outbox. Message
    direction is read from Facebook's own "You sent" markers and defaults to
    incoming when unsure: a false "in" costs one redundant alert, a false
    "out" would suppress a real one.
  - Auto-reply, **off by default** (`RS_AUTOREPLY_ENABLED=1` to arm): at most
    one templated reply per thread ever, only when no outgoing message exists,
    never on a thread an operator claimed, capped per rolling day
    (`RS_AUTOREPLY_MAX_PER_DAY`, default 20) and confined to waking hours
    (`RS_AUTOREPLY_HOURS`, default 14-04 UTC ≈ 8am-10pm Denver). Every queued
    auto-reply is announced in the Telegram chat, because silent automation is
    how a bot talks to a seller for a week before anyone notices.
  - Operator console: `rsc msg threads / show / reply / claim`. Replying
    claims the thread, which permanently fences auto-reply out of it.
- **A durable alert outbox.** Every Telegram alert — listings, Messenger,
  liveness — is now written to the database in the same request that decided
  to alert, and delivered by a background sender with exponential backoff
  (5 s doubling to a 15-minute ceiling, retried until delivered, surviving
  restarts). Previously the send happened inline and exactly once: a Telegram
  outage silently cost every match found during it, because the listing was
  already recorded and classified as a duplicate forever after. `/healthz` and
  `rsc status` report the undelivered backlog; `notified_at` now means "the
  alert actually reached Telegram".
- **Dead-worker detection.** The background loop sweeps worker liveness every
  ten minutes and pages the ops chat once when a worker crosses into DEAD
  (six hours of silence), once more when it recovers. Heartbeat-transition
  alerts could never catch this: a dead worker sends no heartbeat to react to.
- README sections for version control and releases: what the vendor pin and the
  credential scanner are for, and what `scripts/release.sh` refuses to tag. The
  test command now shows `AIMM_PYTHON`, without which the generated worker
  configs are never validated against the monitor's real loader and a config the
  fleet cannot load passes anyway.

### Changed

- `POST /api/v1/listings` responds with `queued` (alerts handed to the outbox)
  instead of `notified` (alerts sent inline, which no longer happens in the
  request). Workers do not parse the field; the tests do.
- The coordinator opens its database on first use instead of at import.
  Before, a Postgres unreachable at boot failed the module import and the
  container restart-looped with nothing answering `/healthz` to say why.
- The SQLite default path is anchored to the checkout (`<repo>/data/
  coordinator.db`) instead of the current working directory, which had already
  produced two divergent databases — one from running `rsc` inside
  rs_coordinator/, one from the repo root. `RS_COORDINATOR_DB` still wins.

### Fixed

- **The worker treated any 2xx from the coordinator as delivery** and cached
  the whole batch as NOTIFIED, even when the response body said `failed > 0` —
  those listings had reached neither storage nor Telegram and were never
  re-sent. A batch with failures now stays unmarked and is re-sent next scan,
  which the coordinator's dedupe makes free. (Vendored monitor patch; pin
  updated.)
- **A big batch could outlive the worker's own timeout.** The notifier's
  1 msg/sec pacing ran inside the request handler, so ten new listings held
  the HTTP request 11+ seconds against the worker's 10 s budget; the worker
  timed out and retried work that had succeeded. Pacing now happens on the
  background sender, and ingest returns immediately.
- **The poster could save a logged-out session over a good one** — the same
  0.2.0 monitor bug, still live on the poster side. Saves are refused unless
  the browser is logged in, and every credential/ledger write (session file,
  sidecar, ads/state.json, `--save-refreshed`) goes via temp file + rename so
  an interrupted write cannot truncate it.
- **A publish whose confirmation never appeared was recorded as a live
  listing**; the next renew then deleted-and-reposted against a phantom. It is
  now a hard failure with a screenshot, and the attempt still counts against
  pacing so a retry loop cannot hammer the account.
- **Renewing an ad could delete the wrong city's listing**: titles are
  identical across cities and delete clicked the first title match. The match
  is now verified against the city on the listing card, and deletion is
  refused when no single candidate verifies (renew already skips the repost on
  a failed delete, the safe direction).
- **A mid-run checkpoint or "You're Temporarily Blocked" interstitial**
  surfaced as an opaque selector timeout. Detected after navigation now and
  raised as `AccountRestrictedError` (exit 4); an expired session likewise
  prints its `rs-session` instructions instead of a traceback (exit 3).
- A hard-killed poster run left a lock file that failed every future run with
  exit 2. The lock's PID is probed for liveness and a dead holder's lock is
  broken with a log line naming it.
- Every poster `page.goto` ran with `timeout=0`, so a Facebook hang was a hung
  process holding the account lock. Navigations are bounded at 90 s. (The
  monitor's equivalent hang — ten hours on one item page, measured 2026-08-21 —
  is fixed in the vendored patch set the pin now points at.)
- A garbled `totp_digits`/`totp_period` in a session sidecar raised a bare
  `ValueError` that skipped every `TotpError` handler.
- Poster failure screenshots landed in whatever cwd the run started from; they
  default to `<ads-dir>/screenshots` now.
- A Telegram failure other than a network error (e.g. `BadStatusLine`) escaped
  the notifier and could 500 the rest of a listing batch; the notifier's
  contract is now genuinely "returns False, never raises".
- The 403 for a fleet-token request to the code endpoints named a `rsc worker
  token` command that does not exist; it now says `rsc mint-token --worker`.
- A coordinator test read `AIMM_PYTHON` unguarded and failed collection when it
  was unset — which `release.sh` treats as a failed suite — instead of
  skipping like its siblings.
- POSTGRES.md still documented the "CLI uses SQLite while the server uses
  Postgres" gap that was fixed before 0.2.0; the section would have sent an
  operator down a wrong path mid-incident.


## [0.2.0] - 2026-08-21

### Breaking

These three need an action before the fleet comes back up. Each of them
otherwise fails the way this project fails worst — quietly, with every container
reporting healthy.

- **Workers now read `RS_CONTROL_PLANE_TOKEN`**, not `RS_WORKER_TOKEN_<SLUG>`.
  The derived name could never be set from `docker-compose.worker.yml` at all,
  because Compose has no string functions and cannot build
  `RS_WORKER_TOKEN_NE_1` out of `${WORKER_ID}` — so it was unset on every
  worker, and an unset `${VAR}` in the TOML degrades to `None` with nothing but
  a Python warning. The whole control plane was off fleet-wide: no heartbeat, no
  automatic 2FA, no captcha escalation, no session backup.
  *Set `RS_CONTROL_PLANE_URL` and `RS_CONTROL_PLANE_TOKEN` on each worker VM
  (`rsc mint-token --worker <id>`), then `rsc gen-configs`.* The compose file now
  refuses to start without them.

- **The fleet-wide `RS_COORDINATOR_TOKEN` is no longer accepted on
  `/v1/auth/code` or `/v1/auth/credentials`.** Use a per-worker token.

- **Every `[region.*]` block changed**, so the generated shards did too.
  *Run `rsc gen-configs`.* It now refuses to write if any city in
  `[marketplace.facebook].search_city` is in no region (`--allow-gaps` to
  override).

### Security

- The fleet-wide token could name any `account_id` and be handed that account's
  live TOTP code, or its Facebook password wherever `allow_password_login` was
  set. Every worker container is required to hold that token for the listing
  channel, so one compromised VM was a key to every account in the vault —
  despite `rsc mint-token` promising the opposite. Both routes now require a
  per-worker token, which is what `session.restore` had always required and for
  the same stated reason.
- `terraform destroy` can no longer take the account-vault database with it. The
  provider bug documented in `infra/README.md` leaves that resource tainted after
  a normal apply, and a plain `apply` on a tainted resource replaces it — so
  `prevent_destroy` is a live guard, not a hypothetical one.
- A vault entry of `"----"` minted a plausible six-digit TOTP code instead of an
  error: the separators were stripped, the empty string base32-decoded happily,
  and HMAC over an empty key produces six perfectly ordinary digits.

### Fixed

- **The saved Facebook session could be overwritten with a logged-out one.** The
  per-cycle save added for cookie freshness fires on a timer, not only after a
  successful login, so the first sweep after Facebook expired a session wrote an
  empty cookie jar over a file that costs a human login with a 2FA code to
  recreate. It now refuses to write from a context that is not logged in, and
  writes via a temp file and rename so an interrupted save cannot truncate it
  either.
- **An expired session killed the whole process**, taking the other items, the
  web UI, the log shipper and the heartbeat with it — and under `restart:
  unless-stopped` that became a loop opening a fresh browser at Facebook every
  few seconds, the exact pattern the saved-session design exists to avoid. It is
  now a typed error the monitor loop catches, and the worker stops retrying a
  login it already knows will fail until the session file changes.
- **Two workers reporting the same border listing both alerted**, and the loser's
  insert raised a UNIQUE violation that 500'd the request — losing every listing
  after it in that batch, unrecorded and unalerted. Ingestion now decides newness
  by an atomic insert rather than a read that happened earlier. The aborted write
  also left an open transaction on the coordinator's single shared connection, so
  the next reader got "database is locked" until the process restarted.
- **Twenty of the twenty-eight measured search cities were in no region**,
  including Louisville and Columbus — the two added specifically because a
  listing in Louisville was missed for four days. The regions were four-city
  summaries relying on a wide radius, which was measured to do nothing: results
  are anchored to the city in the URL path, so 37 miles and 311 miles return
  identical results. The six regions are now the union of all 45 centres, split
  geographically so each still matches its proxy.
- **Generated worker configs predated essentially all of `master.toml`'s
  tuning** — search phrases the file says in capitals drag a query to zero
  results, antikeywords it removed for discarding the listings we now want, price
  bounds it deliberately has nowhere, and no `title_prefilter`, which cost every
  worker about 205 wasted detail-page fetches per sweep.
- **`vnc_url` produced a config the monitor could not load.** The generator had
  always written that key and the dataclass had no field for it, so the first
  worker to use the documented console URL simply would not start. It now reaches
  the heartbeat and the escalation, which is what lets an operator actually open
  a stuck browser.
- **A seller mentioning eBay had their listing discarded as an advertisement.**
  Affiliate detection matched Facebook's markers against the whole rendered page,
  so "cheaper than buy now on eBay" in a description read as Facebook's own buy
  button. It now matches the page's controls, and the verdict is cached instead
  of the page being re-fetched on every sweep of every city forever.
- **Keyword terms that do not start with a letter never matched anything.**
  `` in front of `+ecc` asks for a word character before the `+`, so
  `keywords = ["+ecc"]`, `antikeywords = ["$1"]` and `seller_locations =
  ["(remote)"]` all passed validation and were silently dead.
- **The scroll loop stopped early and logged it as a complete sweep.** Rounds
  where results arrived only via the scroll nudge — the common path, since a list
  already at the bottom fires no scroll event — counted as quiet, so the counter
  was past its threshold before the first genuinely quiet round arrived.
- **One unreachable coordinator froze the browser for 6.5 minutes per matched
  listing** (over two hours for a twenty-match sweep, by which time the search
  page has aged out), because the alert POST inherited five retries a minute
  apart. Now ~36 seconds worst case. A 4xx is a refusal, not an outage, so it is
  no longer retried, and `coordinator_token` is required — the coordinator 401s
  every request without one, so a typo'd token failed every alert forever behind
  a single warning.
- **`rs-session import` stamped every Netscape session cookie with the epoch**,
  and Playwright discards those on restore. `cookies.txt` is text, so "no expiry"
  arrives as the string `"0"`, which is not the integer `0`. Facebook rotates
  precisely the session-scoped cookies, so an import silently lost its live half
  while `rs-session check` still passed on the persistent ones. `httpOnly` is
  carried through now too, rather than being hardcoded false on `xs` and `datr`.
- **The daily keyword report analysed a dead log.** It defaulted to the retired
  laptop agent's stdout, which is frozen at the migration and excluded from the
  deploy rsync, and anchored its window to the newest record in the file — so it
  re-analysed the same 19 hours every morning under a new date. It now fetches
  the live container log from the VM, and banners a stale one. Its `[Search]`
  regex had also drifted when the search phrase was added to that log line,
  over-reporting city coverage by the phrase count and matching the "default
  radius" form not at all.
- **The laptop watchdog would have restarted the retired monitor**, putting a
  second monitor on the same Facebook account behind the same NAT IP as the
  homelab container. Its staleness trigger has been permanently satisfied since
  the migration, so the first tick after a reboot would have done it. It now only
  restarts a monitor that is already running, never starts one.
- **A failed image build reported success.** `docker build … | tail -5` under
  `/bin/sh` with no `pipefail` exits with `tail`'s status, so the deploy went on
  to `--force-recreate` the live monitor onto the previous image.
- **`/healthz` answered `ok` with a dead database**, which is the only thing the
  container healthcheck asks. It now touches the database and answers 503 when it
  cannot.
- An unreachable mail host wedged a Starlette threadpool thread forever; the IMAP
  connection has a timeout.
- **Five `rs-session` 2FA tests failed for three seconds out of every thirty.**
  They read the real clock, and `_autofill_two_factor` deliberately declines a
  code with three seconds or less left in its window. Because the suite runs in
  under a tenth of a second, a run landed either wholly inside that dead zone or
  wholly outside it — so it did not present as flakiness, it presented as a
  broken suite that was fine again a minute later. The clock is pinned
  mid-window now; the guard keeps its own dedicated test.

### Added

- `scripts/release.sh` — verify, bump, changelog, commit, tag. It refuses to tag
  a tree whose generated shards are not what `gen-configs` produces, whose
  vendored checkout does not match its pin, or whose `[Unreleased]` section is
  empty.


## [0.1.0] - 2026-08-20

First tagged version: the system as it stood when it went under version
control, already running against live Facebook accounts. Recorded as a baseline
rather than reconstructed — the entries below say what exists, not what changed.

### Added

- **Coordinator** (`rs_coordinator`, CLI `rsc`) — FastAPI service that ingests
  matched listings from the fleet, dedupes them by Facebook item id so a
  listing visible from two adjacent regions still produces exactly one alert,
  and owns the single Telegram alert stream. SQLite by default, Postgres when
  `RS_DATABASE_URL` is set.
- **Control plane** — an encrypted account vault (Fernet), per-worker bearer
  tokens (HMAC of one rotatable secret), TOTP code minting, IMAP polling for
  emailed login codes, captcha/checkpoint escalation to a human, and encrypted
  session backups. Workers hold no account secret of their own.
- **Config sharding** (`rsc gen-configs`) — generates one monitor config per
  worker from `configs/master.toml` + `configs/fleet.toml`, pinning each worker
  to exactly one region. No runtime dispatch, no random city selection.
- **Poster** (`rs_poster`, CLIs `rs-poster` / `rs-session`) — publishes "we buy
  used server hardware" ads and reposts them on a paced schedule; `rs-session`
  creates and checks the password-free Facebook sessions everything else runs
  on.
- **Deployment** — Docker Compose for the coordinator, the homelab monitor and
  a fleet worker; Terraform for the Railway Postgres that backs the vault;
  `scripts/deploy.sh`, which proves the container is running the tree it just
  pushed by checksumming every module rather than trusting the build.
- **Measurement tooling** — `scripts/probe-search-url.py` and
  `scripts/check-cities.py` for testing a search URL or a city slug against a
  live session, and a daily keyword evaluation that mines the monitor log into
  an evidence pack. The conclusions live in `configs/master.toml`'s comments,
  which is why that file reads the way it does.

<!-- This repository has no remote yet (see VENDOR.md), so there is nothing to
     link a version to. Compare two releases locally with `git diff v0.1.0..v0.2.0`,
     or add the link definitions here once it has one. -->
