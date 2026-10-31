# WS-G — Facebook tracker code defects (review-fix plan)

Planned against `origin/dev` f0c1d856, facebook tracker 0.15.0. Planning only.

## 1. Goal and scope

This workstream fixes the defects in `trackers/facebook` that sit outside login
safety (WS-A), secrets/edge (WS-C) and deploy gates (WS-D): alert delivery,
incidents, coordinator write atomicity and schema, the console's settings and
VNC paths, auth edges, the Messenger outbound queue, the dormant bridge clients
(poster, messenger, router), and the build/release tooling. **No ticket here
needs a worker restart, so none causes a Facebook login.** Coordinator and
console changes ship by recreating only `rs-coordinator` or `rs-console`, never
with a full `scripts/deploy.sh` (see *Deploy recipes*).

Every cited line was re-read on f0c1d856, and every finding still holds. Lane
B3's container inventory of the VM (`docs/review-2026-10-31/lanes/B3.json`)
shows only rs-coordinator, rs-coordinator-lan (the haproxy relay), rs-console,
rs-console-tunnel and fleet workers running. **No rs-router, rs-messenger,
rs-poster or Matrix container runs**, so the bridge-client fixes (G9) are code
only.

Findings covered (33): A10-05, A10-07, A10-08, A10-10, A10-11, A10-12, A10-13,
A10-15, A10-20, A10-22, A10-23, A10-24, A10-25, A10-26, A10-27, A10-28, A10-29,
A10-30, A10-31, A10-32, A10-33, A10-34, A10-35, A10-36, A10-37, A10-38, A10-39,
A10-40, A10-41, A10-42, A10-43, A10-44, B3-02.

### Conventions for every ticket

- **Ticket and PR.** Each ticket is one RS-nnn (`scripts/ticket.sh new`), one
  PR to `dev`, squash-merged. The exception is a PR that carries a facebook
  release commit and tag: that one is merged with a **merge commit**, so the tag
  stays reachable on `dev`.
- **Versioning.** Changes go under `[Unreleased]` in
  `trackers/facebook/CHANGELOG.md`. Releases are cut with
  `scripts/release.sh patch` and batched as in §3. Before tagging, check the
  newest `facebook-tracker/v*` tag, because concurrent sessions collide. Any
  ticket that also touches `apps/` bumps the ERP root `package.json` and adds a
  `## [X.Y.Z]` section to the root `CHANGELOG.md`.
- **Database.** A coordinator schema change goes in through `*_EXTRA_COLUMNS`
  in both `db.py` (SQLite) and `pg.py` (Postgres), and updates
  `docs/DATABASE.md` in the same PR.
- **Tests.** Coordinator:
  `AIMM_PYTHON=… .venv-coordinator/bin/python -m pytest rs_coordinator/tests`.
  Console: run from inside `rs_console/`. Router: `rs_router/tests` (by hand
  until G10 lands). Postgres tests run against a throwaway on a free port,
  **never 5432 or 55432**.

### Deploy recipes (no worker restart)

- **Coordinator-only (DR-C).**
  1. Drift check: `rsync -anc --itemize-changes` of the tag's `rs_coordinator/`
     (from `git archive`) against the VM.
  2. Rsync `rs_coordinator/` only.
  3. Run `docker compose -f deploy/docker-compose.coordinator.yml up -d --build --force-recreate coordinator`
     **without** `docker-compose.coordinator-lan.yml`. The relay
     `rs-coordinator-lan` already owns 10.10.10.73:8500 (A10-38).
  4. Verify `/healthz` (version, `backend: postgres`, `alert_backlog`) through
     the relay.

  Rollback: re-sync the previous tag's `rs_coordinator/` and recreate again.
  Additive columns stay in place harmlessly.
- **Console-only (DR-K).** Same pattern for `rs_console/` and
  `deploy/docker-compose.console.yml` (the `console` service only). Rollback is
  the same.
- If WS-D lands a `deploy.sh coordinator|console` mode, use it in place of these
  recipes.

## 2. Tickets

### Summary

| # | Title | Findings | Sev | Versions under | Deploy | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | City-event `via` accepts fleet values | B3-02 | P2 | facebook | DR-C | S |
| G2 | Telegram delivery: escaping, fallback, dead letters, durable ops pages, lost topics | A10-05, A10-30, A10-31 | P2 | facebook | DR-C | M |
| G3 | Atomic incident votes and listing + alert writes | A10-08, A10-10 | P2 | facebook | DR-C | M |
| G4 | Console settings save: state first, partial-failure report, file lock | A10-11, A10-25 | P2 | facebook + ERP patch | DR-K | M |
| G5 | Console event loop and VNC: no blocking call on the loop, ticket-first ws, locked TicketStore, null fleet keys | A10-12, A10-26, A10-28, A10-29 | P2 | facebook | DR-K | M |
| G6 | Coordinator/console auth and input edges | A10-13, A10-23, A10-24, A10-27, A10-32 | P3 | facebook (+ERP patch only if needed) | DR-C + DR-K | M |
| G7 | Re-login records who asked and has a server-side cooldown | A10-22 | P3 | facebook + ERP minor | DR-C + DR-K, then ERP | M |
| G8 | Messenger outbound claim/lease, owned ack, atomic auto-reply | A10-07, A10-34 | P3 | facebook | DR-C | M |
| G9 | Dormant bridge clients: poster lock, router txn ids, multi-line replies, duplicate ads | A10-15, A10-20, A10-36, A10-41 | P3 | facebook | none (not running) | M |
| G10 | Build, release and deploy tooling | A10-37, A10-38, A10-39, A10-42, A10-43 | P3 | facebook | console pin rides DR-K | M |
| G11 | Coordinator vault and Telegram small fixes: vault unreadable, email-code slack | A10-33, A10-35 | P3 | facebook + ERP patch | DR-C + DR-K | S |
| G12 | Terraform state for the coordinator Postgres | A10-40 | P3 | facebook (infra only) | none | S |

---

### G1 — City-event `via` accepts the fleet's values (B3-02, P2)

The ERP fleet hands its workers a `why` from {probe, manual, familiar, other},
and the worker posts it as `via`. Since 2026-10-29 every `started` event from an
ERP-fleet worker has been rejected with 422: about 700 a day.

**Change**

- `rs_coordinator/rs_coordinator/schemas.py:309`: `CityEventReport.via` becomes
  `str | None = Field(default=None, max_length=20, pattern=r"^[a-z][a-z_]{0,19}$")`.
  A constrained string, not a wider `Literal`, so the next fleet `why` does not
  422 again.
- `city_log.py:268`: add labels to the label map: `probe` → "from the fleet
  (probe)", and the same for `manual`, `familiar` and `other`. Line 178 is
  unchanged.
- The ERP's `FleetCityLog.tsx:85` already falls back to the generic "started"
  label, so the ERP needs no change.

**Tests.** Port `docs/review-2026-10-31/repro/B3-verify/test_city_event_via.py`
into `rs_coordinator/tests/test_city_log.py`, inverted:

- `POST /v1/workers/{id}/city-events` with `event=started` and `via` set to
  each fleet value returns 200, and `GET /v1/city-log` returns the `via`.
- `via="Bad Value!"` returns 422.

**Owner gates**

1. OK to recreate `rs-coordinator` (DR-C)? This is not a Facebook login.
   Workers' coordinator calls fail for about 30 s and retry.

**Rollout and verification.** Coordinator-side only and backward compatible.
After the deploy, `docker logs --since 1h rs-coordinator | grep city-events | grep -c ' 422'`
should be 0. The ERP's city log for a `worker-60-14-N` should show `started`
rows again.

**Effort:** S.

---

### G2 — Telegram delivery (A10-05 P2, A10-30, A10-31)

**Change**

- **Escaping (A10-05).** In `telegram_notify.py:18-22`, add `\` to
  `_MARKDOWN_V2_SPECIALS`. The per-character join then escapes it correctly in
  any order.
- **Truncation (A10-05).**
  - `format_listing` (`telegram_notify.py:123-157`) clamps the raw fields
    *before* escaping: title 300, comment 1500, others 200, with `…`. An
    assembled alert then stays under 4096.
  - `send()` (`:69`) stops slicing escaped text. If a message is still over
    `MAX_MESSAGE_LENGTH`, it is sent as plain text instead.
- **400 fallback (A10-05).**
  - `send()` gets a sibling `send_result()` that returns
    `(ok, status, description)`. `send()` stays a thin wrapper, so existing
    callers are unchanged.
  - The description is read from `urllib.error.HTTPError`'s body.
  - On a 400 whose description contains "can't parse entities", resend once as
    plain text: unescape with `re.sub(r"\\(.)", r"\1", text)` and drop
    `parse_mode`.
- **Dead letters (A10-05).**
  - Add an outbox column `dead_at TEXT`. `due_alerts` filters
    `dead_at IS NULL` in both backends.
  - `Background.drain_outbox` (`background.py:116-163`) marks a row dead after
    10 failed attempts that each answered a permanent 4xx (not 429), and
    enqueues one `ops_outbox` alert naming the row id and kind.
  - Transient failures keep retrying with the existing backoff.
- **Durable ops pages (A10-30).** Replace the inline sends with
  `deps.db.enqueue_alert(...)`. Each kind starts with `ops`, so
  `drain_outbox` routes it to the ops notifier.

  | Call site | New kind |
  | --- | --- |
  | `deps.ops_notifier.send` in `routers/health.py:131-137` | `ops_health` |
  | `deps.ops_notifier.send` in `routers/escalation.py:116-121` | `ops_challenge` (keep one per challenge) |
  | `_page_ops` in `routers/logins.py:64` | `ops_login` |

- **Lost topics (A10-31).**
  - In `drain_outbox`, when a send into `message_thread_id` fails with a 400
    "message thread not found", clear the topic: call
    `db.set_thread_fields(ref, {"telegram_topic_id": None})`.
  - The next attempt then reaches `ensure_topic` (`telegram_topics.py:97-99`)
    with no stored id and creates a new topic.
  - Update `ensure_topic`'s docstring to match.

**Tests**

- `rs_coordinator/tests/test_telegram_notify.py`: port
  `repro/A10-verify/a10_05_markdown_escape.py`, inverted.
  - `escape_markdown("a\\")` ends in `\\\\`.
  - A 5000-char title with a trailing `\` yields text under 4096 with balanced
    `*`.
  - A fake `urlopen` that answers 400 "can't parse entities" leads to a second
    call with no `parse_mode`.
- `test_outbox.py`:
  - A row marked dead after 10 permanent 4xx answers; one ops alert queued.
  - A 503 never goes dead.
  - "thread not found" clears `telegram_topic_id`, and the next drain creates a
    topic.
- `test_health.py`, `test_escalation.py`, `test_logins.py`: with a notifier that
  raises, the request still returns 200, an `ops_*` outbox row exists, and it
  is delivered by the next drain.
- `test_postgres.py`: `dead_at` migration and `due_alerts` filter.

**Owner gates**

1. OK to recreate `rs-coordinator` (DR-C)?
2. Is 10 permanent-4xx attempts the right dead-letter threshold? Yes/no; the
   default is 10.

**Rollout and verification.** DR-C, alone or batched with G1/G3.

- Read-only outbox check through `docker exec rs-coordinator`:
  `SELECT count(*) FROM outbox WHERE delivered_at IS NULL AND attempts > 3`,
  before and after. Rows stuck on a 400 drain or go dead.
- `/healthz` `alert_backlog` falls.

**Effort:** M.

---

### G3 — Atomic incident votes and listing + alert writes (A10-08 P2, A10-10 P2)

**Change**

- **Incident votes (A10-08).**
  - In `routers/incidents.py`, add a module-level `_incident_lock = threading.Lock()`.
    It wraps `get_incident` → `incidents.apply` → `save_incident` →
    `enqueue_alert` (lines 37-50).
  - This is the same pattern as `routers/queue.py:28 _handout`. It is correct
    because the coordinator is one uvicorn process: `Dockerfile.coordinator:15`
    has no `--workers`. Add a one-line "why" comment saying so.
- **Listing + alert in one transaction (A10-10).**
  - Add `write_listing(key, insert=None, update=None, alert=None) -> bool` to
    `Database` (`db.py`, under `self._lock` with one cursor) and to
    `PostgresDatabase` (`pg.py`, inside one `self.cursor()`, so one connection
    and one commit).
  - It runs `INSERT … ON CONFLICT DO NOTHING` (insert mode) or `UPDATE`
    (update mode) and, when `alert=(kind, text)`, the outbox `INSERT`, all in
    the same transaction.
  - In insert mode, a lost race returns False with no outbox row.
- **Callers (A10-10).**
  - `routers/listings.py:_ingest_one` (`:159-180`) decides the verdict first and
    formats the alert text from the merged record: the insert record, or the
    previous row overlaid with the update fields. It then makes one
    `write_listing` call.
  - `report_listings` (`:105-128`) drops its separate `enqueue_alert`.
  - `record_sighting` stays a separate call; a lost sighting row is harmless.
- `claim_listing` and `update_listing` stay, because `background.py:150` uses
  `update_listing` for `notified_at`.

**Tests**

- Port `repro/A10-verify/test_a10_10_enqueue_failure.py` into
  `rs_coordinator/tests/test_outbox.py`, inverted. Make the outbox insert raise
  once:
  - the first post reports `failed: 1`, and the listing is **not** stored;
  - a second identical post returns `accepted: 1, queued: 1`;
  - one Telegram send follows.
  - Same case for a DISCOUNTED listing: the price is not stored after the
    failure.
  - Mirror both in `test_postgres.py`.
- Port `repro/A10-verify/test_a10_08_incident_race.py` into
  `test_incidents.py`: 8 threads post `down`. Assert one DOWN page and 8
  reporters. A single `up` then leaves the incident open.

**Owner gates**

1. OK to recreate `rs-coordinator` (DR-C)?

**Rollout and verification.** DR-C.

- Read-only:
  `SELECT key, is_open, jsonb_array_length(reporters::jsonb) FROM incidents`
  after the next AI-provider blip.
- The coordinator log has no "Could not ingest listing" lines followed by a
  missing alert.

**Effort:** M.

---

### G4 — Console settings save (A10-11 P2, A10-25)

**Change**

- **`settings.apply`** (`rs_console/rs_console/settings.py:521-538`):
  1. Render everything; a render error still changes nothing.
  2. **Save the state** before writing anything.
  3. Write the local files, then the fleet configs. Each write is in its own
     `try`, catching `OSError`, which includes `FleetError` (`:359`).
  4. Return `(changed, failed)`, where `failed` is
     `[{"target": "fleet:<id>" | "<file>", "error": str}]`.

  The saved state is the source of truth and `apply` is an idempotent re-render,
  so a partial write converges on the next save or deploy.
- **`app.put_settings`** (`app.py:840-857`):
  - Move `settings.stamp`/`save` into the new step 2.
  - Return 200 with `{"updated_at", "updated_by", "changed", "failed"}`.
  - Drop the 500 for a fleet `OSError`. A local `OSError` is reported in
    `failed` too.
- **`set_start_at`** (`:591-617`) and **`put_worker_cities`** (`app.py:860+`)
  get the same semantics.
- **File lock (A10-25).**
  - Add `settings.locked()`, a context manager that takes
    `fcntl.flock(LOCK_EX)` on `<settings.json>.lock` beside the state file.
  - It wraps load → apply → save in `put_settings`, `put_worker_cities`, CLI
    `start-at`, `apply` and `publish`.
  - Keep `_settings_lock` (`app.py:822`) for in-process threads.
- **ERP side** (same PR, contract rule):
  - `apps/frontend/src/lib/coordinator.ts`: add an optional `failed?:` to the
    settings-save response type.
  - The settings save in `DesktopCoordinator.tsx` shows a warning toast listing
    the failed targets when `failed` is non-empty.
  - Bump the ERP patch version.

**Tests**

- `rs_console/tests/test_settings.py`: port
  `repro/A10-verify/a10_11_partial_fleet_write.py`, inverted. A fake fleet's
  `write` raises on the 2nd worker:
  - settings.json carries the new values;
  - the response has `failed=[fleet:<2nd>]`;
  - the 1st and 3rd workers are written.
- A subprocess holds the flock; CLI `start-at` blocks until it is released.
- `apps/frontend`: a unit test for the toast message builder in `lib/`.

**Owner gates**

1. OK to recreate `rs-console` (DR-K)? This is not a login, but the ERP's
   Facebook pages and VNC drop for about 20 s.

**Rollout and verification.** Ship the console first; the new field is optional
for the ERP, so this is backward compatible. Then ERP to `dev`, with the
release to `main` as usual.

- Verify read-only: `GET /v1/fleet` `settings.updated_at` changes after an ERP
  save.
- The console log has no 500 on `PUT /v1/config/settings`.

**Effort:** M.

---

### G5 — Console event loop and VNC (A10-12 P2, A10-26, A10-28, A10-29)

**Change**

- **Event loop (A10-12).**
  - In `app.py:538-541`, `vnc_socket` redeems the ticket **first**: on an empty
    or invalid ticket it closes 1008 without touching the fleet. Only then does
    it resolve targets, with `await asyncio.to_thread(_vnc_targets)`.
  - The async `fleet()` builder (`:578`, the `_vnc_pages()` call at `:718`)
    likewise uses `await asyncio.to_thread(_vnc_pages)`.
  - The `threading.Lock` in `_fleet_vnc_targets` (`:475-503`) is then only ever
    held on threadpool threads. The sync `def` handlers `vnc_page` and
    `vnc_ticket` already run there.
- **TicketStore (A10-26).** `vnc.py:99-118`: add a `threading.Lock` around
  `issue`, `redeem` and `_prune`.
- **VNC page (A10-28).** `vnc_page` (`app.py:515-521`) always serves
  `_shell("vnc.html")`. The 404 for an unknown worker stays on the
  authenticated `POST /v1/vnc/{id}/ticket`, and `vnc.html` already shows the
  ticket error.
- **Fleet keys (A10-29).** In `app.py:748-759`, when `rows is None` (the
  coordinator is down), call `fleet_view.apply_queue(doc, None)` and set
  `doc["city_tiers"] = None`. This matches the documented contract: `null`
  against a coordinator without the queue.

**Tests**

- `rs_console/tests/test_vnc.py`: port
  `repro/A10-verify/a10_12_event_loop_stall.py`, inverted.
  - With a fake fleet whose `state()` sleeps 2 s, a concurrent `/healthz`
    answers in under 0.5 s.
  - A websocket with no ticket closes without calling `fleet.state` (spy).
  - 4 threads × 1000 issue/redeem calls: every ticket redeems exactly once.
  - `GET /vnc/unknown` returns 200.
- `test_fleet.py`: with the coordinator down, `/v1/fleet` has
  `queue: null, city_tiers: null`.

**Owner gates**

1. OK to recreate `rs-console` (DR-K)? Batch it with G4 for one recreate.

**Rollout and verification.** DR-K, together with G4.

- Watch a worker over VNC from the ERP; the session opens.
- `time curl /healthz` against the console stays under 100 ms while `/v1/fleet`
  loads.

**Effort:** M.

---

### G6 — Auth and input edges (A10-13, A10-23, A10-24, A10-27, A10-32; all P3)

**Change**

- **`vnc_url` schemes (A10-13).**
  - In `schemas.py` (`vnc_url` at lines 122, 131, 212, 250 and 610), add a
    shared `field_validator` that keeps only `http(s)://…` or a path starting
    `/vnc/`. Anything else becomes `None` and is logged.
  - It is nulled, **not 422**: a rejected heartbeat would page the worker as
    silent.
  - `static/fleet.js`: `watchButton` (`:81-84`) and the detail link
    (`:667-668`) render only URLs matching `/^(https?:\/\/|\/vnc\/)/i`.
  - Challenge rows prefer `vncFor(ch.worker_id)` over `ch.vnc_url` (`:349`).
  - ERP: audit `apps/frontend/src/lib/fleetView.ts` (`canWatch` already refuses
    config URLs) and every `href={…vnc_url}` in `FleetAccounts.tsx` and
    `FleetWatch.tsx`. Add the same guard only if a raw href exists, as an ERP
    patch bump.
- **Path-id validation (A10-23).**
  - In `rs_console/app.py`, apply `_WORKER_ID` (`:267`) to `worker_relogin`
    (`:271`), `worker_restore`, `put_worker_cities` (`:861`) and
    `put_worker_queue` (`:932`). A bad id returns 400.
  - The coordinator's `request_relogin` (`routers/health.py:196`) returns 404
    when `db.get_worker(worker_id)` is None, instead of letting `db.py:1390` /
    `pg.py:661` upsert a phantom row.
  - `request_restore` keeps its upsert: the cookie-first Assign (WS-A, A4-03)
    may target a slot before its first heartbeat.
- **Legacy-token scope, phase 1 (A10-24).**
  - `poll_directives` (`routers/health.py:186-193`) returns 403 on a
    per-worker token whose id differs from the path, matching
    `queue.py:56,120` and `cities.py:52`.
  - `require_worker` (`deps.py:117-137`) logs one rate-limited INFO line per
    route when the legacy token is used (`legacy_token route=…`), so its live
    users can be counted.
  - Phase 2 is a separate ticket after owner gate 2. It refuses the legacy
    token on `directives`, `next-city`, `city-events`, `search-plan` and the
    outbound ack, then retires `RS_COORDINATOR_TOKEN`. Today
    `rs_messenger/client.py`, `rs_router/client.py`, `alert_report_token` in
    `master.toml`/`homelab.toml` and `rs_worker/entry.py:609` still use that
    variable, so phase 2 is a WS-C credential retirement.
- **Non-ASCII bearer (A10-27).** Compare bytes:
  `compare_digest(a.encode(), b.encode())` in `rs_console/app.py:221` and in
  `deps.py:132,154`. `tokens.py:54,82` compare hex digests and need nothing.
- **Raw worker rows (A10-32).** `GET /api/v1/workers` (`routers/health.py:218-225`)
  returns only the caller's own row to a per-worker token. The legacy token
  still gets every row, for the old monitors that parse it.

**Tests**

- `test_coordinator.py`: a heartbeat with `vnc_url="javascript:alert(1)"`
  returns 200 and stores NULL.
- `test_health.py`:
  - directives with worker A's token on `/v1/workers/B/directives` → 403;
  - relogin for an unknown id → 404 and no row;
  - a per-worker token sees one row on `/api/v1/workers`.
- `test_foundation.py`: `Authorization: Bearer é` → 401, not 500, on worker,
  legacy and admin.
- `rs_console/tests/test_console.py`:
  - a bad id → 400 on all four routes;
  - a non-ASCII bearer → 401.

**Owner gates**

1. OK to recreate `rs-coordinator` and `rs-console`? Ride the G1–G5 recreates.
2. After a week of `legacy_token` log lines (read-only
   `docker logs rs-coordinator | grep legacy_token | sort | uniq -c`), which
   callers may lose the legacy token? This decides the phase 2 ticket.

**Rollout and verification.** DR-C + DR-K.

- No 401/403 spike for live workers in the coordinator log
  (`grep -c ' 403 '` before and after).
- Fleet heartbeats keep landing: the `/v1/workers` liveness count is unchanged.

**Effort:** M.

---

### G7 — Re-login records who asked and has a cooldown (A10-22, P3; a login-causing action)

**Change**

- **Coordinator.**
  - `routers/health.py:196` `request_relogin` takes an optional body
    `{requested_by: str ≤120}`.
  - Store it in a new `workers.relogin_requested_by` column, in both backends
    and in DATABASE.md.
  - Return 409 `{detail, retry_after_s, last_requested_by}` when
    `relogin_last_requested_at` (already a column, `db.py:575`) is within
    `RS_RELOGIN_COOLDOWN_MINUTES` (default 30).
  - Enqueue an `ops_login` alert naming the worker and the requester.
- **Console.** `app.py:271` forwards the JSON body (`_forward(..., json_body=…)`)
  and passes a 409 through.
- **ERP.**
  - `apps/backend/src/routes/coordinator.ts:249` and the re-login call in
    `src/routes/facebookPool.ts` send `{requested_by: <user display name>}`
    from the auth context.
  - The frontend shows the 409's message ("asked N min ago by X") instead of a
    generic error.
  - Bump the ERP minor version, update `docs/FEATURES.md` (Fleet ▸ Re-login),
    and update the README *Contract with the ERP* line in
    `trackers/facebook/AGENTS.md`.

**Tests**

- `test_health.py`:
  - a second re-login within the window → 409, and no new
    `relogin_requested_at`;
  - after the window → 200;
  - `requested_by` is stored.
- `rs_console/tests/test_console.py`: the body is forwarded and a 409 passes
  through.
- `apps/backend/tests/coordinator-routes.test.ts`: the forwarded body carries
  `requested_by`.
- The facebook-pool route test: a 409 from the console surfaces as 409.

**Owner gates**

1. Is a 30-minute cooldown right? Yes/no.
2. Do you want a manager-only "force" override? The default is **no**: there is
   no override.
3. OK to recreate `rs-coordinator` and `rs-console` (rides G6)?

**Rollout and verification.**

1. Ship tracker-side first: the body is optional, so this is backward
   compatible.
2. Then the ERP PR to `dev`, with a later release to `main`.

Verify read-only: `rsc vault logins --limit 20` shows no back-to-back
`relogin` within 30 min, and `SELECT worker_id, relogin_requested_by FROM workers`.

**Dependency:** WS-A owns the UI confirm gates (A6-05, A6-06) and Assign
(A4-03). This server-side cooldown complements them. Agree the 409 handling in
Assign with WS-A before merging the ERP side.

**Effort:** M.

---

### G8 — Messenger outbound claim/lease, owned ack, atomic auto-reply (A10-07, A10-34; P3)

The coordinator side is live, even though no bridge currently runs.

**Change**

- **Claim on fetch (A10-07).**
  - Add `outbound.claimed_at` and `claimed_by` columns (both backends,
    DATABASE.md).
  - Add `claim_outbound(identity, transport, limit, lease_s=300)`.
    - On Postgres it runs `UPDATE … SET status='sending', claimed_at, claimed_by`
      on the rows chosen by `SELECT id … WHERE (status='queued' OR (status='sending' AND claimed_at < now-lease)) … ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED`,
      with `RETURNING`.
    - On SQLite it runs the same under `self._lock`.
  - `fetch_outbound` (`routers/messages.py:139-160`) calls it.
  - `mark_outbound` accepts rows in `sending`.
- **Owned ack (A10-07).** `ack_outbound` (`:163-176`):
  - A per-worker token must equal `row.worker_id`, else 403.
  - The legacy token may ack only rows with `worker_id IS NULL`: the Matrix
    rows the router sends.
  - The clients need no change, because they already fetch and then ack.
- **Atomic auto-reply (A10-34).**
  - Before `enqueue_outbound` (`:113-124`), call
    `db.claim_autoreply(thread_id, now)`:
    `UPDATE threads SET autoreplied_at=? WHERE thread_id=? AND autoreplied_at IS NULL`.
  - Queue the reply and its alert only when rowcount is 1.
  - `autoreply.py:76` already treats any `autoreplied_at` as done.

**Tests**

- Port `repro/A10-verify/test_a10_07_outbound_ack.py` into
  `rs_coordinator/tests/test_messages.py`, inverted:
  - worker B acking A's row → 403;
  - two concurrent fetches return disjoint ids;
  - a row unacked past the lease is fetched again.
- Two threads syncing the same fresh inbound message → exactly one outbound
  row.
- Mirror in `test_postgres.py`.

**Owner gates**

1. OK to recreate `rs-coordinator` (rides G1–G3)?

**Rollout and verification.** DR-C. Read-only:
`SELECT status, count(*) FROM outbound GROUP BY status`. No rows sit in
`sending` past the lease.

**Effort:** M.

---

### G9 — Dormant bridge clients (A10-15, A10-20, A10-36, A10-41; P3)

**Change**

- **Poster lock (A10-15).**
  - `rs_poster/rs_poster/session.py:41-93` `account_lock`: open
    `account.lock` with `O_CREAT|O_RDWR`, take
    `fcntl.flock(LOCK_EX|LOCK_NB)`, and retry until `timeout`.
  - Write the PID into the file for diagnostics only. Never unlink it. The
    kernel releases the lock when the holder dies, and that holds across
    containers on one host sharing the bind-mounted file.
  - Delete `_lock_holder_alive`.
  - Check the vendored monitor for the same PID protocol. If it takes this lock
    too, the change must land on both sides, so note it in `VENDOR.md`.
- **Router transactions (A10-20).**
  - `rs_router/rs_router/matrix.py:40,80-84`: `send_text(room_id, body, txn_key)`
    uses `txn_id = f"rsrouter-{txn_key}"`.
  - In `cli.py:150-157` `drain_outbound`:
    - pass `row["id"]` as `txn_key`;
    - `MatrixError` keeps the HTTP status;
    - 4xx (not 429) still acks `permanent=True`;
    - `URLError`, timeouts, 429 and 5xx are left unacked. G8's lease returns
      the row to the queue, and a retry reuses the same txn id, which Matrix
      dedupes.
- **Multi-line replies (A10-36).** `rs_messenger/rs_messenger/sender.py:228-230`:
  - type each line, with `page.keyboard.press("Shift+Enter")` between lines;
  - press `Enter` once at the end;
  - `make_probe` (`:77-79`) already collapses whitespace.
- **Duplicate ads (A10-41).** `rs_poster/rs_poster/poster.py:180-238`
  `create_listing` refuses, and logs, when `self.state` has an active ledger
  row for the same ad@city. A new `--replace` flag deactivates the old row
  first, so `upsert` no longer orphans the first listing.

**Tests**

- `rs_poster/tests/test_poster.py`:
  - replace the PID tests at `:225-232` with flock tests: a second process
    (multiprocessing) blocks on a held lock, and frees it when the holder is
    killed with SIGKILL;
  - a duplicate ad@city is refused.
- `rs_router/tests/test_bridge.py`: port `repro/A10-verify/a10_20_router_txn.py`,
  inverted.
  - Two `MatrixClient` instances sending different rows use distinct txn ids.
  - The same row id gives the same txn id.
  - A 503 is not acked permanent.
- `rs_messenger/tests/test_sender.py`: a fake page records the keystrokes, and a
  2-line reply gives one `Enter`.

**Owner gates**

1. Will the poster, messenger or Matrix bridge run again? If **no**, replace
   this ticket with a retirement ticket (remove the packages, compose files and
   docs) and close these four findings by it.

**Rollout and verification.** Ships in the next facebook release. There is
nothing to deploy, because none of these containers runs. Verification is the
suites, plus `rs-poster post --dry-run` when the poster is next used.

**Dependency:** G8 lands first, for the lease the router relies on. G10 adds
`rs_router` to `release.sh`.

**Effort:** M.

---

### G10 — Build, release and deploy tooling (A10-37, A10-38, A10-39, A10-42, A10-43; P3)

**Change**

- **Region proxy credentials (A10-37).**
  - `deploy/make-region-config.py:82-86`: also rewrite
    `proxy_username = "${PROXY_HOMELAB_USER}"` → `${<proxy_var>_USER}` and
    `proxy_password` → `${<proxy_var>_PASS}`.
  - Each `replace` asserts exactly one hit, and raises otherwise.
- **Coordinator LAN override vs the relay (A10-38).**
  - Delete `deploy/docker-compose.coordinator-lan.yml` and the `-lan` branch in
    `scripts/deploy.sh:368-371`. The haproxy relay
    (`docker-compose.coordinator-relay.yml`, container `rs-coordinator-lan`) is
    the LAN listener.
  - Document the relay in `deploy/README.md`.
  - Firewalling has two parts: an owner gate for DOCKER-USER rules on the VM,
    and htpasswd on `docker-compose.registry.yml` if the registry is still
    used.
  - **Fold this into WS-D's deploy.sh topology PR (A10-02) if that PR is open**,
    because both edit the same coordinator step.
- **Pinned images (A10-39).**
  - `deploy/docker-compose.console.yml:78`: pin `cloudflare/cloudflared` by
    version and digest.
  - `:20`: tag `rs-console:${RS_VERSION}`.
  - `docker-compose.matrix.yml`: pin conduit, mautrix-meta and rs-router.
  - `Dockerfile.messenger:13`: `ARG AIMM_IMAGE=ghcr.io/jinhuw/aimm-recycle:0.15.0`
    and `FROM ${AIMM_IMAGE}`. `release.sh` bumps the default.
- **Monitor image commit (A10-42).** `scripts/build-monitor-image.sh:21-26`:
  `COMMIT=$(git -C "$ROOT/ai-marketplace-monitor" rev-parse --short HEAD)`, and
  the dirty check runs `git -C "$ROOT/ai-marketplace-monitor" status --porcelain`.
- **Release coverage (A10-43).** `scripts/release.sh`:
  - add `run_suite rs_router …` after `rs_messenger` (`:153`);
  - add `rs_router/pyproject.toml` and `rs_router/rs_router/__init__.py`
    (`__version__ = "0.1.0"`) to both bump lists (`:172-195`), so it joins the
    fleet version;
  - update the AGENTS.md *Tests* note that says `release.sh` skips the router.

**Tests**

- `scripts/tests/test_make_region_config.py` (new, next to the existing script
  tests): the generated config names `${PROXY_<REGION>_USER}`/`_PASS`, and an
  unmatched template raises.
- `scripts/release.sh --dry-run patch` runs the `rs_router` suite.
- `sh scripts/tests/test-deploy-filter.sh` still passes.

**Owner gates**

1. Read-only `ls ~/recycle_servers/facebook_tracker/configs/secrets.coordinator-lan.env`
   on the VM. If it exists, a full `deploy.sh` today would fail to bind
   10.10.10.73:8500.
2. Is the private registry (`docker-compose.registry.yml`) still used? If not,
   remove it rather than add htpasswd.
3. Add DOCKER-USER rules limiting 8500 and 5000 to the LAN and fleet hosts? This
   is a live firewall change, so it is the owner's to apply.
4. Is `rs_fleetd` retired? (The VM runs no `rs-fleetd` container.) If yes, mark
   it legacy in AGENTS.md and README; WS-I owns the doc edit.
5. Recreating the console with the pinned cloudflared blips the tunnel. Ride
   the G4/G5 DR-K recreate?

**Rollout and verification.** Code-only, except the console pin, which rides
DR-K. Verify `docker inspect rs-console-tunnel --format '{{.Config.Image}}'`
shows the digest.

**Effort:** M.

---

### G11 — Vault unreadable flag and email-code skew (A10-33, A10-35; P3)

**Change**

- **Vault unreadable (A10-33).**
  - `routers/accounts.py:38-44` `_stored_secrets` and `vault.py:189-195`: on
    `VaultError`, return a marker instead of `{}`.
  - `AccountOut` (schemas) gets `vault_unreadable: bool = False`, and the
    console passes it through.
  - ERP `lib/coordinator.ts` adds the optional field. `FleetAccounts.tsx` shows
    "vault key cannot open this account's secrets" in place of "unset", as an
    ERP patch bump.
  - MultiFernet and `rsc vault rekey` are **deferred to WS-C**, which owns key
    rotation.
- **Email-code skew (A10-35).** `email_codes.py:280-295` `message_is_recent`:
  compare `sent >= cutoff - timedelta(seconds=120)`, with
  `RS_EMAIL_CODE_SKEW_S` overriding the default.

**Tests**

- `test_accounts.py`: a blob sealed with another key gives
  `vault_unreadable: true`, with the identity fields still present.
- `test_email_codes.py`: a message dated 60 s before `since` is accepted;
  300 s before is rejected.
- ERP: `fleetView.test.ts` case for the label.

**Owner gates**

1. OK to recreate `rs-coordinator` and `rs-console` (rides G6/G7)?

**Rollout and verification.** Tracker first, then the ERP. Verify read-only:
`GET /v1/accounts` via the console shows `vault_unreadable: false` on every
row.

**Effort:** S.

---

### G12 — Terraform state for the coordinator Postgres (A10-40, P3)

**Change**

- `trackers/facebook/infra/terraform/main.tf:40`: enable the commented
  `backend "s3"` block, pointed at the shared R2 state bucket the ERP's
  `infra/` uses, with a distinct key.
- `postgres.tf`: add `lifecycle { prevent_destroy = true }` to the Railway
  project resource, not only the service (`:42`).
- Document `terraform init -migrate-state` in `infra/terraform/README` (or the
  tracker README *Infra*).
- The scheduled `pg_dump` to R2 is **WS-C's**: it reuses `backup/`'s R2 writer
  and lock rule.

**Tests.** `terraform validate` and `terraform plan` show no resource changes.

**Owner gates**

1. Provide the R2 state credentials and Cloudflare token locally, then run
   `terraform init -migrate-state` and `plan`. This is a live state write.
2. Delete the local `terraform.tfstate` after the migration is confirmed.

**Rollout and verification.** `terraform state list` against the remote backend
matches the local list. `plan` is empty.

**Effort:** S.

## 3. Order

| Step | Tickets | Release / deploy |
| --- | --- | --- |
| 1 | **G1** first: smallest, P2, live 422s every day | Release R1 (patch) + DR-C |
| 2 | **G2**, **G3**, **G8** (all coordinator) | Release R2 + one DR-C |
| 3 | **G4**, **G5** (console, with G4's ERP side) | Release R3 + one DR-K; ERP PR after |
| 4 | **G6**, **G11**, **G7** tracker side (coordinator + console) | Release R4 + one DR-C + one DR-K; then the ERP PRs for G7 and G11 |
| 5 | **G10**, then **G9** (needs G8's lease and G10's router suite) | Release R5, code-only (console pin rides the next DR-K) |
| 6 | **G12** | Infra, whenever the owner has R2 state credentials |

G1 can merge alone if speed matters. Otherwise batch R1 into R2 to save one
coordinator recreate.

### Cross-workstream dependencies

- **WS-A (login safety).**
  - G7's cooldown must agree with WS-A's Assign (A4-03) and the confirm gates
    (A6-05, A6-06).
  - None of WS-G restarts workers. WS-A's worker-image releases remain the only
    login-causing deploys.
- **WS-C (secrets, backups, edge).**
  - A10-01 recreates rs-console to split `secrets.env`; do it in the same DR-K
    window as G4/G5, so the console is recreated once.
  - B2-01 (Access on fbc-api) does not conflict with G5's ticket-first
    websocket.
  - G6 phase 2 (retiring the legacy token), G11's vault rekey and G12's
    `pg_dump` are WS-C's.
  - A10-44 waits on WS-C's rotation confirmation (A11-02, B1-02).
- **WS-D (deploy gates).**
  - A10-02 rewrites `deploy.sh`'s topology; G10's A10-38 edit folds into it.
  - A coordinator/console-only deploy mode from WS-D, if added, replaces
    DR-C/DR-K.
- **WS-B (ops alerting).** G2's `ops_outbox` dead-letter page is a new Telegram
  ops kind; tell WS-B so their routing and quiet rules include it.
- **WS-I (docs).** Each ticket edits its own README, AGENTS, FEATURES and
  DATABASE lines. WS-I owns the `rs_fleetd`-legacy doc pass (G10 gate 4) and
  C2-02 (the facebookPool.ts contract docs that G7 touches).

## 4. Dropped / deferred

| ID | Disposition | Reason / exact action |
| --- | --- | --- |
| A10-44 | **Deferred to an owner action**, no PR | Live VM files, no code. After WS-C confirms the 2026-10-22 rotation (A11-02, B1-02), the owner deletes `~/recycle_servers/facebook_tracker/configs/secrets.env.bak-*` on 10.10.10.73, keeping at most the newest post-rotation copy offline in vaultwarden. Verify with `ls configs/secrets.env.bak-* \| wc -l` = 0. It does not touch sessions, so it is not a login. |

Nothing was dropped as wrong or already fixed: all 33 findings still hold on
f0c1d856. Four calls differ from the reviewer's proposed fix:

- **A10-13.** The heartbeat drops a bad `vnc_url` instead of answering 422, so
  a bad field cannot page a live worker as silent.
- **A10-23.** `restore-session` keeps its upsert.
- **A10-24.** The legacy token is retired in two phases, gated on measured
  use.
- **A10-33 and A10-40.** Only part of each is planned here: the rekey and the
  `pg_dump` go to WS-C.

## Owner gates (count)

Unique decisions or actions:

- **G1/G2/G3/G6/G7/G8/G11** (one gate per DR window, five windows in total):
  recreate rs-coordinator; recreate rs-console.
- **G2:** the dead-letter threshold.
- **G6:** legacy-token callers.
- **G7:** the cooldown length; force override yes/no.
- **G9:** run the bridge again, or retire it.
- **G10:** the lan env file on the VM; registry still used; DOCKER-USER rules;
  `rs_fleetd` retired; the tunnel blip.
- **G12:** state migration; delete local state.
- **A10-44:** delete the backups.

That is **16 owner gates**: 2 recreate approvals (coordinator, console) and 14
decisions or actions.
