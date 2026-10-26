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

## [0.14.0] - 2026-10-25

### Added

- **`scripts/push-fleet-images.sh`** builds the fleet worker image and the
  ERP's fleet agent image for `linux/amd64` on the Mac and pushes them to the
  private GitHub Container Registry packages
  `ghcr.io/jinhuw/{aimm-recycle,fleet-agent}` (the OCI Container Registry
  repositories `sin.ocir.io/ax6usa8hwbie/...` are the fallback). It stamps `RS_VERSION` and `RS_MONITOR_COMMIT` the way `deploy.sh`
  does, refuses a monitor clone that is dirty or off the `VENDOR.md` pin, and
  refuses to push a tracker tree that is not a release; `--no-push` is a
  build-only dry run.
- **Fleet mode for the worker image** (RS-394, the ERP's fleet task queue;
  this is the worker's half, built against the plan's contract and tested
  against a fake fleet server until the ERP's backend lands).
  - **`rs_worker/entry.py`**, the image's new entrypoint. Without
    `RS_FLEET_URL`, `RS_FLEET_HOST_ID` and `RS_FLEET_HOST_TOKEN` it execs the
    image's command unchanged, so every compose worker runs as before. With
    them it claims an account from `POST /api/fleet/worker/claim`, renders
    `config.toml` (from `rs_worker/config.template.toml`), `session.json` and
    `identity.json` inside the container, hands the password fallback over as
    `RS_FB_PASSWORD` / `RS_FB_TOTP`, runs Xvfb, x11vnc and the monitor, serves
    `GET /healthz` on 8788, and leaves with the monitor's exit code: 75 for no
    slot or a stale epoch, 70 for a claim or configuration failure.
  - **`deploy/Dockerfile.worker`** builds that image from this folder (the
    monitor plus `rs_worker/`), with the entrypoint, the healthcheck and
    5900/8467/8788 exposed; `Dockerfile.worker.dockerignore` keeps secrets and
    venvs out of the build context. No `VOLUME`: the claimed session must die
    with the container.
  - **The monitor's `[fleet]` section** (`recycle-patches`, see README →
    *Upstream patches*): one login at boot, then `next-task` long-polls while
    the page is live and logged in, one city per task with the radius the
    task gives, `verify-slug` tasks that read Facebook's location label,
    heartbeats and task events to the fleet with the epoch, the session save
    uploaded to the pool, backoff with the session kept when the fleet is
    unreachable, exit 75 on a stale epoch without saving, and no own-list
    fallback. Nothing changes for a worker without the section.
  - **`rs_worker/tests/fake_fleet.py`**, a stand-in for the five worker
    routes with made-up data, which the entrypoint and monitor-loop suites run
    against (`.venv-aimm/bin/python -m pytest rs_worker/tests`).

- **The fleet worker dials the ERP's VNC relay** (`rs_worker/vnc_relay.py`,
  started by the entrypoint after the claim when the image has x11vnc). It
  parks one WebSocket at `GET {RS_FLEET_URL}/api/fleet/worker/vnc` with the
  worker token and sends nothing until the relay's `viewer` text frame says
  a manager's noVNC page is paired with it; only then does it dial the local
  x11vnc on 5900 and move bytes both ways as binary frames. A pair ends
  together, and a fresh socket is parked for the next viewer (1 s, or a
  backoff to 60 s while the ERP is unreachable). A 409 on the dial stops it
  for good; SIGTERM stops it with the monitor. It never touches the browser
  or the session, and dials the ERP directly, never through the account's
  proxy. Uses `websockets`, already in the image through the monitor's web
  UI. Needs the relay to send the `viewer` frame on pairing.
- **A stopping fleet worker hands its last result back.** On `docker stop`
  (SIGTERM, which the monitor's CLI turns into KeyboardInterrupt), an
  exception or a clean exit, a finished task waiting to be reported is sent
  once to `next-task` with `take: false` and `wait: 0`: the fleet closes it
  and leases nothing, answering `{task: null, reason: "done_only"}`. Before,
  the only way to report a result was the next ask, so the worker's last
  task stayed leased to a dead container until `lease_minutes` ran out. The
  call has an 8 s timeout and never logs in; a stale epoch skips it (its
  token is dead). A fleet that predates `take` would lease a task instead,
  which then simply expires. The fake fleet answers `take: false` as the
  ERP does.

- **A fleet worker that cannot reach Facebook or its proxy stops and waits
  for an operator.** Every container start is a login, so it neither
  retries nor exits. In fleet mode a navigation that fails with one of
  Chromium's connection errors (proxy, tunnel, DNS, refused, reset, timed
  out) or a navigation timeout raises at once, where it used to be tried
  eleven times and then end the process with a crash code the host agent
  would answer with a new container. At the boot login or mid-task the
  worker then parks for good: a result not yet reported goes back once with
  `take: false`, `next-task` is never asked again, nothing logs in or
  navigates, and the heartbeat says `DEAD` with `{reason: "connect_failed",
  operator: true, error}` (one line, URL credentials removed), which
  releases its task and keeps the slot's lease. `/healthz` stays 200 with
  `"state": "parked"` so Docker keeps calling it healthy; `docker stop`
  still ends it with 0. A stale epoch while parked, a park that cannot keep
  waiting, or a monitor that dies with a crash code while parked exits 78,
  which the agent leaves stopped. Proved on the built image against the
  fake fleet with a proxy that does not resolve.
- **Shared worker secrets arrive with the claim.** The entrypoint exports
  every string in the claim answer's `env` object (which the ERP's
  Cloudflare Worker adds from its `FLEET_WORKER_ENV` secret, so the secrets
  stay out of Railway and Postgres) into the monitor's environment and logs
  the key names once, never a value; `env` cannot set the fleet's own
  variables or the account's password fallback. A `${VAR}` the template
  references that is still unset is left out of the rendered config, so
  Telegram or the coordinator's tokens are simply off when absent; without
  `OPENROUTER_API_KEY` the worker exits 70 before the browser starts.
- **Fleet workers run without the coordinator.** When the claim's
  `settings.coordinator_url` is empty, no `control_plane_*` or
  `alert_report_*` key is rendered and `RS_CONTROL_PLANE_URL` is removed
  from the monitor's environment: no alert claims, funnel counts, challenge
  escalation or alert reports, while every task is still searched, judged by
  the AI and alerted on Telegram when that is configured. Overlapping cities
  can alert a listing twice until the coordinator is wired back.

### Changed

- **The vendored monitor is pinned at the fleet-mode commit** (VENDOR.md),
  now `1bf74f7`, which adds the hand-back above and the park on a
  connection failure.
- **A result the fleet did not answer is sent again** with the next ask
  instead of being dropped; the fleet ignores a `done` it already took.
- **`docker stop -t 30` fits.** The entrypoint now installs its SIGTERM
  forwarding before it starts anything (a stop during start-up was lost),
  gives the monitor 24 s, then stops Xvfb and x11vnc together within 3 s. Its
  kill timer is a daemon and cancelled once the monitor exits; before, a
  pending 25 s timer kept the entrypoint alive after a monitor that had
  already left. The session upload on the way out has a 10 s timeout.
- **`date_listed` as a list, as master.toml writes it**
  (`["last 7 days", "last 7 days"]`), reaches a fleet worker unchanged through
  the claim's `settings.search` and searches with `daysSinceListed=7` on the
  first and later searches, exactly as on the old path. It already worked;
  tests in both suites now pin it, for the marketplace and for an item.

## [0.13.18] - 2026-10-24

### Added

- **The city round can be started now, instead of at the workers' start
  times** (RS-393).
  - **The start.** `POST /v1/queue/start`, or `rsc queue start`, stores who
    started the round and when, in `queue_config` `start`. For a window's
    length (8 h) from then:
    - every enrolled worker's window is open;
    - a city is due once it was not searched in the last
      `start_fresh_hours` (2 by default).
  - **Waking the workers.** The coordinator queues a new `sweep` directive for
    every enrolled worker that is HEALTHY, live, not quarantined and on
    0.13.18 or later. Its directive poll picks it up within about 10 s, and
    the idle loop runs every search job then, with no restart.
  - **The preview.** `GET /v1/queue/start` (`rsc queue start --dry-run`) says
    who would start, who runs an older monitor and so starts at its usual
    time, and how many cities would be due.
  - **The console** forwards both routes, and `/v1/fleet`'s `queue.started`
    carries a running start.

### Changed

- **The vendored monitor is pinned at `3a621a4`**: it acts on `sweep`. The
  start-up run of every job and the one a `sweep` triggers now share
  `_run_all_jobs`. Older monitors ignore the directive.

## [0.13.17] - 2026-10-23

### Added

- **A city log: every city a worker searches, from handout to result**
  (RS-385).
  - **Storage.** The coordinator keeps one `city_events` row per step:
    - `handed` out by the queue;
    - each `searched` page, with its phrase and funnel counts;
    - each `alerted` listing, with its title, price and score;
    - a lease `released` when the worker parks or restarts.
  - **The monitor's side.** It reports `started`, then `finished` with the
    city's own counts and minutes, or `stopped` with the reason (a wall and
    its kind, a lost session, a pause, a sweep cut short, an error). It does
    so through `POST /v1/workers/<id>/city-events`, and logs the same as
    `[City]` lines with the brief report.
  - **Reading it.** `rsc queue log` prints one line per city, and
    `--events` adds the steps. The console serves the log as
    `GET /v1/city-log` for the ERP's worker page and the round card.
  - **Older monitors still show.** For them, a visit's end is read from the
    lease, or from the worker moving on.

### Changed

- **The funnel and alert reports say more.** The per-page funnel report
  carries the search phrase, and the alert report the listing's title and
  price. Both are optional, so an older worker or coordinator still
  validates.
- **The vendored monitor is pinned at `e045334`**: per-city start, finish
  and stop, with the reports above.

## [0.13.16] - 2026-10-23

### Added

- **The city queue is visible, and run, from the ERP** (RS-379).
  - `/v1/fleet` now carries today's round (`queue`), with every catalog
    city's state for each item: searched today, being searched, due, not due
    yet, or held by a worker outside the queue. It also gives each worker's
    part in it (`queue`): enrolled, able to pull, minutes used, cities handed
    out, open leases, quarantined.
  - Two console routes move workers in or out: `PUT /v1/workers/<id>/queue`
    for one, and `PUT /v1/queue/everyone` for all.
  - The ERP draws these on its Fleet tab and worker page.

### Changed

- **Only a worker that asks the queue counts as in it.** One enrolled on a
  monitor older than 0.13.14 keeps its cities held, so enrolling everyone
  while old images run never makes the pilots repeat their sweeps. The
  coordinator refuses (409) to enroll such a worker by itself.
- **The roster names the enabled items**, so a round shows before anyone has
  searched today.
- **`rsc queue status` counts the round by state** and flags enrolled
  workers that never ask.

## [0.13.15] - 2026-10-23

### Changed

- **Ops alerts, deploy notices and fleet-verify reports can live in their own
  chat and topics** (RS-375). `TELEGRAM_TOPIC_OPS` now also routes the
  coordinator's ops alerts (worker down, session expiring, challenge), not
  only fleet-verify's reports. `scripts/deploy.sh` posts its deploy notice to
  `TELEGRAM_OPS_CHAT_ID` when that is set. `TELEGRAM_TOPIC_OPS` and
  `TELEGRAM_TOPIC_RELEASES` name topics in that chat. With no ops chat set,
  nothing moves. Production sets all three to the "Homelab Alerts" ops group,
  so the buyers' listings group carries only listings.

## [0.13.14] - 2026-10-23

### Added

- **Workers can take their cities from the coordinator's queue** (RS-372). An
  enrolled worker asks `POST /v1/workers/<id>/next-city` before each city of
  an item's sweep, and searches what it is handed, including cities outside
  its own config. It stops when the queue has nothing more for it:
  - every city has been searched once today for that item;
  - its 6 hours of searching are spent;
  - it is outside its window (8 h after a `start_at`);
  - it is quarantined (every search at 0 cards where others get cards).

  These are the owner's first-stage rules (2026-10-23). Facebook was found not
  to mind an account searching far from its IP, so neither region nor IP
  partner limits anyone; `regions=home` and `partners=true` restore those
  rules.

  How the hand-outs work:
  - **Held cities.** A city that a live worker outside the queue still holds
    stays that worker's, so enrolling a few accounts fills holes and never
    repeats a static sweep.
  - **Leases.** They last while the worker heartbeats HEALTHY and come back
    the moment it parks.
  - **Restarts.** A restart after the round, or outside the window, searches
    nothing, so an enrolled worker no longer runs an off-schedule sweep on
    every deploy.

  Operators use `rsc queue status|enroll|unenroll|set|show`, and rs_console
  pushes the roster (catalog with radius, home cities, start times) every 10
  minutes and after *Edit cities*. Workers not enrolled, and every worker when
  the coordinator cannot be reached, search their own lists exactly as before.
  The shadow report now replays on the stored queue settings.

### Changed

- **Every search report names its item** (`city_searches.item`), so a city
  searched for one item still counts as due for the other.
- **The vendored monitor is pinned at `93e2566`**, which is `8979534` plus the
  queue loop.

## [0.13.13] - 2026-10-23

### Added

- **The console serves the login ledger to the ERP** (RS-366).
  `GET /v1/logins?worker_id=<id>&limit=<1..500>` returns one worker's login
  attempts from the coordinator: trigger, outcome, times, the account's
  `identity_key` and the parsed detail. The `datr` fingerprint and device id
  stay behind. The ERP's worker page draws each account's timeline from it;
  until this console is deployed, that timeline shows the pool's events only.
- **A shadow run of a pull-based city queue** (RS-370). Today each worker
  searches a fixed list someone set by hand. On 2026-10-23 that put 92% of
  the fleet's results on five accounts and left 123 of 127 cities with one
  live account. It also hid four HEALTHY accounts whose searches return
  nothing.

  The coordinator now:
  - logs every search with what it found (`city_searches`);
  - has the queue's decision, `city_queue.pick`: due cities only, a daily
    budget per account, home regions, IP partners kept apart, home cities
    first, and blind accounts quarantined;
  - replays the fleet's real availability through it with
    `POST /v1/queue/shadow`.

  `python -m rs_console.queue_shadow` prints the replay next to what the
  workers did, with what-if budgets, windows and tiers. No worker changes
  behaviour; the report is the evidence for the queue's budget, eligibility
  and frequency before any worker follows it.

### Changed

- **The vendored monitor is pinned at `8979534` instead of `96d9204`.** The
  code is the same; only the hash moved. `96d9204` lived only in a deleted
  worktree's clone, so the release gate could not be run anywhere.
  `8979534` rebuilds it from its parent `c20d341` and the one file it changed,
  copied from the VM. It matches the deployed tree byte for byte, apart from
  what the deploy filter keeps off the VM. `VENDOR.md` says how this was
  checked.

## [0.13.12] - 2026-10-21

### Fixed

- **The messenger no longer sends a seller the same reply twice** (RS-341).
  The coordinator retries a failed send up to three times. A reply that posted
  without being recognised as our bubble (Messenger rewrote an emoji or a
  link, or the "You sent" label moved) was one of those retries, and the next
  poll's duplicate check reads the pane the same way, so the seller could get
  three copies. That failure is now permanent: the row goes to `failed` for
  the operator, who can see whether it landed.
- **A retry never types onto a leftover draft.** Messenger keeps an unsent
  draft per thread, so after a send whose draft couldn't be cleared, the retry
  sent both texts as one. The composer is now cleared before typing, and a
  draft that won't clear stops the send (`ERR_DRAFT_STUCK`).
- **A send waits for the thread to load before taking its baseline.** On an
  evaluate error or a pane still rendering, the "before" snapshot came back
  empty, and an older identical bubble then counted as the new reply. The
  row was acked `sent` although nothing was sent. The messenger now waits up
  to 10 s for a message to render, and sends nothing if none does
  (`ERR_PANE_UNREAD`, retried next poll).
- **The alert-claims seed runs once.** It re-aggregated every alert ever sent
  (`alert_messages` is never pruned) on every coordinator boot, under the
  advisory lock, to insert nothing after the first time. Now it does its work
  only while `alert_claims` is empty.

## [0.13.11] - 2026-10-20

### Fixed

- **The token→session exchange uses the endpoint Facebook actually recognises**
  (RS-338 follow-up). 0.13.10 shipped a guessed `b-graph…/auth/getSessionForApp`
  path that 404s; the recognised legacy REST method is
  `api.facebook.com/method/auth.getSessionForApp` with
  `generate_session_cookies=1`. A live check also established the limit of this
  path: Facebook mints web-session cookies only for a **first-party /
  SSO-capable** app's token (`OAuthException` 100 otherwise). The purchased-pool
  `EAA…` tokens are valid Graph tokens but are refused here, so for those the
  worker's token-refresh step always falls back to the cookie restore and the
  password login — the cookie remains the real browser-login path. The step is
  kept because it works for a first-party token.

## [0.13.10] - 2026-10-20

### Added

- **A worker logs in from the account's access token when its cookie lapses**
  (RS-338). The login order is now cookie-restore → token-refresh → password:
  when a restored or seeded session does not take and the account has an access
  token, the worker exchanges it for fresh session cookies inside its own
  proxied browser context — the account's own IP and `datr`/`sb` device — and
  reaches Marketplace with no password and no 2FA. A dead, absent or
  wrong-account token falls through to the existing password login unchanged,
  so an account without a token behaves exactly as before.
  - The coordinator hands a worker the token on demand
    (`POST /v1/auth/session-token`, per-worker token only, audited under the
    `token` kind), with no daily budget — a token refresh is a far softer
    signal than a password login. `fb_token` is a new sealed vault secret, and
    the console allows it on the account write, so the tracker ships before the
    ERP release that sends it on Assign.
  - The login ledger now accepts the `cookie-restore` and `token-refresh`
    triggers. `cookie-restore` was already sent by the worker (RS-308) but not
    listed, so the coordinator rejected it with 422 and those ledger rows were
    silently dropped; they are recorded now.

## [0.13.9] - 2026-10-20

### Added

- **Every proxy carries two workers** (RS-334). The two-per-IP pilot on 10014
  and 10015 is widened to all 20 Decodo ports: the 18 other IPs each get a
  partner `<id>b` on the same proxy var. That makes 40 compose workers:
  `homelab-1b`, `ne-1b`, `mw-1b`, `west-1b`, `sc-1b`, `denver-1b`, `nyc-1b`,
  `phl-1b`, `wc-1b`, `va-2b`, `bos-1b`, `nyc-2b`, `nyc-3b`, `ca-3b`,
  `ca-4b`, `nj-1b`, `nj-2b` and `nj-3b`, on VNC 5924–5941.
  - Each seeds a catalog city near its exit that its IP-mate does not search.
  - Each sweeps at 17:00 UTC against its IP-mate's 13:00 (`settings
    start-at`).
  - The West Coast exits (Palo Alto, and denver-1's Seattle exit) get
    vault slots in `rs_west`, for Pacific-time devices.

  Every partner starts parked and searches nothing until it gets an account.
  `deploy/README.md` → *Scaling notes* has the rules for each pair and the
  order in which to assign accounts. Nine of these IPs carry live accounts,
  so pair those last.

## [0.13.8] - 2026-10-20

### Added

- **Two accounts on one IP, as a pilot** (RS-332). Ports 10014 and 10015
  (Palo Alto) each get a second worker, `ca-1b` beside `ca-1` and `ca-2b`
  beside `ca-2`, while `ca-3` and `ca-4` stay single as the control. Several
  accounts on one residential IP is ordinary, since a household shares a
  router. What got accounts killed on the shared house IP in 2026-08 was
  looking like one operator. So each pair differs in every way the fleet
  controls:
  - its own device profile, on Pacific time through its vault slot's region;
  - its own cities (the partners seed Las Vegas against Reno);
  - its own sweep time.

  `deploy/README.md` → *Scaling notes* has the rules and the stop and widen
  criteria.
- **A worker can have its own sweep times.**
  `python -m rs_console.settings start-at <id> HH:MM [...]` saves them in the
  console's state as `workers.<id>.start_at`, and `--clear` hands the worker
  the fleet's again. They are written after the fleet-wide values, so a sweep
  time saved from the ERP no longer lines up two accounts on one IP.
  `/v1/fleet` now gives every worker its own `start_at`, read from the config
  it runs, and counts those times in its `plan`. That is an additive field,
  so an older ERP ignores it.

## [0.13.7] - 2026-10-20

### Added

- **Ten more workers, one per new Decodo port** (RS-331). The plan grew from
  ten ports to twenty. Every port up to 10010 already had a worker, so ports
  10011–10020 each get a new compose worker named after its exit: `bos-1`
  (Boston), `nyc-2` and `nyc-3` (New York), `ca-1`–`ca-4` (Palo Alto, the
  pool's first West Coast exits), and `nj-1`–`nj-3` (Parsippany, NJ). Each
  seeds one city, the catalog city nearest its exit: Boston, New York, Newark,
  or Reno for the Palo Alto workers, since `master.toml` keeps California out.
  The console lists them, so the ERP shows them, edits their cities and
  watches their browsers on VNC 5912–5921. Each starts parked on an empty
  storage state and searches nothing until it gets an account from the pool.

  Before deploying, the VM needs each worker's `PROXY_HOMELAB_<X>` in
  `configs/secrets.env`, its `configs/secrets.homelab-<x>.env` (id and
  `rsc mint-token`) and an empty `configs/sessions/homelab-<x>/fb_state.json`.
  The compose headers spell it out. Deploy with every existing worker in
  `RS_DEPLOY_HOLD`, so only the new containers start.

## [0.13.6] - 2026-10-20

### Fixed

- **A listing alerts once across the fleet, not once per worker that sees it**
  (RS-329). From 10-12 to 10-20, 50 of 122 Telegram alerts repeated a listing
  already sent:
  - 38 came from a second worker. Every homelab worker sends its own alerts and
    its notified cache knows only its own; dc, nyc and philly are each searched
    by two workers, and neighbouring cities return the same listings.
  - 7 came from one worker. `Listing.hash` includes the item name, so a
    listing found by both `server_ram` and `enterprise_ssd` read as "changed"
    each time.

  Before sending, a worker now claims the listing from the coordinator
  (`POST /v1/alerts/claim`), and only the first claim sends. A delivered
  listing alerts again only when its price falls below the alerted price. A
  claim whose holder never reports delivery passes on after 15 minutes. A
  worker that gets no answer sends as before. The claims are seeded from
  `alert_messages` on boot, so the deploy does not re-alert yesterday's
  listings from another worker. The coordinator also reads a reduced price
  ("$20 | $25") as 20, not 2025.

## [0.13.5] - 2026-10-19

### Changed

- **The daily sweep starts at 09:00 Eastern, not 06:00** (RS-318). `start_at`
  in `master.toml` and every `homelab-*.toml` is `["13:00"]` UTC (09:00 EDT);
  when New York falls back to EST it needs `14:00` to stay at 09:00, as the
  config's comment says. A sweep time saved from the ERP's search settings
  still overrides this default. The VM's `fleet-verify.py` cron moves from
  21:05 to 23:05 UTC so it keeps running after a long sweep has finished.

## [0.13.4] - 2026-10-19

### Fixed

- **The pre-screen's default model lives in code**, as the page check's
  does, so the homelab workers run it. They take their environment from
  `configs/secrets.env` through `env_file`, not from the generic worker
  compose file 0.13.2 put the default in, so on that release the pre-screen
  would have stayed off fleet-wide. Unset means `typesafe/jev-1.14`; empty
  turns it off; `RS_PRESCREEN_ENFORCE=1` in that same file is the flip (RS-319).

## [0.13.2] - 2026-10-19

### Added

- **A decision model pre-screens listings before the LLM reads them**
  (RS-319). Every listing the LLM has no cached verdict for is first asked
  reject / maybe / buy by `RS_PRESCREEN_MODEL` (the worker compose defaults it
  to `typesafe/jev-1.14`, the model RS-316's shadow run preferred), with the
  production prompt as the rules. The fleet runs it in shadow: the answer is
  logged as a `prescreen` event beside the LLM's and nothing is skipped.
  `RS_PRESCREEN_ENFORCE=1` makes a reject at or above `RS_PRESCREEN_THRESHOLD`
  (0.99) skip the LLM, logged as `listing_skip reason=prescreen` and
  remembered so a lingering listing is not re-asked. Any failure of the check
  leaves the LLM running as before. `scripts/prescreen-shadow.py --live` reads
  the live events back into the same gate table the shadow run printed, and
  `sweep-report.py` counts enforced skips.

## [0.13.1] - 2026-10-19

### Added

- **`ai_eval` events name the model, unit count and quantity behind a
  verdict**, and `scripts/prescreen-shadow.py` replays recent billed verdicts
  through a decision model to measure what a pre-screen in front of the listing
  LLM would save and what it would drop (RS-316). The first run says no model
  yet meets the bar of keeping 99% of the listings we alert on; the ticket has
  the tables.

### Fixed

- **The poster's and monitor's "wait for this button" checks wait** (RS-313).
  Playwright ignores the `timeout` argument to `is_visible`, so the
  cookie-consent banner, the 2FA "Trust this device" button, the Publish form's
  Next step and the locked-account text on a checkpoint were instant snapshots
  that read like waits; the trust click in particular could miss and leave the
  device untrusted for the next login. They use `wait_for` now. Checks that
  meant a snapshot (the restriction banner on every navigation, the captcha
  selectors, the 2FA field inside a polling loop) say so by passing nothing,
  and a test in each package keeps the misleading form from coming back.
- **A Messenger reply is acked as sent only when the pane shows it as our
  bubble** (RS-314). The old check looked for the reply's first 60 characters
  anywhere on the page, so a draft that Enter never submitted, an older
  identical bubble or the thread list's preview all passed and the seller never
  got the reply. The sender now compares direction-tagged pane rows before and
  after typing, clears a draft that did not submit, and skips a reply whose
  bubble is already the latest message (a lost ack, not a new reply). On the
  coordinator a failed ack keeps the row queued for up to three attempts unless
  the bridge marks it permanent, and a late failure never demotes a sent row.
- **Challenge screenshots survive a redeploy** (RS-315). The coordinator wrote
  them to `data/screenshots` relative to its working directory, which in the
  container is `/app`, outside the `/data` volume, so every `deploy.sh` deleted
  them while the challenge rows kept pointing at the files. The default is now
  a `screenshots/` directory beside the database file, the image and the
  compose file set `RS_SCREENSHOT_DIR=/data/screenshots` outright, stored paths
  are absolute, and a challenge whose file is gone lists no `screenshot_url`
  instead of one that 404s.

## [0.13.0] - 2026-10-19

### Added

- **A wall mid-sweep parks the worker instead of reading as an empty city**
  (RS-311). Facebook walls a logged-in account without leaving the Marketplace
  URL — "You're Temporarily Blocked" is an overlay, a silent flag answers every
  search with nothing — and the `xs` cookie survives a checkpoint, so the worker
  heartbeat HEALTHY and searched the account's remaining cities into a deeper
  flag; the first sign was the next day's fleet-verify table. A search that
  returns nothing on an ordinary URL now asks a decision model (OpenRouter's
  Decisions API; `RS_PAGE_CHECK_MODEL`, default `openai/gpt-6-luna-decisions`)
  which kind of page the tab shows. A checkpoint, captcha, block or disabled
  notice files one challenge with a screenshot, reports CHECKPOINT or
  CHALLENGE_CAPTCHA, and parks the worker until the idle loop sees the page
  move on, whether an operator cleared it in Watch or Facebook lifted the block.
  A login or 2FA page is left to the next cycle's login, which has the
  credentials and the 2FA automation. The login flow asks the same question
  when its selectors see nothing, so a captcha on `two_step_verification` (va-2,
  2026-10-17) is now a challenge too. `search_empty` events carry
  `page_state`, its probability and the model. Any failure of the check — no
  key, timeout, odd answer — means the old behaviour. Probed on 27 page states:
  every model on the API told walls from clear pages 54/54; the default and
  `liquid/d1` led on the exact label, Jev 1.14 close behind; ~0.2 s and
  $0.00003 a call.

### Changed

- **0.12.3's wc-1 swap is on the mainline now** (RS-294). 0.12.3 and 0.12.4
  were released from the side branch `release/facebook-tracker-0.12.4`, and
  the VM runs 0.12.4. 0.12.5 was then released from `dev`, which did not have
  RS-294, so the `v0.12.5` tree still starts va-1 under compose on wc-1's
  proxy port and has no wc-1. **Never deploy `v0.12.5`.** The next release
  carries both lines.

## [0.12.5] - 2026-10-18

### Added

- **A worker can be logged in from a pool account's cookie, no password**
  (RS-308). An account the business buys often comes with a live Facebook
  cookie, and forcing a password login on assign — a fresh login and 2FA from
  the worker's datacenter IP — is the harshest signal to Facebook there is.
  The ERP's cookie-first Assign now seals that cookie as the slot's session
  snapshot through the new admin route `PUT /v1/workers/{id}/session`: the
  coordinator validates it (`cookies.py` reads a browser cookie header, a
  cookie-extension JSON export, or a flat `{name: value}` object; `c_user` and
  `xs` are required), refuses a cookie whose `c_user` is not the account's
  `fb_uid`, and files it under that account's `identity_key` so only this login
  can restore it. A new `restore` directive (queued by
  `POST /v1/workers/{id}/restore-session`, the gentle counterpart to
  `relogin`) tells the worker to run an ordinary, unforced login: it restores
  the seeded session and reaches Marketplace with no password and no 2FA,
  landing on the account's own device (RS-293). The password login stays as
  the fallback when there is nothing to restore. The seed is audited as a
  `session` disclosure, alongside code and credential releases. rs_console
  forwards both routes, field-sanitised; a coordinator without them answers
  404, which the console passes through, so the ERP degrades to the password
  path rather than breaking.

- **The coordinator keeps a log of worker status changes** (RS-300). A
  worker's row is overwritten by every heartbeat and its liveness is derived
  on read, so nothing remembered that wc-1 went from HEALTHY to
  SESSION_EXPIRED, or that ne-1 was silent for six hours and came back. The
  new `worker_status_events` table records each change of reported `state`
  and each live → stale → dead → live crossing. A crossing is stamped when
  it happened (last heartbeat + 2 h or + 6 h, or the beat that revived it),
  so a gap the ten-minute sweep never saw is still dated right once the next
  beat fills it in. The heartbeat, the listing upload (which stamps the
  heartbeat too) and the liveness sweep all write to it. Rows that predate
  the log take a silent baseline, so the deploy does not list every worker,
  and a retired worker's silence is never logged. `GET
  /v1/stats/status-changes` serves the log, and rs_console puts the week's
  changes in `/v1/fleet` as `status_changes`, which the ERP's Recent
  activity lists. The log is pruned to 30 days. The new table and the
  `workers.logged_liveness` column are added on start, as before.

### Fixed

- **The worker's VNC view shows the browser, not the whole display** (RS-295).
  Since 0.11.0, the X display has been 1920x1080 so that any device profile's
  screen fits, but Chromium opens a window only as large as its context's
  viewport plus toolbars, which is about 1288x807 for a legacy device. VNC
  served the whole display, so the ERP's watch page showed the browser in one
  corner of a black frame and scaled both down, which left a CAPTCHA hard to
  read. Each new browser context now crops x11vnc to its own window
  (`x11vnc -R clip:…`), and viewers that are already connected resize live.
  Xvfb itself cannot shrink: RandR on Xvfb 21 rejects a smaller screen.

## [0.12.4] - 2026-10-18

### Fixed

- **The worker's VNC view shows the browser, not the whole display** (RS-295).
  Since 0.11.0, the X display has been 1920x1080 so that any device profile's
  screen fits, but Chromium opens a window only as large as its context's
  viewport plus toolbars, which is about 1288x807 for a legacy device. VNC
  served the whole display, so the ERP's watch page showed the browser in one
  corner of a black frame and scaled both down, which left a CAPTCHA hard to
  read. Each new browser context now crops x11vnc to its own window
  (`x11vnc -R clip:…`), and viewers that are already connected resize live.
  Xvfb itself cannot shrink: RandR on Xvfb 21 rejects a smaller screen.

## [0.12.3] - 2026-10-18

### Added

- **wc-1 runs.** Its pool account sat in the vault with no container behind
  it, so the ERP showed it as "Never reported". It is now a compose worker,
  `rs-monitor-wc` (`deploy/docker-compose.homelab-wc.yml`), on the Leesburg
  exit at port 10009 (`PROXY_HOMELAB_WC`). It searches the same `rs_west`
  cities as west-1, and the console lists it for cities and Watch.

### Removed

- **va-1 is retired from compose.** Facebook locked its account on
  2026-10-18, and wc-1 takes its proxy port. Its compose file, config and
  console entries are gone, so no deploy brings it back up on wc-1's IP. Its
  vault account stays, locked.

## [0.12.2] - 2026-10-18

### Added

- **Every login records the device it was made on.** A worker opens a row in
  the coordinator's new `login_attempts` ledger when it starts a login, naming
  the account's device and a fingerprint of the `datr` its browser presents
  (never the cookie). It closes the row with the outcome: restored,
  password_ok, watch_ok, challenge, locked or failed. A login that starts on a
  `datr` the account's device profile does not hold pages ops before it goes
  further. `rsc vault logins` and `GET /v1/logins` show the ledger.
- **A new account starts on its legacy device.** The ERP's Assign now sends
  the pool cookie's `datr`/`sb` (never `c_user`/`xs`/`fr`). The console passes
  only those two cookies through, and `PUT /v1/accounts` seeds the account's
  device profile with them when it has none. The worker's first sign-in is
  then the account's own machine on a new IP, not a stranger.

### Changed

- **Automated password logins are capped and stop on a lock.**
  `/v1/auth/credentials` refuses an account that has had 2 password releases
  in 24 h (`RS_PASSWORD_LOGINS_PER_DAY`), or that Facebook has locked. The
  worker then parks for Watch, as it does without credentials. Facebook's
  "we locked your account" page is its own challenge kind (`locked`); a login
  that ends there, or a `locked` escalation, marks the account locked and
  pages ops until `rsc vault unlock <account>`. With `RS_REQUIRE_FB_UID=1` an
  account without a Facebook uid, and so without a device profile, gets no
  password at all; the coordinator warns at startup about any such account.
  All of this follows va-1 on 2026-10-18: four password logins in 37
  minutes, each from a new `datr`, locked as possibly hacked.

## [0.12.1] - 2026-10-18

### Added

- **A deploy can hold workers back** (`RS_DEPLOY_HOLD`, container names). A
  held compose worker is not recreated and keeps its current image, and the
  deploy's verify and Telegram note name it as held. This is for the worker
  whose restart would cost something: a login held only in memory until its
  next sweep, or a locked account that would retry its password from a fresh
  browser (va-1, 2026-10-18).

## [0.12.0] - 2026-10-18

### Added

- **The fleet scales itself and rolls new versions out one worker at a time**
  (RS-292). A new host agent, `rs_fleetd/`, runs on each Docker host and
  turns the coordinator's desired state into containers (`rs-worker-<id>`).
  - **Scaling:** the coordinator (`fleet.py`) keeps one worker per ready slot:
    a vault account the fleet is enabled for (`rsc fleet enable`), with a
    published config. It places the slot on the live, uncordoned host with
    the most room, and placement is sticky. `rsc fleet disable` stops a
    worker and keeps its `/data`. Nothing ever moves on its own;
    `rsc fleet move` is an operator's call, and it waits for the old host to
    stop the container first.
  - **Rolling releases:** `rsc fleet release <version>` recreates one worker at
    a time. The next waits until the current one heartbeats on the new
    version in a state no worse than before. A worker that has not come back
    within 20 minutes goes back to its previous image and the release stops,
    with an ops note; the rest keep running what they ran. Rolling back is
    releasing the previous version.
  - **Independence:** an agent that cannot reach the coordinator keeps the
    workers it last knew about, starts nothing new and removes nothing. The
    workers never depend on the agent.
  - **Trust:** a new host registers itself observe-only. It reports its plan
    (`rsc fleet hosts`, `rsc fleet state`) and applies nothing until it is
    made authoritative. Agents authenticate with their own host tokens
    (`rsc mint-host-token`), kept apart from the `secrets.env` every worker
    reads. They mint each worker's control-plane token, so the hand-written
    `secrets.homelab-*.env` files are no longer needed.
- **Worker configs for fleet workers live in the coordinator**
  (`/v1/fleet/configs`). The console renders and writes them exactly like a
  mounted config, so the ERP's settings and city edits reach fleet workers.
  `python -m rs_console.settings publish <worker>` hands a compose worker's
  config to the fleet. The console's Watch reaches fleet workers through the
  fleet's assignments.
- **A second worker host on the LAN.** Two opt-in compose files:
  `deploy/docker-compose.coordinator-lan.yml` publishes the coordinator on
  the VM's LAN address, and `deploy/docker-compose.registry.yml` is a private
  registry that `deploy.sh` pushes each release image to
  (`RS_REGISTRY=10.10.10.73:5000`).

### Changed

- **`scripts/deploy.sh` releases through the agent once the VM runs one.** It
  tags the worker image with its version, rebuilds `rs-fleetd`, starts
  `rsc fleet release`, and never recreates a compose worker again: an adopted
  worker would otherwise end up with its session in two browsers. Until
  then it recreates the compose workers as before.
- **`scripts/release.sh` runs the console's and the agent's suites too**, and
  bumps `rs_fleetd`'s version with the others.
- **Heartbeats name the worker's host** (`host_id`), and a worker the fleet
  stopped on purpose is not paged as dead (`retired_at`).

## [0.11.1] - 2026-10-18

### Fixed

- **An account keeps one device from its first Facebook page, not from its
  first successful login** (RS-292). A device's `datr`/`sb` used to be learned
  only from a logged-in save, so an account that had not yet finished a login
  met Facebook as a new machine on every attempt. On 2026-10-18 va-1 made six
  attempts with six fresh `datr`, and Facebook locked the account as hacked.
  Now, as soon as the first Facebook page loads and before any credentials
  are typed, a worker whose device has no cookies yet keeps the ones
  Facebook issued and reports them
  (`POST /v1/workers/{id}/identity/device-cookies`). The coordinator keeps
  the first worker's (first writer wins), and every later attempt, on any
  worker, presents them. A logged-in session still keeps them current.

## [0.11.0] - 2026-10-18

### Added

- **Every Facebook account keeps one device for good** (RS-292). The
  coordinator now keeps a device profile per account (`device_profiles`, keyed
  by the account's uid): the user agent or "the browser's own", screen,
  viewport, scale, locale, timezone, and the account's `datr`/`sb` cookies,
  sealed with the vault key. A worker asks for its account's device before
  each login, caches it in `/data/identity.json`, and opens every browser
  with it. A restart, a rebuilt VM or the account moving to another worker
  now shows Facebook the same machine, and no two accounts ever share one. A
  worker that is already logged in joins without anything visible changing:
  its account's first profile copies what its browser presents. The poster
  and messenger present the same cached device. `rsc identity list` prints the
  profiles.
- **A worker with a device restores a newer session, not only a missing
  one.** 0.10.5 refills a session file that holds nothing. A worker whose
  account has a device also replaces a file older than the coordinator's
  snapshot, which is what a worker moved to another host, or back, finds.
- **Vault accounts carry the Facebook uid** (`fb_uid`). The console passes it
  through from the ERP, and `rsc vault set-account --fb-uid` sets it by hand.
  A new login written without a uid clears it.

### Changed

- **A new login on a worker sets the previous session aside.** Before, a
  re-login after the ERP swapped accounts kept the old login's `datr`/`sb`, so
  the new account signed in from the old one's device. Now the old session is
  moved to `fb_state.json.<time>.previous-login`, never deleted, and the new
  account signs in carrying its own device cookies.
- **The coordinator only hands back a snapshot of the account's own login.**
  Once a worker's account has a uid, `GET /v1/session/{worker}/restore`
  answers 409 for a snapshot taken under another account's device, or of
  another uid's session. That is the snapshot a swapped worker still has on
  file until the new login's first save. A worker whose account has no uid
  restores as in 0.10.5.
- **`scripts/deploy.sh` ships the whole fleet.** It rebuilds the coordinator
  and recreates every `homelab*` worker one at a time, 20 s apart. Before, only
  `rs-monitor` was recreated, and the other nine ran whatever image they were
  last started from. `scripts/deploy.sh check` verifies every worker's code
  and the coordinator's version.
- **The worker's X display is 1920x1080**, so that any device profile's screen
  fits. Each context still presents its own account's screen and viewport.

### Upgrading

- The first deploy changes nothing that Facebook can see. Devices exist only
  for accounts with a uid. Accounts assigned from the ERP after its next
  release get one with the login. For the accounts already on workers, run
  `rsc identity learn-uids` on the VM, check each uid against the ERP's
  pool, then run it again with `--apply`.

## [0.10.6] - 2026-10-18

### Fixed

- **The coordinator refuses a session backup that holds no session.** A
  worker that backed up a logged-out jar replaced its last good snapshot, the
  copy 0.10.5 restores from. va-2 (0.8.0) did exactly that on 2026-10-17. The
  backup endpoint now answers 422 when the storage_state has no `xs` cookie and
  keeps the snapshot it has.

## [0.10.5] - 2026-10-18

### Fixed

- **A saved session survives a restart of any kind.** Each save is now
  fsynced, with its directory, before the rename is trusted, so a power cut
  cannot leave the session file pointing at data that never reached the disk.
  A worker gets 30 s to stop instead of Docker's 10 (`stop_grace_period`, and
  supervisord's `stopwaitsecs` 25), so the SIGTERM save that 0.10.3 added is
  not cut short by a slow browser.
- **A worker whose session file is missing or empty restores its own backup.**
  Every save was already backed up to the coordinator's database, encrypted
  with the vault key, but nothing read it back. At login the worker now
  fetches its snapshot (`GET /v1/session/{worker}/restore`, which releases it
  only to that worker's own token) and starts from it. A file that holds a
  session is never replaced, and a forced Re-login skips the restore.

## [0.10.4] - 2026-10-18

### Fixed

- **A login finished over Watch is picked up between sweeps.** 0.10.3's
  minute-by-minute session check never saw it: the worker read the page's URL
  before asking the browser anything, and Playwright only refreshes that URL
  while a call is running. An idle worker therefore kept seeing the 2FA page its
  password login had given up on, and read the session as logged out. The check
  now asks for the cookies first, which brings the URL up to date (va-1,
  2026-10-18).

## [0.10.3] - 2026-10-17

### Fixed

- **A worker's session status and saved session follow the browser between
  sweeps, not at the next one** (RS-289). Before, a worker learned about its
  Facebook login only at a sweep, at a login or on a parked page. On
  2026-10-17 va-2's password login timed out without parking, and the
  operator finished it over Watch. The fleet page then read "Session
  expired", with an empty session file, for 13 hours. Now the idle worker
  checks its login every minute. A logged-in browser is saved, backed up and
  reported healthy within about a minute, and a session that lapses overnight
  is reported expired just as fast instead of reading healthy until morning.
- **A session is no longer lost to a restart.** An idle, logged-in worker
  re-saves and backs up its session every 30 minutes. A redeploy or
  `docker stop` now saves the live session before the monitor exits. Before,
  SIGTERM killed the monitor outright, and everything since the last sweep
  was lost. A logged-out browser still never overwrites a good session file.

## [0.10.2] - 2026-10-17

### Changed

- **The console's fleet dashboard shows where each proxy comes out.** The
  account table's Proxy column and a worker's detail row showed only the env
  var name (`$PROXY_HOMELAB_NE`). They now show what `/v1/fleet` has carried
  since 0.10.0: the proxy's host and port without the login, and its exit
  city, with the exit IP and ISP on hover. The detail row spells out
  `IP · City, Region, Country`, or says the lookup is still running or
  failed. A worker without a proxy shows "own IP" and the VM's own exit
  city. Search matches the proxy host, exit IP and city too (RS-288).

## [0.10.1] - 2026-10-17

### Fixed

- **A worker that cannot log in parks instead of searching logged out**
  (RS-286). A worker with no session file at all now parks like one with a
  lapsed file, so a new worker no longer needs an empty storage state before
  first start. A password login that stops on a checkpoint now parks too, and a
  checkpoint finished by hand in Watch is adopted and saved within seconds;
  before, the worker never noticed, kept reading "Session expired", and its
  next job searched from wherever the login had stopped. A Re-login that works
  reports healthy at once instead of at the next sweep.

## [0.10.0] - 2026-10-17

### Added

- **The fleet document says where each worker exits** (RS-281). `/v1/fleet`
  gives every worker a `proxy`: its proxy URL with the login cut out, and the
  IP, city, region, country and ISP an IP-geo lookup made *through* that proxy
  returns (the VM's own, for a worker without one). Only the env-var name used
  to leave, which said nothing about whether a region's account looks like it
  is in that region. Lookups are cached and never hold the page; credentials
  still never leave the console. `proxy_env` stays for older ERPs.

## [0.9.0] - 2026-10-17

### Added

- **Re-login starts within seconds, and says how it is going** (RS-280).
  A re-login rode only on the five-minute heartbeat, so the button looked
  dead: on 2026-10-17 va-2 took 4½ minutes to start, then stopped on a
  captcha that nobody was watching for. Workers now poll the new
  `POST /v1/workers/{id}/directives` (worker token; it hands out the same
  one-shot flag as the heartbeat) every 10 seconds, and send a heartbeat per
  login step with `login_step` and `login_step_at`. The coordinator stores the
  step and keeps the time of the last request, in three new `workers` columns
  (`relogin_last_requested_at`, `login_step`, `login_step_at`; added on start),
  and `/v1/workers` and `/v1/fleet` carry them with `relogin_requested_at`.
  Vendored monitor repinned to `9350dd7`.

  Old and new mix safely. A new worker against an old coordinator gets a 404
  from the poll, slows it to once a minute, and still receives its re-login on
  the heartbeat. An old worker against a new coordinator never polls and
  reports no steps.

## [0.8.0] - 2026-10-17

### Added

- **Busy cities are searched more often** (RS-277). The coordinator ranks
  each worker's cities by alerts sent plus alerts reacted to over a window
  (default 30 days): the top 20% are searched 3 times a day, the next 20%
  twice, the rest once; a city with no alerts is never promoted, and a pin
  fixes a city's count. The monitor asks `POST /v1/workers/{id}/search-plan`
  before each item's sweep and searches only the cities due in the current
  `start_at` slot. Nothing is written into a config, so a change restarts no
  sweep. The rule and pins are new tables (`city_tier_settings`,
  `city_tier_pins`, created on start); the console forwards
  `GET/PUT /v1/city-tiers` and marks `/v1/fleet`'s cities with `per_day`,
  `pin` and `score`. Vendored monitor repinned to `3d6dc96`.

  **To turn it on**, give the search settings three daily start times (e.g.
  02:00, 10:00, 18:00) from the ERP. With one time, as today, every city is
  still searched once a day, so this release changes nothing until then. A
  monitor that cannot reach the coordinator searches every city.

## [0.7.1] - 2026-10-17

### Fixed

- **A new worker no longer searches logged out on its first start**
  (RS-275). With no session file, the monitor could not record that it had
  parked on the login page (the parked state is the file's fingerprint), so
  the next item searched Marketplace logged out. The new workers' compose
  headers now require an empty storage state in their session dir before
  first start. The monitor gap itself is described in
  `docs/debug-notes/2026-10-17-new-worker-without-session-file-searches-logged-out.md`.

## [0.7.0] - 2026-10-17

### Added

- **Four more workers, one per unused Decodo port** (RS-275): `nyc-1` (10007,
  Brooklyn), `phl-1` (10008, Folcroft PA), `va-1` and `va-2` (10009, 10010,
  Leesburg VA). Each is `deploy/docker-compose.homelab-<x>.yml` with its own
  config, session dir, cache volume and VNC target. Every master.toml region
  already has a worker, so their cities are set from the ERP; the config only
  seeds the city at the exit. A worker searches nothing until it has a login,
  so set its cities before giving it an account.
- **A worker's cities can be set from the ERP** (RS-275). rs_console takes
  `PUT /v1/workers/{id}/cities` and writes the list into that worker's config
  only, kept in the settings state so a deploy keeps it. `/v1/fleet` now
  describes each named worker from the config it runs, with
  `cities_editable`. Any Marketplace slug or numeric id is accepted.
- `deploy/make-region-config.py` takes `'slug=Name;slug=Name'` in place of a
  region, for a worker with cities of its own.

### Changed

- The console's `RS_WORKER_CONFIGS` names each config by worker
  (`id=path`). A bare path still works, without editable cities.
- `scripts/deploy.sh` renders each worker config with `--config <file>`, so
  that worker's saved cities stay, and copies a new worker's config to the VM
  before the console mounts it (a missing mount source becomes a directory).

## [0.6.1] - 2026-10-17

### Added

- **Which cities each worker has searched today** (RS-271), for the ERP's
  fleet fold, which now greens only those.
  - The monitor's funnel report for a search page names its `search_city`
    (vendored pin `37da00f`).
  - The coordinator keeps one `search_cities` row per worker and city with
    the last search time, and serves them at `GET /v1/stats/search-cities`
    (admin). The table is created on start on SQLite and Postgres.
  - rs_console's `/v1/fleet` adds `today.cities`: the slugs searched in the
    worker's local day, or null against a coordinator without the endpoint.

## [0.6.0] - 2026-10-17

### Added

- **Every stage from a search to an alert is now counted** (RS-262), so the
  ERP's funnel card shows numbers instead of "not counted yet".
  - `review_stats` gains `searches`, `cards`, `title_pass`, `opened`,
    `keyword_pass`, `fresh`, `coordinated` and `sent`. The columns are added
    in place on SQLite and Postgres when the coordinator starts.
  - Workers report the first seven stages. The coordinator counts
    `coordinated` (ingest found the match new or changed, or a direct-send
    worker reported its alert) and `sent` (a listing alert delivered from the
    outbox, or a reported direct send).
  - `GET /v1/stats/reviews` returns daily sums of all of them.
  - The vendored monitor now buffers its counts and sends **one report per
    search page** instead of one per AI verdict and one per alert, so it makes
    fewer requests than before. This needs the new pin in `VENDOR.md`.
  - **Deploy the coordinator first.** An older coordinator still takes the new
    report's `reviewed`/`alerted`, because it ignores fields it does not know.
- **Search settings can be saved from the ERP.** rs_console has a new
  `PUT /v1/config/settings` (`rs_console/settings.py`). It validates the
  settings the ERP's *From a search to an alert* card edits, keeps them in
  `/state/settings.json` on a new `rs-console-state` volume, and writes them
  into every worker config in place. A worker picks the change up between jobs
  and sweeps straight away. `/v1/fleet` now reports the effective values
  (`master.toml` plus saved values), includes `start_at`, and says whether the
  console can save (`settings.editable`).
- **Each worker’s day on the fleet table** (RS-264): when it started, how many
  of its searches it has done, and how many new posts it found.
  - New `search_cycles` table (created on start, both backends): a heartbeat
    whose `last_search_at` differs from the stored one logs when the worker
    started on an item. Rows older than 14 days are pruned on insert.
  - New admin reads: `GET /v1/stats/search-cycles?hours=` and
    `GET /v1/stats/reviews/workers?days=` (the funnel counters per worker per
    UTC day, with `updated_at`).
  - rs_console's `/v1/fleet` gives each worker `timezone` (its region's),
    `plan` (enabled phrases × cities × `start_at` runs = searches a day) and
    `today` (first and last activity in its local day, cycles, searches,
    reviewed as posts, alerted). `search.start_at` is now exposed. Against an
    older coordinator `today` is null and the page shows "—".
  - rs_console now depends on `tzdata`, so the slim image can resolve zones.

### Removed

- **The `server_cpu` item is gone from `master.toml`** (and the regenerated
  `homelab.toml`, `homelab-ne.toml` and `configs/generated/*`). It had been
  `enabled = false` for weeks; CPU lots are still rejected by the AI prompt,
  which never changed. The title gate comment no longer lists `xeon`/`epyc`.
  Regenerate on the VM: `sh deploy/make-homelab-config.sh` (deploy.sh does
  this) and `rsc gen-configs`.

### Changed

- **Deploys send the worker configs through the console.**
  `configs/homelab*.toml` are no longer in the rsync (`deploy.rsync-filter`).
  `scripts/deploy.sh` rebuilds and recreates rs-console, renders each worker
  config with the saved settings written in, and writes it in place. Verify
  compares the running config against that render. Without this, every deploy
  would have put `master.toml`'s values back over the saved ones.
- **rs-console mounts every worker config writable** (one file at a time,
  never the `configs/` directory with its secrets and sessions), and
  `RS_MONITOR_CONFIG` moves to `/config/workers/homelab.toml`. It depends on
  `tomlkit`, which keeps the configs' comments when it writes.
- **System faults page ops once, fleet-wide, instead of flooding the chat.**
  An AI outage used to send an "AI evaluation DOWN" / "recovered" pair from
  every worker every time OpenRouter flapped — 98 to 130 DOWN notes per worker
  were in the logs. Workers now declare the AI down only after 3 straight
  failed evaluations (up after 3 straight successes) and report that crossing
  to a new coordinator endpoint, `POST /v1/incidents`, which keeps one
  incident per key: the first `down` pages once, later reports from any worker
  are absorbed, one "recovered" note closes it once every voter is back, and a
  relapse inside `RS_INCIDENT_COOLDOWN_HOURS` (default 6) stays silent. A
  worker without a reachable control plane applies the same one-per-cooldown
  rule locally. New `incidents` table (created on start, both backends);
  `GET /v1/incidents` (admin) lists the ledger. Tuning knobs, all optional:
  `RS_INCIDENT_COOLDOWN_HOURS`, `RS_INCIDENT_VOTE_TTL_HOURS` (coordinator),
  `RS_INCIDENT_DOWN_AFTER`, `RS_INCIDENT_UP_AFTER` (workers). Both the
  coordinator and the monitor image change, so restart rs-coordinator after
  the deploy (deploy.sh only ships the monitor). See README "System faults
  page once".

- **Workers now heartbeat every 5 minutes** instead of once per search. The
  first `report_state` starts a daemon thread in the monitor that re-sends the
  last reported state on a timer, so the coordinator (and the fleet dashboard)
  hear from a worker throughout an hours-long sweep and across the idle gap
  between sweeps. The repeater only restates the last state — it never touches
  the page — so the login is still re-checked at the top of each search, and
  a session that dies mid-sweep reads HEALTHY until the next search starts.
  The coordinator's liveness lines (2 h stale, 6 h dead) are unchanged; they
  can now be tightened in a later release. `scripts/worker-status.sh` no longer
  says a heartbeat hours old is normal, because it is not any more.

### Added

- **Worker Facebook logins are managed from the ERP.** `PUT
  /v1/accounts/{account_id}` (coordinator, admin token) creates or updates a
  vault account: its worker, Facebook login, `allow_password_login`, and the
  write-only secrets (`password`, `totp_secret`, and the e-mail code fields).
  An empty secret keeps the stored value, `null` clears it, and a TOTP key is
  checked the same way `rsc vault set-account` does (the parser moved to
  `rs_coordinator/totp.py`). A worker cannot be moved onto an account another
  account already owns (409). The console forwards it as the one
  credential-bearing route on its allowlist, reduced to those fields before it
  goes upstream; the answer is presence flags only, and the audit line names
  the fields that changed, never a value. With a password stored and password
  login allowed, "Re-login" finishes by itself — which is what the ERP's new
  "Edit credentials" form on the Account information table is for. The
  coordinator **and** the console change; the monitor does not.

- **A "Re-login" button in the VNC console** that makes a worker re-run its
  full Facebook login — username, password and 2FA/TOTP code, all filled
  automatically — without waiting for the session to lapse. The button
  (`rs_console`) POSTs to the coordinator, which rides a `relogin` directive
  back on the worker's next heartbeat (consumed once); the worker then drops
  its restored session and re-authenticates at once, between sweeps. Use it
  when a session is stuck or expired. The 2FA secret is set per account via the
  web UI's new **2FA secret key (TOTP)** field (`totp_secret`).
  - Spans all three services, so a full deploy is the monitor **and** the
    coordinator **and** the console. (Ported from the VM's own checkout,
    commits `8b6c28d` and `34c4116`, where it has run since 2026-10-04.)

- **`scripts/build-monitor-image.sh`** builds `aimm-recycle:latest` on the VM
  stamped with its version and commit, so a by-hand build no longer reports
  "unknown (unknown)" on the fleet dashboard.

- **`scripts/fleet-verify.py` — a per-worker post-sweep check, cron'd on the
  VM.** Joins the coordinator (liveness, state, session expiry, open
  challenges), the OpenSearch `fb-tracker-*` funnel since the 10:00 UTC sweep
  started, and `docker ps -a`, and posts one table to Telegram at 21:05 UTC
  daily. Flags what `rsc status` cannot: a HEALTHY worker whose searches come
  back empty (the checkpoint signature) or that evaluates nothing. Verdict
  logic is pure and covered by `scripts/tests/test_fleet_verify.py`. See
  README "Daily fleet verification".

- **Watch a worker's browser from the dashboard.** Every row in the fleet
  dashboard's Accounts table has a **Watch** button, and the *Needs a human*
  card links to the stuck worker's screen: `/vnc/<worker-id>` on the console
  shows the live Chromium in the tab, view-only until **Take control** is
  ticked. No tunnel, no VNC client, no published VNC port. The console
  bridges a token-gated WebSocket (`POST /v1/vnc/<worker>/ticket` for a
  single-use 60-second ticket, then `/v1/vnc/<worker>/ws`) to the worker's
  x11vnc over the `rs-fleet` network, reaching only the workers listed in the
  new `RS_VNC_TARGETS` env in `deploy/docker-compose.console.yml`. The client
  is noVNC 1.7.0, vendored under `rs_console/rs_console/static/novnc`.
  `/v1/fleet` now carries `vnc_url` (the console page when reachable,
  otherwise whatever config said) and `vnc_live` per worker. **Rebuild
  `rs-console`** — the image gains a `websockets` dependency uvicorn needs
  before it will accept the socket.

- **A second account can now run on the homelab VM, covering a different region
  through its own dedicated proxy — no shared IP, no city overlap.** This is the
  fleet model the user asked for (each account = one region + one proxy). The
  Northeast worker (`rs-monitor-ne`, `deploy/docker-compose.homelab-ne.yml`,
  `configs/homelab-ne.toml`) searches the 24 Northeast centres through Decodo
  port 10002 (its own residential exit IP), while `rs-monitor` keeps the
  Southeast on port 10001. Facebook sees two different IPs from one box, which
  is the point — accounts kept dying on the shared house IP.

  `deploy/make-region-config.py <region> <proxy_var> <out>` generates the
  region-scoped config from `master.toml`, changing only the phase-1 city
  arrays, the proxy var, and the session path — everything else (AI prompt,
  buying criteria, the twice-a-day `start_at`, filters) is inherited, so the
  two workers cannot silently diverge. The NE list is verified disjoint from
  the SE list.

  The second worker's identity (`RS_WORKER_ID=homelab-ne` + its control-plane
  token) lives in a gitignored `configs/secrets.homelab-ne.env`, a second
  env_file so it never collides with `rs-monitor`'s identity in the shared one.
  `configs/secrets.*.env` is now gitignored. Alerts stay direct-to-Telegram
  (disjoint regions need no cross-worker dedupe). The container starts only
  after its account's session is captured *through* port 10002.

### Added

- **Fleet dashboard.** `rs-console` now serves a standalone page at `/`
  showing every Facebook account: liveness and state, the region and city
  list it searches, session days left, last search and heartbeat, the search
  phrases and gates per item, the shared search settings, and a coverage map
  of all 127 centres lit by whichever worker is actually searching them, with
  per-city alert counts for the week. One search box filters accounts, cities
  and phrases together. Built on the ERP's design tokens and class names so
  it can move into the ERP's Facebook-tracker page later.
- `GET /v1/fleet` on the facade: `fleet.toml` + `master.toml` + the mounted
  monitor config joined to the coordinator's worker health, the vault's
  account list and each worker's session metadata. Proxies appear only as
  env-var names; a coordinator outage degrades to `health.error` instead of a
  failed request. `deploy/docker-compose.console.yml` now mounts `master.toml`
  and `fleet.toml` read-only — rebuild the console container after deploying
  (it is outside `deploy.sh`'s restart).
- **Account information per worker.** The coordinator gains
  `GET /v1/accounts` (admin): each vault account's label, worker, Facebook
  login, region, VNC link, whether password login is allowed, whether a proxy
  is registered, and *which* secrets are stored — never a value, never the
  proxy URL. Session metadata (`/v1/session/<worker>/meta`) now carries
  `fb_user_id`, the Facebook numeric user id read from the backed-up session's
  `c_user` cookie (the public profile id, not a credential); it is stored in a
  new `session_snapshots.fb_user_id` column on backup and read out of older
  snapshots on demand. Both dashboards show the login, the user id (linked to
  the profile), the vault account, stored secrets, the browser identity and
  the backup age under each account. **Restart `rs-coordinator`** after
  deploying — the facade tolerates an older coordinator (no accounts, no user
  id) until then.
- **Every build is visible on the dashboard.** The monitor image now bakes
  in its build identity (`RS_VERSION` + the vendored monitor commit, passed
  as build args by `deploy.sh`) and reports it as `version` in every
  heartbeat; the coordinator stores it on the worker row (`workers.version`),
  serves it on `/v1/workers`, and names its own build on `/healthz`. The
  facade adds a `versions` block (console + coordinator) to `/v1/fleet`, and
  both dashboards show a Build column per worker — flagged when it differs
  from the coordinator's, "pre-0.5.6" for images that predate reporting — plus
  chips naming the coordinator and console builds. `rs_console` now carries
  the system version too, and `release.sh` bumps it with the others.

### Fixed

- **A worker whose session lapsed showed a blank screen in "Watch", and
  "Re-login" could not log it back in.** With no credentials in the TOML,
  `login()` closed its only page, leaving Xvfb empty (homelab-1, black since
  2026-09-16), and nothing ever asked the vault for credentials, so a forced
  re-login just cleared cookies and gave up. The worker now falls back to
  `/v1/auth/credentials` (still opt-in per account: `allow_password_login`
  plus a stored password), and when there is still no way in it parks the
  page on the Facebook login form instead of closing it. An operator can then
  "Take control" and log in by hand; the worker adopts and saves that session
  within about 15 seconds.
- **A forced re-login no longer presents as a brand-new device.** It cleared
  every cookie, `datr` included, so each press of "Re-login" was a new browser
  signing in right after a session problem — the takeover signature that has
  cost sessions before. The session cookies are dropped and the device cookies
  (`datr`, `sb`) put back.
- **The Re-login coordinator change would have failed every heartbeat in
  production.** `request_relogin` / `take_relogin` were added only to the
  SQLite backend, but the live coordinator runs on Postgres (`RS_DATABASE_URL`),
  so `/v1/heartbeat` would have raised `AttributeError` for every worker.
  Both methods are now in `pg.py` too; `test_the_two_backends_expose_the_same_api`
  caught it, and the round-trip was checked against a real Postgres 16.
- **A deploy no longer deletes the VM's own files or ships the dev machine's
  logins.** `deploy.sh` syncs with `rsync --delete`, and its excludes covered
  only `configs/secrets.env` and `configs/sessions`. A deploy from any checkout
  that lacked the VM's hand-written per-worker tokens
  (`configs/secrets.homelab-*.env`), `secrets.env` backups, proxy list,
  `accounts/` or `generated/` deleted them on the VM, and a stale dev copy
  replaced the live one. The same sync copied
  `configs/account_info.txt*` (Facebook logins and 2FA, read only by
  `rs-session capture` on dev) and `configs/data.txt` to the VM. The rules now
  live in `scripts/deploy.rsync-filter`, which never sends and never deletes
  either set, and `scripts/tests/test-deploy-filter.sh` (run by `release.sh`)
  proves it with a real rsync between two trees.

## [0.5.5] - 2026-09-05

### Changed

- **Every worker now sweeps twice a day inside a 07:00–23:00 window, instead of
  looping every ~hour (owner call, 2026-09-06).** The continuous ~45–75 min
  cycle is the request-rate pattern that keeps getting accounts flagged. A new
  `start_at = ["13:00", "21:00"]` at `[marketplace.facebook]` (which *overrides*
  `search_interval`) makes the monitor sweep once at each time and idle between —
  two sweeps means each city is visited twice a day, and both finish well inside
  the window (a ~28-city sweep runs 4–5h). The times are UTC because the
  container clock is UTC; they map to 07:00 and 15:00 Denver (MDT) and must be
  bumped to `["14:00","22:00"]` when Denver returns to MST. Applies fleet-wide:
  `start_at` propagates through `sharding.py` into every generated worker config.
  One caveat: the monitor runs one sweep on startup, so deploys should be done
  during the window (they were).

## [0.5.4] - 2026-09-05

### Changed

- **Ramp: the homelab worker is temporarily narrowed to `rs_southeast` (28
  centres) while a previously-revoked account settles behind the new proxy.**
  Account 100029243280255 was revoked twice on 2026-08-26; it is being brought
  back on the Decodo ISP proxy (the shared house IP was the constant across both
  kills), but a cold-looking account's first act being a 127-city sweep is the
  heaviest possible first-activity signal. So the phase-1 city list is cut to
  one region — anchored on `dc` (Data Center Alley) — for a few days, then
  widened back to all 127. Only the phase-1 `search_city`/`city_name`/`radius`
  arrays changed; the `[region.*]` blocks are untouched and still hold the full
  list, so the sharded fleet and `rsc gen-configs` are unaffected. A RAMP banner
  in `master.toml` says how to widen back.

## [0.5.3] - 2026-09-05

### Fixed

- **`rs-session capture --proxy` never authenticated to a proxy that needs a
  password.** The code passed the whole `http://user:pass@host:port` string to
  Playwright as `proxy={"server": ...}`, but Chromium does not read credentials
  from a proxy URL — it got a 407 it never answered, and the symptom was a
  page-load *timeout*, so it read as "the proxy is down" rather than an auth
  failure. Measured against a live authenticated proxy: the embedded form times
  out both raw and percent-encoded, while split `username`/`password` fields
  connect immediately. This is the exact form `deploy/README.md` tells you to
  use when onboarding a worker (`--proxy "$PROXY_SOUTH_CENTRAL"`), so every
  fleet capture through an authenticated proxy would have failed the same way.
  A new `proxy_settings()` splits the URL into the fields Playwright wants;
  `+` in a password survives verbatim (`unquote`, not `unquote_plus`).

## [0.5.2] - 2026-09-05

### Added

- **The homelab worker can now route through a proxy (`PROXY_HOMELAB`), off by
  default.** Sharded workers get a proxy injected per region; the phase-1
  worker never had one, so every search left from the house's own IP — the same
  IP the operator's session captures and city lookups run from. On 2026-08-26
  one Facebook account was revoked twice in 90 minutes and that IP was the only
  constant across both incidents. `[monitor].proxy_server` in `master.toml` now
  reads `${PROXY_HOMELAB}` (plus optional `_USER`/`_PASS` for authenticated
  endpoints).

  **Unset is safe and is the default**: an unexpanded `${VAR}` resolves to None
  with a warning and `handle_proxy_server` returns early, so with nothing in
  `secrets.env` the worker behaves exactly as before. Verified both directions
  against `MonitorConfig` rather than assumed.

  Written as a STRING, deliberately not a list: `get_proxy_options` does
  `random.choice(self.proxy_server)` per page, so a list rotates the exit IP
  mid-session — and Facebook binds a session to the IP it was created on, which
  makes rotation worse than no proxy at all. Activating it also requires
  re-capturing the session *through* the proxy
  (`rs-session capture --proxy "$PROXY_HOMELAB"`), because replaying a session
  born on one IP from another is the location change the proxy exists to avoid.

## [0.5.1] - 2026-08-26

### Changed

- **The 99 new city centres are now searched FIRST.** The monitor walks
  `search_city` in order and a full pass takes many hours, so the geographic
  ordering v0.5.0 shipped put the whole Northeast — almost all of it already
  covered — ahead of every metro the expansion added. Measured after the first
  restart: 4 cities searched, 0 of them new. The 99 additions each carry up to
  a full 7-day backlog on their first visit, while the original 28 have been
  swept every couple of hours for weeks and hold almost nothing new, so the
  backlog now goes first and the originals follow. Only the phase-1 arrays
  moved; the `[region.*]` blocks are untouched, because their order is a
  per-worker concern and gen-configs' invariant is set equality, not sequence.
  Once the new centres have each been visited a few times this ordering stops
  earning its keep and can go back to geographic.

### Added

- **`scripts/sweep-report.py` — the search funnel, posted to Telegram, split
  original-28 vs new-99.** A fleet-wide funnel cannot answer the only question
  the expansion raises: whether the new metros produce anything. The 28
  originals generate enough volume to drown 99 quiet ones either way, so every
  figure — searches, listings skipped, AI evaluations, drops at the 5-unit gate
  and the rating gate, alerts, and the score spread — is reported twice, once
  per side. A window with no new-city activity says so in words rather than
  printing zeroes that read as "not measured". Runs from cron on the VM against
  the OpenSearch index the monitor already ships to; `--dry-run` prints without
  sending, `--hours` changes the window.

## [0.5.0] - 2026-08-26

### Added

- **Alert hit rate: partner emoji reactions on Telegram alerts are now
  captured and countable.** A partner marks an alert they are acting on by
  reacting to it; nothing recorded that, so there was no measure of which
  alerts get used. Two new halves, joined at query time on
  `(chat_id, message_id)`: the monitor now keeps the `message_id` the Bot API
  returns for each alert (previously discarded) and reports it — with listing
  id, search city/phrase, priority topic and AI verdict — to the coordinator's
  new `POST /v1/alerts/telegram` (fail-open, after the send, so a down
  coordinator can never cost an alert); and the coordinator's Telegram update
  consumer now also requests `message_reaction` updates and stores every
  reaction raw (`alert_reaction_events` append-only, `alert_reactions` current
  state — a removed reaction empties the state but keeps the row and the
  history). `GET /v1/stats/alert-hits` (admin; forwarded by rs-console for the
  ERP) serves sent-vs-hit counts bucketed by day, priority, item and search
  city — the source data for tuning the prompt and the city list. Any current
  reaction counts as a hit; raw emoji are stored so a taxonomy can be layered
  on later. Reactions on messages with no recorded alert (sent before this, or
  on a timed-out send) are kept and surfaced as `unmatched_reactions`, never
  dropped. Enabling note: the consumer now starts whenever `TELEGRAM_TOKEN` +
  `TELEGRAM_CHAT_ID` are set (it used to need the war room), so
  `rsc telegram-chatid` must not be run while rs-coordinator is up — Telegram
  allows one getUpdates poller per bot. Reporting from the monitor needs
  `RS_ALERT_REPORT_URL=http://rs-coordinator:8500` in `secrets.env` (VM copy
  too — deploys never sync that file); Telegram only delivers reactions made
  after the consumer is live, so history before the deploy is unrecoverable
  by design.

### Changed

- **Coverage went nationwide: 28 city centres to 127, every mainland state
  except California.** Coverage comes from the number of search centres, not
  from the radius around them — a metro with no `search_city` entry of its own
  is invisible however wide the circle on its neighbour (the Louisville case
  in `master.toml`). The list was the US east only, so most of the country was
  simply never searched. It now spans all 48 mainland states ex-California:
  20 had no entry at all (NJ, DE, SC, TN, AL, WV, VT, IN, WI, IA, NE, KS, MS,
  AR, OK, ND, SD, WY, ID, NV) and major metros were missing inside states
  already listed (Harrisburg, Albany, Greensboro, Savannah, Huntsville,
  Portland ME, Lexington and more). California is excluded by owner decision;
  Alaska and Hawaii remain out of scope. All six `[region.*]` blocks were
  rebuilt to keep `rsc gen-configs`' coverage invariant satisfied, and
  `rs_west` is Pacific Northwest only now that `sac` and `la` are gone
  (Seattle, Portland, Spokane, Tacoma, Eugene).
  `search_city` is one location per line with the city named in a trailing
  comment — a third of the entries are opaque numeric ids, and packed five to
  a line they could only be audited by counting positions across into
  `city_name`.

  A full sweep goes from ~1.7 h to ~7.8 h (127 centres x 2 active items at
  ~110 s a search). That is deliberate and costs nothing: `date_listed` is
  `last 7 days`, so every listing stays visible for ~19 sweeps.

  **One worker now searches 127 cities from a single un-proxied Denver IP.**
  `fleet.toml` pairs each region with a proxy in that part of the country
  precisely because a Marketplace search far from the account's IP is what
  Facebook checkpoints on. The sharded fleet is designed for this load; only
  `homelab-1` exists. Bringing up the other five is what actually de-risks it.

- **The AI prompt now puts the listing last, so providers can cache the rest.**
  `get_prompt` built the listing block (title, condition, price, location, URL,
  description) in the middle of the prompt, ahead of the item's own criteria and
  the JSON-verdict instructions — and provider-side prompt caching matches on an
  identical *prefix*, so every call missed the cache from that point on, which
  was most of the prompt. The listing block moved to the very end, after
  everything that is constant for a given item. `configs/master.toml`'s prompt
  was rewritten to state each rule once (the old text repeated the single-unit
  rule four times), but deliberately **not** trimmed below ~1,100 tokens: OpenAI
  will not cache a prefix shorter than 1024 tokens, and falling under that would
  make every input token full price again.

### Fixed

- **`scripts/find-city-id.py` was silently failing on correct cities.** Five
  bugs, each of which reported a city as unresolvable when the lookup had
  actually worked, found while resolving the nationwide list:
  `STATE_NAMES` held 15 states, so anything outside the original east-coast
  set (`Springfield, IL`) could not be state-matched at all; the typeahead was
  only ever given the bare city name, and typing `Nashville` offers Nashville
  OHIO and Nashville PA and *no Tennessee whatsoever* until the full state name
  is typed; the id regex allowed `[a-z0-9]` only, so the qualified slugs
  Facebook hands out for name collisions (`portland_maine`, `fort-myers-fl`)
  were unmatchable and the city was reported unresolved with its id on screen
  (`vegas` is another non-obvious one — Las Vegas is not `lasvegas`);
  the "id must differ from the one the redirect left" guard made a city
  unresolvable whenever it happened to be the location already applied to the
  session; and requiring the state name in the option label rejected cities big
  enough that Facebook labels them without one — `Cincinnati` offers
  "Cincinnati City" and the *Corryville neighbourhood* as "Corryville, OH", so
  the right answer was discarded while the wrong one stayed on the list. The
  state fallback is an exact name match and nothing looser, because anything
  fuzzier reintroduces the silent-wrong-city failure the script exists to
  prevent.

- **A deploy can no longer ship a version that was already deployed.**
  `scripts/deploy.sh` read `VERSION` for its Telegram notification and asked
  nothing of it, while `scripts/release.sh` — the only script that bumps that
  file — was one nobody was obliged to run. The 📦 Releases topic logged deploy
  after deploy as the same `0.4.0`, and that number was not a release at all:
  no `v0.4.0` tag, no release commit, just a hand-edited `VERSION` in a dirty
  tree. `deploy.sh` now runs a version gate before it ships anything: the new
  `scripts/check-release-tag.sh` requires a clean tree and a `v$VERSION` tag
  that points at `HEAD`, and the VM is asked whether it already runs this
  version via a `.rs-deployed` stamp written after each verified deploy.
  `deploy.sh check` is exempt; `sync` is not. `scripts/deploy.sh --redeploy` is
  the escape hatch for re-running a deploy that failed partway, and it labels
  itself as a redeploy in the notification. The notification now reads
  `v0.4.1 (abc1234)` rather than a bare number. `scripts/release.sh` also
  refuses a "bump" that leaves `VERSION` unchanged or moves it backwards, which
  is what let a hand-edited version be re-released as itself.

- **The AI verdict cache now survives across sweeps.** The cache key included
  `item_config.hash`, and `ItemConfig.searched_count` — a runtime counter that
  increments after every sweep — was part of that hash, so the key rotated
  every sweep and `AIResponse.from_cache` could never hit. Every listing still
  sitting in the search results was re-billed to OpenRouter once per sweep:
  over 2026-08-21→24 the fleet paid for 43,111 evaluations of 4,056 unique
  listings (~10×), the worst listing 59 times. `searched_count` is now excluded
  from the hash (the same treatment `Listing.hash` gives the rotating image
  URL), the `ai_eval` OpenSearch event carries a `cached` flag so spend is
  auditable, and a regression test pins the key stable across sweeps. Expect
  the ERP dashboard's daily review counts to drop ~10× — they were inflated by
  the same bug, since only "fresh" verdicts are counted. A manual `--check` of
  a URL now also shares the sweep's cached verdict instead of re-querying the
  model.

## [0.4.0] - 2026-08-24

### Fixed

- **A Telegram send that times out is no longer resent.** The retry loop in
  the vendored monitor's `telegram.py` treated `TimedOut` like any other
  Telegram error and resent the message — but from the VM the Bot API answers
  in 0.7–4s against python-telegram-bot's 5s default read timeout, so the
  "failed" sends had usually been delivered, and one medium-priority alert
  landed three times in its topic on 2026-08-24. The bot now uses a 30s read
  timeout (10s connect), and a send that still times out is treated as
  probably-delivered: logged, not resent. A rare genuinely-lost alert is the
  accepted cost; the coordinator re-review recipe recovers those.

### Added

- **Deploy notifications go to a dedicated 📦 Releases forum topic.**
  `scripts/setup-telegram-topics.py` now also creates the Releases topic and
  prints its `TELEGRAM_TOPIC_RELEASES` id for `configs/secrets.env`; the
  notification at the end of `scripts/deploy.sh` posts into it when the id is
  set (General topic otherwise, as before).
- **Alerts are grouped by priority into Telegram forum topics.** The AI's
  counted units bucket every listing alert — 🔥 high (50+ units), ⚡ medium
  (10–49), 🐢 low (5–9) — the emoji leads the alert title, and each bucket is
  delivered into its own forum topic (`message_thread_id`) so the group's
  topic sidebar doubles as a priority queue. Setup is one command after
  enabling Topics on the group and making the bot a topics-managing admin:
  `scripts/setup-telegram-topics.py` creates the three topics and prints the
  `TELEGRAM_TOPIC_HIGH/MEDIUM/LOW` values for `configs/secrets.env`. Unset
  topic ids and listings whose count the AI could not pin fall back to the
  General topic — grouping never costs an alert. Fleet worker configs strip
  the new keys the same way they strip the token: workers alert through the
  coordinator, not Telegram.

### Changed

- **The AI prompt was deduplicated, and reordered for provider prompt
  caching.** The `master.toml` evaluation prompt said the single-unit rule
  four times and the 5-unit minimum three; each rule is now stated once
  (~12% shorter, same rule set — brand lists, PC4/PC5 label decoding, the
  mixed-lot and eBay-cross-post rules all kept). Bigger cost lever: the
  vendored `get_prompt` used to splice the listing details into the middle
  of the prompt, so no two calls shared a usable prefix; the listing block
  now comes last, after all static instruction text (~1,500 tokens of it),
  which is past OpenAI's 1024-token automatic-caching floor — every
  evaluation after the first per item reuses the cached prefix at the
  provider's discounted rate. Do not trim the static prompt below ~1,100
  tokens or the discount vanishes and every token goes back to full price.
  Changing the prompt rotates `marketplace_config.hash`, so lingering
  listings get one fresh evaluation; `remind = false` keeps already-alerted
  listings from re-alerting. Regenerated `configs/generated/*`.
- **The AI evaluation answers with one JSON object.** The single per-listing
  call now concludes with `{"rating", "unit_count", "count_phrase", "summary"}`
  instead of two grep-able text lines, parsed once by a shared tolerant parser
  (legacy two-line answers still parse). What that buys:
  - the "confidently one unit → never alert" rule is now enforced in code
    (`unit_count == 1` suppresses the alert whatever the score), not just by
    the prompt;
  - fleet workers forward the count to the coordinator (`ai_count`), so the
    coordinator's Telegram alerts finally show `Count: 8 sticks` — previously
    only the homelab's direct-Telegram path printed it. The coordinator adds
    an `ai_count` column via an automatic additive migration on boot;
  - the AI response cache key is versioned, so pre-JSON cached verdicts are
    re-evaluated rather than served stale (a one-time re-evaluation cost);
  - exhausted AI retries raise a clean error instead of an
    `UnboundLocalError`, and a total AI outage — which deliberately still
    fails open and alerts unevaluated listings — now says so at ERROR level.
  After pulling this, regenerate configs (`sh deploy/make-homelab-config.sh`,
  `rsc gen-configs`) and restart the coordinator before the workers.
- **An AI outage now fails CLOSED, and pages the chat.** Previously a failed
  evaluation alerted the listing anyway at a fake score 5 ("Not evaluated by
  AI") — an empty OpenRouter balance flooded Telegram with unevaluated
  listings. Now every alert must carry a real verdict: unevaluated listings
  are withheld and re-scanned once the AI recovers, and the outage itself is
  announced on Telegram once per incident ("AI evaluation DOWN", with the
  last error and the credits link), with a recovery note when evaluations
  resume.
- **Consumer gaming-brand RAM is filtered out** (owner call): Corsair
  (Vengeance, Dominator), G.Skill (Trident, Ripjaws, Aegis), Kingston Fury /
  HyperX, TeamGroup T-Force, Crucial Ballistix, ADATA XPG, and RGB kits are
  rejected — cheaply by antikeywords (before the detail fetch and the AI
  call) and as a prompt reject rule. Plain/OEM desktop and laptop modules
  still qualify.
- **`max_tokens` lowered 8192 → 4096** so evaluations keep fitting a low
  OpenRouter balance (the drained balance 402'd 8192-token requests on
  2026-08-22 and took every evaluation down).
- **Telegram listing alerts show the whole AI verdict.** The direct-Telegram
  alert (the homelab path) now prints price, location, `Count:`, `AI rating:
  N/5`, and the AI's one-line summary; any piece the AI could not establish
  just drops its line.
- **The minimum lot size is now 5 units** (was 3). The prompt rejects lots
  under 5, and a new `min_unit_count = 5` in `configs/master.toml` enforces it
  in code: a listing the AI counts at fewer than 5 units never alerts,
  whatever its score. An uncounted listing is never suppressed on doubt. The
  vendored default is 2, which preserves the confident-single-unit rule.
- **Every `scripts/deploy.sh` run ends with a Telegram notification** (sent
  through the coordinator's live credentials on the VM, non-fatal on failure)
  saying which version and commit were deployed and verified.
- **AI completions are capped at `max_tokens = 8192`** (configurable per
  `[ai.*]` agent). OpenRouter prices an uncapped request at the model's full
  65536-token output ceiling and 402s any balance below it — which is how a
  nearly-empty credit balance turned into "every evaluation fails" even
  though each verdict costs a few dozen tokens.

- **Listing alerts show the AI's unit count.** The rating prompt now asks the
  model to state the quantity it worked out on its own `Count:` line, and the
  compact alert prints it between the price and the link (`count: 8 sticks`).
  When the text gives nothing to count, the alert is unchanged. The Messenger
  alert's count (rs_coordinator) is unaffected.
- **The AI model is now `openai/gpt-5.6-luna`** (was `google/gemini-2.5-flash`)
  for both the monitor's listing evaluation (`configs/master.toml`) and the
  coordinator's Messenger item count (`RS_AI_MODEL` default) — the budget tier
  of the current GPT line on OpenRouter, ~10x cheaper on output than its full
  siblings. After pulling this, regenerate configs (`sh
  deploy/make-homelab-config.sh`) or just deploy.

- **DDR3 and DDR2 memory are no longer bought.** The AI filter now accepts
  DDR4/DDR5 lots only (server RDIMM/LRDIMM, desktop DIMMs and laptop SODIMMs
  all still qualify); DDR3/DDR2-only lots are rejected, and a mixed-generation
  lot is judged on its DDR4/DDR5 modules alone. The prompt also teaches the
  model the PC3/PC4/PC5 label prefixes so unlabeled generations can be read
  off module stickers. The `ddr3` title-gate keyword deliberately stays:
  removing it would silently drop mixed lots titled "DDR3/4", and the gate's
  job is category, not generation. After pulling this, regenerate configs:
  `sh deploy/make-homelab-config.sh && rsc gen-configs`.

- **A listing the AI is confident is a single unit never alerts.** "Fewer
  than 3 units" was already a reject rule, but an attractive one-off — a lone
  128GB module, a 15TB drive priced to move — could still talk its way up the
  scale on capacity or price and clear the `rating = 4` alert threshold. The
  prompt now makes the single-unit case outrank everything else about the
  listing: confident single, rate 1, whatever the capacity, price or
  condition, and "large"/"high-value" at rating 5 describes the lot rather
  than the unit. Genuine doubt about the count still goes to the
  quantity-unclear path (rating 2), which does not alert either.

- **AI evaluation is text-only, deliberately.** Attaching the listing's photos
  to the evaluation was tried and removed before release: multimodal calls cost
  several times a text call on every listing the fleet visits, and the fleet
  visits a lot of them. The AI still does the reading that matters — the prompt
  now tells it to work the unit count out of the *description*, where sellers
  usually bury it ("$8 each, 40 available", "3 trays of 8") instead of putting
  it in the title. A listing whose text gives nothing to count is rated
  unlikely, as it was before.

### Added

- **Seller-rating filter.** Listings from sellers Facebook itself rates below
  `min_seller_rating` (set to 4.5 in `master.toml`) are dropped before the AI
  call — a rating under 4.5 is other buyers reporting a problem, and this
  business drives to a stranger's address with cash. The rating is read from
  the GraphQL payload already embedded in the listing page, so it costs no
  extra request; skips are logged with reason `seller_rating`.
  - Sellers with **no** rating still get through. On Marketplace that is the
    normal state of a private seller, not a warning, and rejecting them would
    discard most of what the fleet finds. `exclude_unrated_sellers = true`
    (per marketplace or per item) requires a rating instead.
  - The rating is deliberately kept out of `Listing.hash`: it drifts with the
    seller's other sales, and counting it would re-alert the whole backlog.
  - After pulling this, regenerate worker configs: `rsc gen-configs`.

## [0.3.0] - 2026-08-21

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

<!-- scripts/release.sh does not maintain these; add each new version's line by
     hand. 0.1.0 and 0.4.0 were never tagged, so they have no link, and 0.5.0's
     compare spans 0.4.0 as well. GitHub compares are not path-filtered: one
     that crosses the 2026-10-16 import into the monorepo lists the whole ERP
     history, which is why [Unreleased] has no link, and later ones list the ERP
     commits in between. `git log <from>..<to> -- trackers/facebook` shows only
     this tree. -->
[0.5.5]: https://github.com/JinhuW/recycle_servres_erp/compare/facebook-tracker/v0.5.4...facebook-tracker/v0.5.5
[0.5.4]: https://github.com/JinhuW/recycle_servres_erp/compare/facebook-tracker/v0.5.3...facebook-tracker/v0.5.4
[0.5.3]: https://github.com/JinhuW/recycle_servres_erp/compare/facebook-tracker/v0.5.2...facebook-tracker/v0.5.3
[0.5.2]: https://github.com/JinhuW/recycle_servres_erp/compare/facebook-tracker/v0.5.1...facebook-tracker/v0.5.2
[0.5.1]: https://github.com/JinhuW/recycle_servres_erp/compare/facebook-tracker/v0.5.0...facebook-tracker/v0.5.1
[0.5.0]: https://github.com/JinhuW/recycle_servres_erp/compare/facebook-tracker/v0.3.0...facebook-tracker/v0.5.0
[0.3.0]: https://github.com/JinhuW/recycle_servres_erp/compare/facebook-tracker/v0.2.0...facebook-tracker/v0.3.0
[0.2.0]: https://github.com/JinhuW/recycle_servres_erp/tree/facebook-tracker/v0.2.0
