# Contracts (RS-394)

Everything two workstreams both depend on. Change it only in a PR that also
changes the code and names the affected workstreams.

## Changes after freeze

The contract was frozen before any code landed. These are the places where
what shipped on `dev` differs from or adds to the frozen text; the sections
below now say what shipped. Where the two disagreed the backend won: it is
what answers.

| Change | Section | PR |
| --- | --- | --- |
| Migration is `0206_fleet.sql` (0205 was taken) | §1, §4 | #875 |
| Six FK indexes added to the schema | §4 | #875 |
| `FLEET_WORKER_TOKEN_KEY` derives from `JWT_SECRET` outside production; required in production | §2 | #875 |
| `GET /api/fleet/health` (manager) answers `{ok, tables}` | §7 | #875 |
| `FLEET_ROLE=manager-only` skips the scheduler; `worker-api` is not a route split yet | §2 | #880 |
| Manager routes answer bare rows and arrays, not wrappers, for cities, items, tasks and the city log; city rows carry `open_tasks` and `last_done_at` | §7 | #880 |
| `POST /cities` and `POST /tasks` answer `201`; `409 exists` when the pair is being searched; `409 unverified` when enabling an unverified city | §7 | #880 |
| `PUT /items` takes a bare `FleetItem[]` and upserts (omission does not delete) | §7 | #880 |
| `POST /round/start` answers `{started, skipped}` | §7 | #880 |
| `GET /city-log` answers bare `FleetTaskLog[]`, needs `city` or `worker`, `hours` 1..720 | §7 | #880 |
| Error bodies are `{error, detail?}` with the extra codes `exists` and `unverified` | §5, §7 | #880, #881 |
| Task ids are JSON numbers on the wire | §5, §7 | #881 |
| `next-task` `done` on a task this worker no longer holds is a silent no-op | §5 | #881 |
| Heartbeat `detail` is free-form and stored whole; the monitor puts the epoch in `detail.epoch` | §5 | #881, #879 |
| Worker VNC relay protocol and the manager path `/api/fleet/vnc/:workerId/ws` | §5, §7 | #881 |
| `GET /hosts` answers `{hosts, release}`; host rows carry `desired`; `POST /releases` answers `{ok, release}`; roll state lives in `fleet_settings` key `release` | §6, §7, §8 | #881 |
| Roll gate: the next replacement waits for the replaced worker's heartbeat on the release version | §6 | #881 |
| `POST /slots/:no/unpark`; slot rows carry `parked` | §7 | #881 |
| Agent: exit-code delays, crash limit, VNC port fallback, `RS_VNC_PORT` is the host port | §6, §10 | #877 |
| Shared worker env (`OPENROUTER_API_KEY`, `TELEGRAM_*`, …) that the rendered config needs: supplier undecided | §2 | #879 |
| `next-task` takes `take` (default `true`); `take: false` closes `done`, leases nothing and answers `{task: null, reason: "done_only"}` at once | §5 | #885 |
| On pairing, the VNC relay sends the worker one text frame `viewer` before any viewer byte; the worker dials its VNC server only after it | §5 | #888 |
| Images are private OCIR repositories (OCI free tier), not GHCR | §1, §10 | #890 |
| Images are private GHCR packages after all (owner: GHCR while it works, nothing to OCI); OCIR stays an empty fallback | §1, §2, §6, §10 | MVP docs |
| `FLEET_URL` / `RS_FLEET_URL` is the ERP's Cloudflare hostname, never the Railway origin | §2 | this change |
| Shared worker env is decided: the Worker secret `FLEET_WORKER_ENV`, added at the edge to a `200` claim answer as `env` | §2, §5 | this change |
| Agent holds: exit `0`/`143` while the agent ran (`operator_stopped`) and the crash limit (`crash_limit`) leave a worker stopped like `78`; report containers carry optional `hold`, `exit_code`, `image_id`, and the report an optional `agent` identity; repeated `75` backs off; `401/403/404` on `desired` means observe-only; `--` before the image; `FLEET_IMAGE_PREFIX` | §6, §10 | agent review fixes |
| No coordinator in the MVP: `FLEET_COORDINATOR_URL` may be empty, and `settings.coordinator_url` is then `null` | §2, §5 | this change |
| Exit code `78`: the worker cannot connect and waits for an operator; the agent never restarts it | §6, §10 | this change |
| A missing server key is `503 {error: "unavailable"}`, never 401; worker 401s carry `detail` `missing_token` / `bad_token` / `expired_token`; `FLEET_WORKER_TOKEN_KEY_PREVIOUS` for rotation | §2, §3, §5 | RS-406 |
| Claim: `worker_id` must be `<host_id>-<n>`; a claim-id retry or handoff waits for its own slot instead of skipping to another | §5 | RS-406 |
| Handoff reservations carry `reserved_until` (gate timeout) instead of an infinite lease; slot rows add `reserved_until`; park/unpark clear the handoff | §4, §6, §7 | RS-406 |
| `next-task` hands a lease the epoch still holds again instead of leasing a second; the replacement's later epoch is not drained; a wake that finds nothing keeps holding | §5 | RS-406 |
| A `verify-slug` verdict comes only from `finished` with a boolean `matches` and no `detail.error` / `detail.wall` | §5 | RS-406 |
| `PUT /session` needs `c_user` (this account) and `xs` unless `clear: true` | §5 | RS-406 |
| Any non-parked heartbeat (DEGRADED too) renews the task lease, capped at `task_max_minutes` | §5 | RS-408 |
| `fleet_settings` key `retention_days` (default 90, 30..730); the scheduler purges terminal task history older than it hourly; migration `0210_fleet_task_retention.sql` | §4, §8 | RS-409 |
| Coordinator wired for fleet workers on dev: `FLEET_COORDINATOR_URL=http://10.10.10.73:8500` (LAN forwarder), coordinator tokens per worker id in `FLEET_WORKER_ENV` as `RS_CONTROL_PLANE_TOKENS`; alerts withheld unless `env` carries `RS_ALERTS=on` | §2 | facebook-tracker 0.14.2 |
| Proxy list and Add to fleet: `fleet_proxies` (migration `0213_fleet_proxies.sql`), `fleet_slots.proxy_id`; manager routes `GET/POST /proxies`, `PUT/DELETE /proxies/:id`, `POST /slots`, `POST /slots/:no/remove`; slot rows carry `proxy_id`; `fleet_settings` key `max_accounts_per_proxy` (default 2); error codes `account_busy`, `no_login`, `proxy_full`, `in_use`, `leased` | §4, §7, §8, §9 | RS-415 |
| `desired.count` is the capacity capped at the slots the host could run now (held by its workers plus claimable), never below its highest-numbered worker holding one; the manager's `GET /hosts` shows the same count | §6 | RS-415 |
| Claim tickets: `POST /hosts/:id/tickets` mints a single-use bearer per worker container (migration `0211_fleet_claim_tickets.sql`); `claim` takes it beside the host token (deprecated for workers); the agent passes `RS_FLEET_CLAIM_TICKET` (and the same ticket as `RS_FLEET_HOST_TOKEN` for older images), never the host token; containers carry `rs.fleet.claim_ticket=1` and are recreated, not `docker start`ed | §2, §3, §4, §5, §6, §10 | claim tickets (ERP + facebook-tracker 0.14.5) |
| Re-login: `POST /api/fleet/workers/:id/relogin` (manager) queues a one-shot `relogin` the next heartbeat answers once, with `relogin_id` beside it; `409 not_running`; worker rows carry `relogin`; a fresh claim drops an undelivered one (migration `0214_fleet_worker_relogin.sql`). The viewer's input is passed as bytes; view-only is the page's noVNC | §5, §7 | RS-417 |

## 1. Names

| Thing | Value |
| --- | --- |
| Backend module | `apps/backend/src/fleet/` (`scheduler.ts`, `claim.ts`, `tasks.ts`, `hosts.ts`, `auth.ts`, `sql.ts`, `cities.ts`, `workers.ts`, `vnc.ts`, `proxies.ts`) |
| Routes | `apps/backend/src/routes/fleet.ts`, mounted at `/api/fleet` |
| Shared types | `packages/shared/src/fleet.ts` |
| Frontend | `apps/frontend/src/pages/desktop/fleet/*`, `apps/frontend/src/lib/fleet.ts` |
| Host agent | `apps/fleet-agent/` → image `ghcr.io/jinhuw/fleet-agent:<root version>` (private) |
| Worker image | `trackers/facebook/deploy/Dockerfile.worker` → `ghcr.io/jinhuw/aimm-recycle:<facebook-tracker version>` |
| Registry | OCI Container Registry (OCI free tier), **private** repositories. Images are built on the Mac and pushed (OCI's free compute is full). The concrete region key and tenancy namespace are in [`HOSTS.md`](HOSTS.md) |
| Worker entrypoint | `trackers/facebook/rs_worker/entry.py` |
| Migration | `apps/backend/migrations/0206_fleet.sql` (0205 was taken) |

The desktop management page keeps one Monitors ▸ Facebook sidebar entry.
Its tabs are Fleet (`/fleet`), Tasks (`/fleet/tasks`), Cities (`/fleet/cities`),
Analysis (`/fleet/analysis`) and Account pool (`/fleet/pool`). Retired UI paths
`/fleet/queue`, `/fleet/hosts` and `/fleet/slots` redirect to Tasks, Fleet and
Fleet respectively. Purchasers still see Account pool only. This changes no
HTTP payloads; the manager APIs below keep their existing paths.

## 2. Environment

Backend (Railway `backend`, and `.env` locally):

| Var | Meaning |
| --- | --- |
| `FB_POOL_KEY` | exists; seals pool secrets. Without it (production) `claim` and `PUT /worker/session` answer `503 {error: "unavailable", detail: "FB_POOL_KEY is not set"}` |
| `FLEET_WORKER_TOKEN_KEY` | HMAC key for worker tokens (hex, 32 bytes). **Required in production**: without it every worker route and `claim` answer `503 {error: "unavailable", detail: "FLEET_WORKER_TOKEN_KEY is not set"}`, and the rest of the app boots as usual. Outside production it is optional: the key is derived from `JWT_SECRET` (HKDF-SHA256, info `fleet-worker-token`), so dev and CI need no extra variable |
| `FLEET_WORKER_TOKEN_KEY_PREVIOUS` | optional; the key before a rotation (hex, 32 bytes). A token it signed still verifies, and the worker's next heartbeat answers a token re-signed under `FLEET_WORKER_TOKEN_KEY`. Rotate by moving the old key here and setting a new one; remove it after a day. Without it, every running worker's token is a `bad_token` 401 and the worker exits |
| `FLEET_IMAGE_WORKER` | default worker image ref, e.g. `ghcr.io/jinhuw/aimm-recycle:0.14.0`; `desired.image` falls back to it when no release exists or the last one failed, and `desired.version` is its tag |
| `FLEET_IMAGE_AGENT` | default agent image ref. Not read by the backend yet |
| `FLEET_COORDINATOR_URL` | the Python coordinator, handed to workers at claim as `settings.coordinator_url`. **Empty or unset = no coordinator**: the claim then sends `null` and workers talk to no coordinator at all. Dev since 2026-10-26: `http://10.10.10.73:8500`, the LAN forwarder on the homelab VM that admits only `10.10.60.14` (`HOSTS.md` → *Coordinator route*). A worker with a coordinator but alerts off records only its login ledger there (below) |
| `FLEET_ROLE` | unset or `worker-api`: the whole app **and** the 30 s scheduler tick. `manager-only`: the whole app, no scheduler tick (manager writes still reconcile inline). No value filters routes yet; the `worker-api` route split is future work |

Host agent container:

| Var | Meaning |
| --- | --- |
| `FLEET_URL` | the ERP **through its Cloudflare Worker**: `https://inventory-dev.recycleservers.com` (dev), `https://inventory.recycleservers.com` (prod). Never the Railway origin: only the Worker adds the shared worker env to a claim, and prod's backend refuses requests without the Worker's `X-Proxy-Secret`. (`api.recycleservers.com` is not the ERP.) |
| `FLEET_HOST_ID` | host id as registered in the ERP |
| `FLEET_HOST_TOKEN` | the host's bearer token |

Worker container (set by the agent):

| Var | Meaning |
| --- | --- |
| `RS_FLEET_URL`, `RS_FLEET_HOST_ID` | the ERP and the host; `RS_FLEET_URL` is the agent's `FLEET_URL` unchanged |
| `RS_FLEET_CLAIM_TICKET` | the single-use claim ticket the agent minted for this container right before `docker run` (§6). Fleet mode is on when `RS_FLEET_URL`, `RS_FLEET_HOST_ID` and either this or `RS_FLEET_HOST_TOKEN` are set; the ticket wins |
| `RS_FLEET_HOST_TOKEN` | **the same ticket** from an agent with claim tickets, so a worker image before facebook-tracker 0.14.5 (which reads only this name) still claims. From an older agent, the host token itself (deprecated for workers) |
| `RS_FLEET_WORKER_ID` | `<host_id>-<n>` chosen by the agent |
| `RS_VNC_PORT` | the **host** port the agent published (`127.0.0.1:<port>:5900`); the worker reports it in heartbeats |
| `RS_FLEET_HANDOFF_EPOCH` | only on a replacement for a confirmed stop (§6, §10) |

These are the only variables the agent passes (`apps/fleet-agent/src/docker.ts`).
The host token never enters a worker container: one runs Chromium on
Facebook, and the host token claims any free account on its host (password,
TOTP seed, cookies) and confirms its siblings stopped.

**Shared worker env: a Cloudflare Worker secret.** The config the worker
renders (`trackers/facebook/rs_worker/config.template.toml`) expands `${VAR}`
references from the container's environment: `OPENROUTER_API_KEY`,
`TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_TOPIC_HIGH`,
`TELEGRAM_TOPIC_MEDIUM`, `TELEGRAM_TOPIC_LOW`, `RS_ALERT_REPORT_URL`,
`RS_COORDINATOR_TOKEN`, `RS_CONTROL_PLANE_TOKEN` (`RS_FB_PASSWORD` /
`RS_FB_TOTP` are set by the entrypoint from the claim). They live in one
secret on the ERP's Cloudflare Worker (`deploy/cloudflare/worker.js`,
`recycle-erp-dev` / `recycle-erp-prod`):

| Worker secret | Meaning |
| --- | --- |
| `FLEET_WORKER_ENV` | a JSON object of env var name → string value. On a `200` answer to `POST /api/fleet/worker/claim` the Worker adds it to the body as `env` (§5). Absent or not an object of strings: no `env` key, and the Worker logs one line that never carries the value |

The secrets never enter Railway or Postgres, and the agent never holds them.
Who receives them is still the backend's decision: only a claim the host
token or claim ticket check let through is a `200`. The worker applies `env` to its own
environment before it renders the config (an entry the container already
sets is not overridden).

Keys the worker reads from `env` beyond the template's references
(facebook-tracker 0.14.2):

| Key | Meaning |
| --- | --- |
| `RS_CONTROL_PLANE_TOKENS` | **The coordinator tokens, supplied by the operator** from the VM: a JSON object (as one string) of fleet worker id → `rsc mint-token --worker <id>` (stateless HMACs of the id under the coordinator's `RS_WORKER_TOKEN_SECRET`; minting writes nothing). The entrypoint exports only its own worker's token as `RS_CONTROL_PLANE_TOKEN` and `RS_COORDINATOR_TOKEN` and drops the map; a worker id missing from it exits `70` before the browser when a coordinator is configured. Dev carries ids `worker-60-14-1` … `-8`; a new host or a capacity above 8 needs the secret re-put with more ids. The fleet-wide legacy `RS_COORDINATOR_TOKEN` is deliberately not used: with it the coordinator trusts the worker id in the request body, so one leaked container could read any worker's 2FA codes and credentials |
| `RS_ALERTS` | `on` lets fleet workers alert. **Anything else, or absent (dev today), withholds every alert:** no `[user.*]` Telegram or alert-report key is rendered, `[fleet] alerts = false` makes the monitor skip the alert claim and the send, report no searched city, funnel count, wall or incident to the coordinator, and `RS_CONTROL_PLANE_URL` is unset so no incident goes there. Each of those acts on the live fleet: an undelivered claim holds the listing from the live workers for 15 min, a reported city counts as covered in the live city queue, walls and incidents page the ops chat. Turn it on only after the fleet ships to prod, together with `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_TOPIC_*` and `RS_ALERT_REPORT_URL` (the coordinator URL) |

`FLEET_WORKER_ENV` on dev holds `OPENROUTER_API_KEY` and
`RS_CONTROL_PLANE_TOKENS`, nothing else.

## 3. Auth scopes

| Scope | How | Used by |
| --- | --- | --- |
| manager | existing ERP session cookie + manager role | frontend, `/api/fleet/*` except worker/host routes |
| host | `Authorization: Bearer <host token>` (64 hex chars); `sha256(token)` = `fleet_hosts.token_hash` | `/api/fleet/hosts/:id/*`, `POST /api/fleet/worker/claim` (deprecated for workers: older agents and worker images only, kept for one release) |
| ticket | `Authorization: Bearer fct_<base64url>`; `sha256(ticket)` = `fleet_claim_tickets.token_hash`, minted by the host (§6) | `POST /api/fleet/worker/claim` only: one claim, for the ticket's host, worker id and handoff epoch |
| worker | `Authorization: Bearer <worker token>`: `base64url(json{worker_id, account_no, epoch, exp}) . hmac` with `FLEET_WORKER_TOKEN_KEY`; `exp` = claim + 7 days | `/api/fleet/worker/*` except `claim` |

A worker token whose `epoch` ≠ `fleet_slots.epoch` for its `account_no` (or
whose slot is gone, or whose pool account left the fleet or changed holder) →
`409 {error: "stale_epoch"}` on every worker route. A missing, bad or expired
worker token → `401 {error: "unauthorized", detail}` (§5 lists the details).
A missing or unknown host token, or one used on another host's `:id` → `401
{error: "unauthorized"}`. A ticket is not a host token: on any host route it
is that same `401`. On `claim` a refused ticket is `401 {error:
"unauthorized", detail}`: `bad_ticket` (unknown, or voided by a newer ticket
for the worker), `expired_ticket`, `used_ticket` (spent by another claim),
`ticket_mismatch` (another worker id or handoff epoch). A key missing on the ERP's side → `503 {error:
"unavailable"}`, never 401. Manager routes answer the app's usual `401`/`403`
for a missing session or role.

## 4. Schema (`0206_fleet.sql`)

```sql
CREATE TABLE fleet_cities (
  slug         TEXT PRIMARY KEY,                 -- Facebook location slug or numeric id
  name         TEXT NOT NULL,
  radius_km    INTEGER NOT NULL DEFAULT 500,
  region       TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT FALSE,   -- true once verified or overridden
  per_day      INTEGER,                          -- NULL = follow tiers (WS-G); default rule 1
  pinned       BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at  TIMESTAMPTZ,
  verified_as  TEXT,                             -- the location label Facebook showed
  added_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at  TIMESTAMPTZ
);

CREATE TABLE fleet_items (
  name     TEXT PRIMARY KEY,                     -- 'server_ram', 'enterprise_ssd'
  phrases  JSONB NOT NULL,                       -- ["server ram", ...]
  filters  JSONB NOT NULL DEFAULT '{}',          -- date_listed, delivery_method, max_results, ...
  enabled  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE fleet_settings (                    -- see §8 for keys
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE fleet_hosts (
  host_id       TEXT PRIMARY KEY,                -- 'homelab', 'worker-60-14'
  token_hash    TEXT NOT NULL,
  capacity      INTEGER NOT NULL DEFAULT 0,
  authoritative BOOLEAN NOT NULL DEFAULT FALSE,  -- false = observe only, start nothing
  version       TEXT,
  last_seen_at  TIMESTAMPTZ,
  report        JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE fleet_slots (
  account_no       INTEGER PRIMARY KEY REFERENCES fb_pool_accounts(no) ON DELETE CASCADE,
  worker_id        TEXT,
  host_id          TEXT REFERENCES fleet_hosts(host_id) ON DELETE SET NULL,
  last_host_id     TEXT,
  epoch            INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  proxy_url        TEXT,                         -- scheme://user:pass@host:port, sealed with FB_POOL_KEY
  device           JSONB,                        -- user agent, viewport, timezone, datr hints
  home_cities      JSONB NOT NULL DEFAULT '[]',
  quarantined_until TIMESTAMPTZ,
  note             TEXT NOT NULL DEFAULT ''
);

CREATE TABLE fleet_workers (
  worker_id         TEXT PRIMARY KEY,
  host_id           TEXT REFERENCES fleet_hosts(host_id) ON DELETE CASCADE,
  account_no        INTEGER REFERENCES fb_pool_accounts(no) ON DELETE SET NULL,
  epoch             INTEGER,
  state             TEXT,                        -- HEALTHY, SESSION_EXPIRED, CHECKPOINT, CHALLENGE_*, DEGRADED, DEAD
  version           TEXT,
  last_heartbeat_at TIMESTAMPTZ,
  vnc_port          INTEGER,
  detail            JSONB
);

CREATE TABLE fleet_tasks (
  id               BIGSERIAL PRIMARY KEY,
  city             TEXT NOT NULL REFERENCES fleet_cities(slug),
  item             TEXT NOT NULL REFERENCES fleet_items(name),
  kind             TEXT NOT NULL DEFAULT 'search',  -- search | verify-slug | probe
  due_at           TIMESTAMPTZ NOT NULL,
  priority         INTEGER NOT NULL DEFAULT 0,      -- higher first; manual = 100
  state            TEXT NOT NULL CHECK (state IN ('ready','leased','done','cancelled','expired')),
  worker_id        TEXT,
  account_no       INTEGER,
  epoch            INTEGER,
  leased_at        TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  done_at          TIMESTAMPTZ,
  reason           TEXT,                            -- cadence | added | manual | start | probe | verify
  result           JSONB                            -- {cards, opened, reviewed, alerted, seconds, stopped?}
);
CREATE UNIQUE INDEX fleet_tasks_open_idx ON fleet_tasks(city, item, kind) WHERE state IN ('ready','leased');
CREATE INDEX fleet_tasks_due_idx ON fleet_tasks(state, due_at);
CREATE INDEX fleet_tasks_worker_idx ON fleet_tasks(worker_id, leased_at DESC);

CREATE TABLE fleet_task_events (
  id        BIGSERIAL PRIMARY KEY,
  task_id   BIGINT REFERENCES fleet_tasks(id) ON DELETE CASCADE,
  worker_id TEXT,
  kind      TEXT NOT NULL,                          -- handed | started | searched | finished | stopped | released | expired | done
  detail    JSONB,
  at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX fleet_task_events_task_idx ON fleet_task_events(task_id, at);

CREATE VIEW fleet_minutes AS
  SELECT account_no, (leased_at AT TIME ZONE 'UTC')::date AS day,
         SUM(EXTRACT(EPOCH FROM (COALESCE(done_at, LEAST(NOW(), lease_expires_at)) - leased_at))) / 60 AS minutes
  FROM fleet_tasks WHERE leased_at IS NOT NULL GROUP BY 1, 2;
```

The migration also adds the FK indexes the rest of the schema keeps (a
parent delete or a per-host read otherwise scans the child table);
`fleet_tasks_open_idx` leads with `city`, so the city FK needs none:

```sql
CREATE INDEX fleet_cities_added_by_idx    ON fleet_cities(added_by);
CREATE INDEX fleet_settings_updated_by_idx ON fleet_settings(updated_by);
CREATE INDEX fleet_slots_host_id_idx      ON fleet_slots(host_id);
CREATE INDEX fleet_workers_host_id_idx    ON fleet_workers(host_id);
CREATE INDEX fleet_workers_account_no_idx ON fleet_workers(account_no);
CREATE INDEX fleet_tasks_item_idx         ON fleet_tasks(item);
```

A **parked** slot is stored as `lease_expires_at = 'infinity'` with no
worker; nothing claims it.

**Later migrations.** The block above is `0206` as it shipped. Since then:

- `0207_fleet_recovery.sql`: `fleet_task_attempts` (one row per ended lease,
  archived by trigger `fleet_archive_attempt`); `fleet_minutes` rebuilt over
  attempts plus live leases, split at UTC midnight; `fleet_slots` gains
  `claim_id`, `handoff_epoch`, `quarantine_reset_at`, `quarantine_evidence`
  (unique `(host_id, claim_id)`); trigger `fleet_fence_pool_owner` on
  `fb_pool_accounts` (status, holder, uid change or delete of a fleet account
  → slot epoch + 1, no worker, its leased tasks back to `ready`);
  `fleet_tasks_open_idx` now excludes probes, which get
  `fleet_tasks_probe_idx` (one open probe per account).
- `0208_fleet_claim_core.sql`: `fleet_slots.reserved_until` (a handoff
  reservation's deadline, §6; the lease ends with it, so a reservation is no
  longer an infinite lease); index `fleet_tasks_done_account_idx` on
  `(account_no, city, done_at) WHERE state = 'done'` for the pick's familiar
  test.
- `0209_fleet_review_fixes.sql`: index `fleet_tasks_done_pair_idx` on
  `(city, item, done_at DESC) WHERE state = 'done' AND kind = 'search'`;
  `fleet_hosts` agent-instance columns.
- `0210_fleet_task_retention.sql`: index `fleet_tasks_purge_idx` on
  `(COALESCE(done_at, leased_at, due_at), id)` over terminal tasks, for the
  retention purge (§8 `retention_days`).
- `0211_fleet_claim_tickets.sql`: `fleet_claim_tickets` (`token_hash` PK,
  `host_id` → `fleet_hosts` on delete cascade, `worker_id`, `handoff_epoch`,
  `expires_at`, `consumed_at`, `claim_id`, `created_at`), indexed on
  `(host_id, worker_id)` and `expires_at`.
- `0213_fleet_proxies.sql`: `fleet_proxies` (`id` identity, `label`,
  `url_enc` = the whole `scheme://user:pass@host:port` sealed with
  `FB_POOL_KEY`, `host`, `port`, `timezone` IANA, `note`, `created_by` →
  users on delete set null, `created_at`; unique `(lower(host), port)`), and
  `fleet_slots.proxy_id` → `fleet_proxies` on delete set null (indexed). A
  slot made on a proxy copies its `url_enc` into `proxy_url`, which is still
  the only thing a claim reads; removing a proxy leaves a parked slot its
  copy.

Lock order everywhere: pool account (`FOR NO KEY UPDATE`), then slot, then
tasks. The release row (`fleet_settings` key `release`) is locked only by
`desired`/`advanceRoll` and `stopped`; a pick reads it after its slot lock.
A ticket claim locks its `fleet_claim_tickets` row right after the worker's
claim lock (`pg_advisory_xact_lock` on `<host>:<worker>`), before the pool
account.

`LISTEN/NOTIFY` channel: `fleet_tasks` (payload: `item`), sent by the
scheduler after every write that can make a task ready.

## 5. Worker API (`/api/fleet/worker/*`)

All answers are JSON. Errors: `{error: <code>, detail?}`. Codes: `stale_epoch`
(409), `no_slot` (409), `not_found` (404), `bad_request` (422, `detail` names
the field), `unauthorized` (401), `unavailable` (503). Task ids are JSON
**numbers** everywhere (`BIGSERIAL` cast to int on the wire).

What a worker does with each refusal, exactly as the bodies read:

| Status | Body | Meaning | Worker |
| --- | --- | --- | --- |
| 409 | `{"error":"stale_epoch"}` | the slot moved on, or the account left the fleet | fence: stop, exit 75 |
| 401 | `{"error":"unauthorized","detail":"missing_token"}` | no bearer | fence |
| 401 | `{"error":"unauthorized","detail":"bad_token"}` | signature under neither key, or malformed | fence |
| 401 | `{"error":"unauthorized","detail":"expired_token"}` | past `exp` | fence |
| 503 | `{"error":"unavailable","detail":"FLEET_WORKER_TOKEN_KEY is not set"}` | the ERP lacks its key | retry with backoff, keep the browser |
| 503 | `{"error":"unavailable","detail":"FB_POOL_KEY is not set"}` | the ERP lacks its key (`claim`, `session`) | retry with backoff |

Any other 5xx, and a response that never came, is transient too.

### `POST /api/fleet/worker/claim` — ticket or host scope

The worker claims with the ticket the agent minted for its container
(`RS_FLEET_CLAIM_TICKET`); the host token still works for one release, for
agents and worker images from before the tickets.

```jsonc
// request
{ "host_id": "homelab", "worker_id": "homelab-3", "version": "0.14.0", "vnc_port": 5903 }
// 200
{
  "worker_token": "…",
  "epoch": 7,
  "account": { "no": 12, "uid": "1000…", "password": "…", "totp_secret": "…",
               "cookies": [ /* Playwright storage_state cookies */ ], "token": "EAA…" | null },
  "proxy": { "url": "http://user:pass@host:port" } | null,
  "device": { "user_agent": "…", "viewport": [1366, 768], "timezone": "America/New_York", "locale": "en-US" },
  "home_cities": ["nyc", "philly"],
  "items": [ { "name": "server_ram", "phrases": ["…"], "filters": { … } } ],
  "settings": { "search": { … }, "coordinator_url": "https://…" | null, "lease_minutes": 30, "poll_hold_seconds": 50 },
  "env": { "OPENROUTER_API_KEY": "…", "TELEGRAM_TOKEN": "…", … }   // added by the Cloudflare Worker, see below
}
```

`env` is not sent by the backend: the Cloudflare Worker adds it from its
`FLEET_WORKER_ENV` secret to a `200` claim answer only (§2), and it is absent
when the secret is unset, or when the claim reached the backend some other
way. `settings.coordinator_url` is `null` when `FLEET_COORDINATOR_URL` is empty
or unset (no coordinator).

`worker_id` must be `<host_id>-<n>` with `n` 1..4 digits (`422 bad_request`,
`detail: "worker_id must be <host_id>-<n>"`): a host claims for its own
workers only. Optional `claim_id` (one random id per process boot, stable
across HTTP retries; `[a-zA-Z0-9-]{1,64}`) and `handoff_epoch` (§6). A
repeated `claim_id` returns the same slot and epoch; a `handoff_epoch` that
matches a live reservation for this worker takes that slot. Both wait for
their own slot's lock rather than skip to another account. A `handoff_epoch`
whose reservation lapsed falls back to any free slot, its own first.

Otherwise picks the slot with `lease_expires_at IS NULL OR < now()` (a parked slot's
infinite lease never qualifies) whose pool account has status `fleet`;
quarantined slots are claimable (they then get only probe tasks), preferring
`last_host_id = host_id`, then slots whose home cities nobody covers. Sets
`epoch = epoch + 1`, `worker_id`, `host_id`, `last_host_id`,
`lease_expires_at = now() + lease_minutes`; sets the pool row's holder to the
worker id (the trigger opens the `fb_worker_accounts` stint) and writes an
`fb_pool_events` `assigned` row. `409 no_slot` when none is free. `host_id`
must be the token's own host (`422` otherwise); `vnc_port` may be null.
`device` falls back to a default desktop profile for fields the slot lacks.
Fields beyond the four are passed through as stored: `screen` (`[w, h]`,
default the viewport), `device_scale_factor` (default 1) and `native` (a list
of `user_agent`, `locale`, `timezone` the worker leaves to the browser, for a
device moved from a homelab browser that never pinned them; the worker still
receives the filled-in value and ignores it). The homelab export
`trackers/facebook/scripts/export-device-profile.py` prints this shape.

With a ticket: the body's `worker_id` must be the ticket's and its
`handoff_epoch` the ticket's (both absent, or equal), else `401
ticket_mismatch` before anything is read. The ticket is locked under the
worker's claim lock and spent (`consumed_at`, `claim_id`) in the same
transaction as the claim it let through. A later claim with the same
`claim_id` (that boot's HTTP retry) passes while the ticket lives and gets
the same slot and epoch; any other claim is `401 used_ticket`, and after
`expires_at` even the retry is `401 expired_ticket`. A `409 no_slot` leaves
the ticket unspent.

### `POST /api/fleet/worker/heartbeat` — worker scope

```jsonc
{ "state": "HEALTHY", "version": "0.14.0", "vnc_port": 5903, "last_search_at": "…",
  "detail": { "epoch": 7, "session_expiry": "…", … } }
// 200 { "ok": true, "directives": [] }
// 200, once after a manager's re-login: { "ok": true, "directives": ["relogin"], "relogin_id": "…" }
```

Renews the slot lease. A **parked** state (`SESSION_EXPIRED`, `CHECKPOINT`,
`CHALLENGE*`, `DEAD`) releases the current task (event `released` with
`{reason: <state>}`, state back to `ready`, `due_at = now()`). Any other state
(`HEALTHY`, `DEGRADED`, …) renews the current task lease to `now() +
lease_minutes`, never past `leased_at + task_max_minutes`.

`detail` is free-form: any keys are accepted and stored whole on
`fleet_workers.detail` (with `last_search_at` merged in), replacing the
previous one; a `detail` over 64 KB is dropped (stored as null), not refused.
The monitor sends the epoch as `detail.epoch` plus `session_expiry` and its
own fields; the server does not read `detail.epoch`, the token's epoch is what
is checked. Only `state` is required (`422` otherwise).

`directives` is `[]` except on the one heartbeat after a manager queued a
re-login (`POST /api/fleet/workers/:id/relogin`, §7): that answer carries
`["relogin"]` and the request's id as `relogin_id`, and stamps it delivered,
so no later answer repeats it. Directives are bare strings because the worker
(facebook-tracker 0.14.4 and later) reads only strings, and it arms one forced
login when `relogin` first appears in an answer, not one per answer. A
parked heartbeat delivers it too; that is what a re-login is for. A fresh
claim (a new boot, which signs in anyway) drops a re-login that has not gone
out.

The answer adds `{worker_token, token_expires_at}` (Unix seconds) when less
than a day of the token remains, or when it verified under
`FLEET_WORKER_TOKEN_KEY_PREVIOUS`: seven more days, same worker, account and
epoch. The worker uses the new token for every later call.

### `POST /api/fleet/worker/next-task` — worker scope

```jsonc
// request
{ "done": { "task_id": 123, "result": { "cards": 115, "opened": 9, "reviewed": 9, "alerted": 1, "seconds": 412 } } | null,
  "wait": 50,
  "take": true }   // optional, default true
// 200, a task
{ "task": { "id": 124, "kind": "search", "city": { "slug": "houston", "name": "Houston", "radius_km": 500 },
            "item": "server_ram", "lease_expires_at": "…", "why": "home" | "familiar" | "other" | "manual" | "probe" } }
// 200, nothing yet (after holding up to `wait` seconds)
{ "task": null, "retry_after": 30, "reason": "nothing_due" | "budget" | "quarantined" }
// 200, take: false
{ "task": null, "reason": "done_only" }
```

In one transaction: close `done` (state `done`, `result`, event `done`),
then `SELECT … FROM fleet_tasks WHERE state='ready' AND due_at <= now() … FOR UPDATE SKIP LOCKED`
ordered by `priority DESC`, then home → familiar (this account searched it in
the last `familiar_days`) → other, then `due_at`. Skipped while the account's
`fleet_minutes` today ≥ `budget_minutes` (`reason: "budget"`), or it is
quarantined (then only its own `probe` tasks; `reason: "quarantined"`); both
answer `retry_after: 300`. Leases: `state='leased'`, `worker_id`,
`account_no`, `epoch`, `lease_expires_at = now() + lease_minutes`; event
`handed` with `{why}`. With nothing due, hold on `LISTEN fleet_tasks` up to
`min(wait, poll_hold_seconds)` (`wait` defaults to `poll_hold_seconds`; `0`
answers at once), retry the pick once, else answer `null` with
`retry_after: 30`. Budget and quarantine answers are not held.

**At most one lease per epoch.** If this worker and epoch still hold a
leased task (its answer was lost to a timeout or a dropped connection) and
`done` did not close it, that task is handed again (event `handed` with
`{why, again: true}`) instead of a second lease. This comes before draining,
budget and quarantine.

`{task: null, reason: "draining", retry_after: 30}`: a roll is replacing
this worker (§6). It applies to the epoch the roll chose and earlier, never to
the replacement on a later epoch.

A held poll that a notify wakes but that finds nothing for this account holds
again until its `wait` runs out; it answers `nothing_due` only then.

`done.task_id` is a JSON integer (`422` otherwise). A `done` for a task this
worker no longer holds (not `leased`, or leased to another worker) is a
**silent no-op**: nothing is written and the pick goes on as usual.

`take: false` closes `done` as above and answers `{task: null, reason:
"done_only"}` at once: no pick, no lease, no hold, and neither budget nor
quarantine is consulted. A stale epoch is still `409`. A worker that is
stopping (SIGTERM or any clean shutdown; not after `409 stale_epoch`, its
token is dead) sends its pending `done` this way, so its last task does not
stay leased for `lease_minutes`. `take` that is not a boolean is `422`.

### `POST /api/fleet/worker/events` — worker scope

```jsonc
{ "task_id": 124, "kind": "started" | "searched" | "finished" | "stopped", "detail": { … } | null }
// 200 { "ok": true }
```

`404 not_found` when the task is not this worker's. `started` sets
`started_at` once. On a `verify-slug` task, only `finished` with a boolean
`detail.matches` and neither `detail.error` nor `detail.wall` is the city's verdict: `true` enables
the city, `false` leaves it disabled, and either way `verified_at` is set and
`detail.location` (≤ 200 chars) becomes `verified_as`. A `stopped` event (the worker's
wall/login/error shape: no `matches`, `verdict: false` plus `wall` or `error`), an
`error` or `wall`, or a missing `matches` is logged and leaves the city unverified, so
the scheduler checks it again. A verdict never undoes a manager's removal or
override.

### `PUT /api/fleet/worker/session` — worker scope

```jsonc
{ "cookies": [ … ], "token": "EAA…" | null, "clear": false }   // resealed into fb_pool_accounts.cookie_enc / token_enc, cookie_at = now()
// 200 { "ok": true }
```

The stored session is what spares the next boot a login, so the cookies must
hold a Facebook session for this account: a `c_user` cookie and an `xs`
cookie (`422`, `detail` says which is missing), and `c_user` must equal the
account's uid (`422 {detail: "cookies: c_user is not this account"}`; nothing
is written). An empty list is refused the same way. `clear: true` empties the
stored cookie outright (the list is then ignored). The `token` **key absent**
keeps the stored token; `token: null` clears it.

### `GET /api/fleet/worker/vnc` — worker scope, WebSocket

The worker's VNC relay (`apps/backend/src/fleet/vnc.ts`). Fleet workers may
sit on any network, so the direction is reversed from the coordinator path:
the worker's own `websockify` dials **in** here with its worker token and
parks the socket under its `worker_id`. A manager's noVNC page opens
`/api/fleet/vnc/:workerId/ws` (§7); the two sockets are paired and bytes move
both ways. RFB's server speaks first, so on pairing the relay sends the
worker exactly one text frame, `viewer`, before any viewer byte; the worker
opens its VNC server connection only after it, and every other frame in
either direction is binary. RFB is one session per connection, so a pair ends together: when
either side closes the other is closed too, and the worker dials in again
with a fresh socket for the next viewer.

- Both handshakes are replayed through the Hono app as plain GETs: the worker
  token is checked as on any worker route (401 bad, 409 stale epoch), the
  manager's session, role and `Origin` as on any manager route. A
  non-upgrade GET answers `426`.
- A newer worker socket replaces the parked one (closed `1000`). A parked
  worker socket that sends anything before the `viewer` frame is closed `1008`.
- At most 100 parked worker sockets and 8 live viewer bridges; past that the
  upgrade is refused `503`. A viewer for a worker with no parked socket is
  accepted, then closed `1011` "`<worker>` has no VNC relay connected".
- The viewer's session is re-checked every 60 s; a lapsed sign-in closes it
  `4401`, a lost role `1008`. The worker's token is re-checked every 60 s too,
  parked or paired: a stale epoch closes its socket `4409` (and the viewer's
  with it), a token no longer valid `4401`. Either side over 16 MB buffered
  closes `1013`. On ERP shutdown every socket closes `1001`.
- Viewer input (RFB key and pointer events) is passed to the worker as bytes,
  as on the coordinator bridge: view-only is the watch page's noVNC, which
  sends no input until the manager ticks Take control.
- **One instance serves the relay.** Pairing is in process memory, so the
  backend instance holding the Postgres session advisory lock
  `fleet-vnc-relay` (taken at boot, retried every 5 s) is the only one that
  accepts either path; every other instance refuses both `503`. A deploy hands
  it over when the old instance exits; a lost lock connection closes that
  instance's sockets `1012`. Running more than one backend replica therefore
  leaves the relay on one of them, and a client that reaches another retries.

## 6. Host API (`/api/fleet/hosts/:id/*`) — host scope

```jsonc
// GET /api/fleet/hosts/:id/desired
{ "authoritative": true, "count": 4, "image": "ghcr.io/jinhuw/aimm-recycle:0.14.1", "version": "0.14.0",
  "vnc_ports": { "homelab-1": 5901, "homelab-2": 5902 }, "roll": { "replace": "homelab-2" } | null }
// POST /api/fleet/hosts/:id/report
{ "version": "1.340.0", "containers": [ { "worker_id": "homelab-1", "image": "…", "state": "running", "started_at": "…",
    "hold"?: "operator_needed" | "crash_limit" | "operator_stopped", "exit_code"?: 0 | null, "image_id"?: "sha256:…" } ],
  "agent"?: { "instance_id": "uuid", "daemon_id": "…" | null, "conflict"?: ["other-agent-container"] } }
// 200 { "ok": true }   (sets fleet_hosts.report, version, last_seen_at; 422 over 200 KB)
// 403 { "error": "agent_conflict" }   on desired or report: another agent instance holds this host
```

The report keeps only containers named `<host>-<n>` (another host's worker
ids are dropped) with `hold`, `exit_code` and `image_id` when sent, and the
`agent` identity.

```jsonc
// POST /api/fleet/hosts/:id/tickets
{ "worker_id": "homelab-2", "handoff_epoch": 7 }      // handoff_epoch optional (null or absent = none)
// 200 { "ticket": "fct_…", "expires_at": "…" }        // 10 minutes
// 422 { "error": "bad_request", "detail": "worker_id must be <host_id>-<n>" | "handoff_epoch" }
// 403 { "error": "agent_conflict" }
```

A claim ticket for the container the agent is about to `docker run` (§3,
§5): 32 random bytes as `fct_` + base64url, stored only as its sha256, good
for one claim for that worker id and handoff epoch, for 10 minutes. Minting
deletes the worker's earlier tickets (the container they were for is gone:
the agent runs a worker only where none exists) and every expired ticket.
The agent mints right before each run, after the image is there and any stop
is confirmed, and starts nothing without one.

**One agent per host.** The first `X-Fleet-Agent-Instance` (or report
`agent.instance_id`) seen holds the host (`fleet_hosts.agent_instance`,
`agent_seen_at`) until it has been silent 2 minutes; `desired` and `report`
from any other instance answer `403 agent_conflict`, which the agent reads as
observe-only; `tickets` checks it the same way. A call without an instance id is let through.

`count` is `0` on an observe-only host. On an authoritative one it is the
host's `capacity` **capped at the accounts it could run now**, because every
worker start is a Facebook login and a worker with no slot only exits `75`:

```
held      = slots with host_id = this host and lease_expires_at > now()
            (a worker's lease, or a handoff reservation for one of its workers)
claimable = slots with lease_expires_at NULL or < now()
            (the claim's own rule: free and not parked)
            -- both only for pool accounts with status 'fleet', never a parked slot
count     = min(capacity, max(held + claimable, highest n of a <host>-<n> in held))
```

So with capacity 4 and one ready account the agent runs one worker, and a
second account added later (Account pool ▸ Add to fleet) brings a second.
A slot reserved for another host, or leased by another host's worker, is
neither. The floor at the highest-numbered holder is there because the agent
removes every worker above `count`: dropping one that holds an account would
only free it for a fresh login elsewhere. Two hosts may both count the same
free slot; the one whose claim loses gets `409 no_slot` and its worker exits
`75` (no browser started). The manager's `GET /hosts` shows the same count.
`vnc_ports` maps `<host>-<n>` to `5900 + n` for `n = 1..count`. `image`/`version` are the
latest release's unless it failed, else `FLEET_IMAGE_WORKER` and its tag.

**Rolls** (`fleet/hosts.ts`, the Python coordinator's `advance_rollout`
rules). The release lives in `fleet_settings` key `release` (§8) and is
advanced only by an agent's `desired` call:

- `roll.replace` names at most one worker, **fleet-wide**: while a
  replacement is pending nobody else is told to replace anything.
- A candidate is a container on the host's last report whose image is not
  the release's and that is not already upgraded or skipped; the first idle
  one (no leased task) is chosen. Busy workers wait. A container with a
  `hold`, one whose `state` is not `running`, and one whose worker is parked
  (`SESSION_EXPIRED`, `CHECKPOINT`, `CHALLENGE_*`, `DEAD`) are added to
  `skipped` instead, with the reason in `release.skip_reasons[worker_id]`
  (`held: crash_limit`, `container exited`, `worker CHECKPOINT`): the agent
  would never replace the first two, and rebooting a parked account is a login
  that cannot pass the gate.
- **Release gate:** the next step waits until the replaced worker heartbeats
  with `version` equal to the release version (or starting with
  `"<version> "`) after its replacement began, in a state no worse than
  before (was HEALTHY → must be HEALTHY; was down or unknown → anything;
  otherwise anything but DEAD). Not within 20 minutes → the release turns
  `failed` with a `failure` text and new workers fall back to
  `FLEET_IMAGE_WORKER`.
- Workers on observe-only hosts, or hosts silent for 2 minutes, are added to
  `skipped` (reason `host is observe-only` / `host is silent`), not waited
  for. When nothing is pending anywhere the release is `done`.
- Removing a host (`DELETE /hosts/:id`) frees the accounts it had reserved for
  a replacement (handoff epoch, infinite lease: epoch + 1, no worker, no
  lease) and drops a pending replacement on it (`skip_reasons: host removed`).
- A manager's `GET /hosts` shows `desired.roll` from the release's `current`
  without advancing it.

**Confirmed stop and handoff.** `desired` also carries `leases: {worker_id:
{account_no, epoch}}` for this host's slots. After Docker confirms a container
gone, the agent calls:

```jsonc
// POST /api/fleet/hosts/:id/stopped
{ "worker_id": "homelab-2", "account_no": 12, "epoch": 7, "restart": true }
// 200 { "ok": true }   409 { "error": "stale_epoch" }   422 { "error": "bad_request" }
```

The slot must be this host's, this worker's, on `epoch` (`409` otherwise).
Its leased tasks are released, the epoch moves on and `handoff_epoch = epoch`.
`restart: true` reserves the account for that worker: `reserved_until =
lease_expires_at = now + 20 min` (the roll gate's timeout, so a reservation
lapses when the gate would fail); its replacement claims with
`handoff_epoch` = the stopped epoch. Unrelated workers cannot take it while
it lasts; after it lapses anyone may. `restart: false` frees the account at
once. A repeat for the same epoch is idempotent: `restart: false` then frees a
reservation not yet consumed, and never touches a lease the replacement
already holds. Slot rows show a reservation as `reserved_until`, not as
`parked`; a manager's park clears it, and unpark clears `handoff_epoch`.

**Agent behaviour** (`apps/fleet-agent/src/plan.ts`), polling every 30 s:

- Observe-only (`authoritative: false`, a `401`/`403`/`404` answer to
  `desired`, or a second running agent for the same host on the daemon):
  starts and stops nothing. A reservation still waiting for a replacement is
  released with `stopped` `restart: false`.
- Offline (the ERP unreachable, a cached `desired` in use): may restart
  exited workers; creates, removes and replaces nothing, and does not
  `docker start` a worker created with a handoff epoch or a claim ticket
  (its reservation or ticket is spent; it waits to be recreated online).
  Online, with `leases` in `desired`, an exited worker is always recreated
  on a fresh ticket.
- At most one start per tick and none within 3 minutes of the previous one
  (`FLEET_STAGGER_SECONDS`): every start is a Facebook login. The previous
  start is the later of the one the agent wrote to `/state` and the newest
  container `StartedAt`; a start is written down before it is made and not
  made if it cannot be. Extra workers beyond `count` are removed all at once
  (stopping is not a login).
- Exit codes: `75` → restart after 60 s, or after 10 min once the worker has
  had five 75/70 restarts in 30 min; `70` → restart after 10 min; any other
  exit except `0`/`143`/`78` → restart after 60 s and counts as a crash.
  `75`, `70`, `0`, `143` and `78` never count as crashes.
- **Held: never restarted, online or offline**, until a person starts the
  container (`docker start`) or removes it (`docker rm`, after which it is a
  missing worker). The report gives each held container `state` and `hold`
  set to the reason:
  - `operator_needed`: it exited `78`;
  - `crash_limit`: 5 crashes in 30 min. The hold belongs to that container
    and outlives the window and agent restarts;
  - `operator_stopped`: it exited `0` or `143` after the agent started, and
    the agent had not stopped it itself (someone ran `docker stop`). An exit
    from before the agent started is a host or daemon restart and is
    restarted as usual.

  The ERP must not choose a held (or any non-running) container as
  `roll.replace`; the agent never replaces one.
- `roll.replace` is acted on only online, for a running container whose image
  differs from `desired.image`, and takes the tick's one start after any
  missing or exited worker.
- Images: only references under `FLEET_IMAGE_PREFIX` (default
  `ghcr.io/jinhuw/aimm-recycle`) are pulled or run; `--` precedes the image in
  every `docker pull`, `image inspect` and `run`. A tag is pulled before each
  start; a digest only when missing. Report containers carry `image_id`, so a
  tag pushed again shows up as a different id.
- Identity: every call carries `X-Fleet-Agent-Instance` and
  `X-Fleet-Docker-Daemon`; `report` (`agent`) and `stopped` (`agent_instance`,
  `daemon_id`) carry them in the body. The ERP refuses a second live instance
  for one host on `desired` and `report` (`403 agent_conflict`, above);
  `stopped` does not check it.
- VNC port: `desired.vnc_ports[worker_id]`, falling back to `5900 + n` for a
  worker the ERP has not mapped yet.

## 7. Manager API — manager scope

Session cookie plus the manager role. Errors are `{error, detail?}`:
`422 bad_request` (`detail` says what), `404 not_found`, `409 exists`,
`409 unverified` (enabling a city no worker has verified), and for the fleet
membership routes `409 account_busy`, `no_login`, `proxy_full`, `in_use` and
`leased` (each with a `detail` a page can show). Answers are the
**bare** row or array unless the table shows a wrapper.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/fleet/health` | | `{ok, tables: string[]}` |
| `GET /api/fleet/cities` | | `{cities: FleetCityListed[]}`; each city is `FleetCity & {open_tasks: FleetTask[], last_done_at: Record<item, ISO>}`. `open_tasks` are the city's `ready`/`leased` tasks of every kind; `last_done_at` has a key only for items with a finished search (no key = never) |
| `POST /api/fleet/cities` | `{slug, name, radius_km? (1..500, default 500), region?}` | `201` the `FleetCityListed` itself, `enabled=false`, with a `verify-slug` task on the first enabled item (none if no item exists); `409 exists` |
| `PUT /api/fleet/cities/:slug` | `{enabled?, per_day? (null or 1..24), pinned?, name?, override_verify?: true, reverify?: true}`; unknown keys `422` | `200` the `FleetCityListed` after reconcile. `{enabled: true}` → `409 unverified` unless the slug was confirmed: `verified_as` `override` or `imported`, or the latest verify verdict carrying `matches` said `true` (a mismatch sets `verified_at` too, and is not enough); `override_verify: true` marks it verified (`verified_as: "override"`), enables it and cancels its waiting `verify-slug` task; `reverify: true` forgets the verdict (unverified, disabled, not removed) so the scheduler writes a fresh check — also the way back for a removed city never verified; not with `enabled` or `override_verify`. A `per_day` change moves the pair's waiting cadence search at once |
| `DELETE /api/fleet/cities/:slug` | | `200` the `FleetCityListed` after reconcile: disabled, waiting (`ready`) tasks cancelled; a leased search finishes |
| `GET /api/fleet/items` | | `FleetItem[]` |
| `PUT /api/fleet/items` | bare `FleetItem[]` (non-empty; `filters`, `enabled` optional) | `FleetItem[]` (all items). Upsert: an item not listed is left alone; one goes away by `enabled: false` |
| `GET /api/fleet/settings` | | `FleetSettings` (§8 keys; `release` is not among them) |
| `PUT /api/fleet/settings` | partial `FleetSettings`; `search` keys merge into the saved ones | `FleetSettings` |
| `POST /api/fleet/tasks` | `{city, item}` | `201 FleetTask`. The pair's waiting search is pulled to `priority 100`, `due_at = now()`, `reason manual`; a pair with none gets a new one, which the scheduler keeps even on a switched-off or unverified city (only a disabled item, or removing the city, cancels it). Two at once write one task. `409 exists` when the pair is leased right now; `404` unknown city or item |
| `POST /api/fleet/round/start` | | `{started: number, skipped: number}`: every ready search due later becomes due now (`reason start`) unless the pair finished within `start_fresh_hours`; `skipped` = ready searches still due later |
| `GET /api/fleet/tasks?state=&city=&item=&worker=&since=` | | `FleetTask[]`. `state=ready` or `leased`: the queue, at most 1000, `priority DESC, due_at, id`. Anything else is history, at most 5000, newest first (`GREATEST(due_at, leased_at, done_at) DESC`). A capped answer carries `X-Fleet-Truncated: true` |
| `GET /api/fleet/city-log?city=\|worker=&hours=` | `city` or `worker` required; `hours` 1..720, default 24 | `FleetTaskLog[]` (`FleetTask & {events: FleetTaskEvent[]}`), newest first |
| `GET /api/fleet/hosts` | | `{hosts: (FleetHost & {desired: {count, image, version, roll}})[], release: FleetRelease \| null}` |
| `POST /api/fleet/hosts` | `{host_id}` (lowercase, digits, dashes) | `200 {host: FleetHost & {desired, token}}`; the token is shown this once, only its hash is kept. `409 {error: "exists"}` |
| `PUT /api/fleet/hosts/:id` | `{capacity? (0..99), authoritative?}` | `{host: FleetHost & {desired}}`; `404` |
| `DELETE /api/fleet/hosts/:id` | | `{ok: true}`; `404`. Frees the host's replacement reservations and drops its pending replacement (§6) |
| `POST /api/fleet/releases` | `{image, version}` | `{ok: true, release: FleetRelease}`; starts a roll (§6), replacing any active one |
| `GET /api/fleet/slots` | | `{slots: SlotView[]}`: `FleetSlot` (with `parked: boolean` and `reserved_until: ISO | null` (a live handoff reservation, §6); `lease_expires_at` is `null` when parked; `has_proxy`, never the URL; `proxy_id`, the listed proxy or `null`) plus `uid`, `pool_status`, `minutes_today`, `budget_minutes`, `worker: WorkerView \| null` |
| `POST /api/fleet/slots` | `{account_no, proxy_id, home_cities?: string[]}` (≤ 10 slugs that exist in `fleet_cities`; unknown keys `422`) | `201 {slot: SlotView}`. Puts a pool account into the fleet in one transaction (pool account, then the proxy row, then the slot): the account must exist (`404`), have a password and a 2FA key (`409 no_login`) and be `available`, or `fleet` with no holder or the holder `ERP fleet` (`409 account_busy` otherwise: a coordinator worker's or a purchaser's account is never taken); the proxy must exist (`404`) and carry fewer than `max_accounts_per_proxy` slots that are not parked (`409 proxy_full`); a slot already there is `409 exists`. The slot gets the proxy's sealed URL (`proxy_url`) and `proxy_id`, `home_cities`, and a generated `device`: no `user_agent` and `native: ["user_agent"]` (Chromium's own, as the homelab browsers), `screen` and `device_scale_factor` from the coordinator's list (1920×1080@1, 1536×864@1.25, 1440×900@1, 1366×768@1, 1600×900@1, 1280×800@1) and a `viewport` of the screen less 111, 123 or 133 px of browser chrome, both picked by FNV-1a of `fleet-device:<account_no>` (`fleetDeviceFor`, packages/shared), `timezone` the proxy's, `locale` `en-US`. The pool row turns `fleet` with holder `ERP fleet` (the pool triggers open the stint) and an `assigned` pool event; the first claim then names the worker as holder |
| `POST /api/fleet/slots/:no/remove` | | `{ok: true, account_no, pool_status}`. Only a slot no worker holds and no reservation holds (`409 leased`: park it first); a parked one is fine. Deletes the slot and cancels the account's waiting probe; a pool row still `fleet` goes back to `available` (holder cleared, a `returned` pool event), one reported or retired meanwhile keeps its status. `404` without a slot |
| `GET /api/fleet/proxies` | | `FleetProxy[]`, oldest first: `{id, label, host, port, timezone, note, created_at, slots: [{account_no, pool_status, parked, leased}]}`. Never the URL or its login |
| `POST /api/fleet/proxies` | `{label (1..80), url, timezone, note? (≤ 500)}`; `url` is `http`, `https` or `socks5` `://[user:pass@]host:port`, port required, nothing after it; `timezone` an IANA zone (`America/New_York`, or `UTC`) | `201 FleetProxy`. The URL is sealed with `FB_POOL_KEY` (`503 unavailable` without it) and never echoed, not even in a `422`. `409 exists` for a host:port already listed |
| `PUT /api/fleet/proxies/:id` | any of `{label, url, timezone, note}` | `FleetProxy`. A new `url` is resealed into every slot on the proxy, a new `timezone` into every slot's `device.timezone`; a worker picks either up at its next claim. `404`, `409 exists`, `422` as above |
| `DELETE /api/fleet/proxies/:id` | | `{ok: true}`; `409 in_use` (detail names the accounts) while a slot that is not parked uses it; a parked slot keeps its copy of the URL and loses `proxy_id`. `404` |
| `POST /api/fleet/slots/:no/release-quarantine` | | `{slot: SlotView}`; `404` |
| `POST /api/fleet/slots/:no/park` | | `{slot: SlotView}`: epoch + 1 (its worker gets `409 stale_epoch` and exits), no worker, infinite lease, any handoff reservation cleared, its leased tasks released; `404` |
| `POST /api/fleet/slots/:no/unpark` | | `{slot: SlotView}`: lease cleared so the slot is claimable again; a slot that was not parked is answered unchanged; `404` |
| `GET /api/fleet/workers` | | `{workers: WorkerView[]}`: `FleetWorker & {task: (FleetTask & {city_name}) \| null}` (the leased task) |
| `POST /api/fleet/workers/:id/relogin` | | `{ok: true, relogin: {id, requested_at, requested_by, delivered_at}}`: queues a forced Facebook login that the worker's next heartbeat delivers once (§5). Only a worker holding its slot (live lease on its epoch): `409 not_running` otherwise, `404` for an unknown id. Pressed again while one waits, it answers the waiting one rather than queue a second. Worker views (`GET /workers`, `GET /workers/:id`) carry the latest as `relogin` (`null` without one) |
| `GET /api/fleet/vnc/:workerId/ws` | WebSocket | the manager's end of the worker VNC relay (§5); `426` without an upgrade, `403` bad Origin, `404` bad id |

## 8. Settings keys (`fleet_settings`)

| Key | Default | Meaning |
| --- | --- | --- |
| `per_day_default` | 1 | searches per city per item per day when `fleet_cities.per_day` is null and tiers are off |
| `budget_minutes` | 360 | lease minutes per account per UTC day |
| `lease_minutes` | 30 | slot and task lease length; heartbeats renew |
| `task_max_minutes` | 45 | a leased task older than this is returned (`expired`) even if heartbeats renew |
| `poll_hold_seconds` | 50 | longest a `next-task` is held |
| `familiar_days` | 7 | "familiar" city window |
| `start_fresh_hours` | 2 | round start: skip city-items done this recently |
| `quarantine_hours` | 48 | 0-card rule window (ported from the coordinator) |
| `quarantine_probe_hours` | 6 | one probe task per quarantined slot per this interval |
| `retention_days` | 90 | 30..730. Terminal tasks (done, cancelled, expired) older than this (by `done_at`, else `leased_at`, else `due_at`) are deleted with their events and attempts, hourly, 5,000 per run. The window is never shorter than `familiar_days`. Kept regardless of age: the newest done search per city and item, and the verify-slug task holding each city's latest verdict |
| `max_accounts_per_proxy` | 2 | 1..10. Slots that are not parked one proxy may carry; `POST /slots` refuses past it (`409 proxy_full`). A static ISP exit is one IP, bought in pairs |
| `search` | from `master.toml` | `date_listed`, `delivery_method`, `max_results`, page pauses |
| `release` | none | the current or last `FleetRelease` (`{image, version, state: rolling\|done\|failed, started_at, finished_at, upgraded[], skipped[], current, failure}`); written by `POST /releases` and the roll, not by `PUT /settings` and not in its answer |

## 9. Shared types (`packages/shared/src/fleet.ts`)

`FleetCity`, `FleetItem`, `FleetTask`, `FleetTaskEvent`, `FleetSlot`,
`FleetHost`, `FleetWorker`, `FleetSettings`, `ClaimAnswer`, `NextTaskAnswer`,
`DesiredAnswer`, plus `FLEET_TASK_STATES`, `FLEET_PARKED_STATES`. RS-415
adds `FleetDeviceProfile` (a stored device, `user_agent` optional),
`FleetProxy`, `FleetProxyUse`, `FleetProxyWrite`, `FleetProxyPatch`,
`FleetSlotWrite` and the helpers `fleetDeviceFor`, `parseProxyUrl`,
`isFleetTimezone`, `proxyLoad`, which the backend and the pool page share. WS-A writes
the first version; others add fields in their own PRs.

## 10. Worker container contract (image ↔ agent)

- Image: `ghcr.io/jinhuw/aimm-recycle:<ver>` (private GHCR), entrypoint `rs_worker/entry.py`.
- Fleet mode on when `RS_FLEET_URL`, `RS_FLEET_HOST_ID` and a claim
  credential are set: `RS_FLEET_CLAIM_TICKET`, else `RS_FLEET_HOST_TOKEN`
  (an agent from before the tickets); otherwise the image behaves exactly as
  today (bind-mounted config). The entrypoint claims with the ticket when
  there is one, and keeps every `RS_FLEET_*` variable out of the monitor's
  environment.
- A container the agent created carries the label `rs.fleet.claim_ticket=1`.
  Its ticket is spent by its first claim, so `docker start` on it claims with
  a spent ticket: a `401` on a ticket claim exits `75` at once, before the
  browser, and the agent recreates it on a fresh ticket.
- Exit codes: `0` normal stop (`docker stop`; the agent leaves it stopped
  when it happened while the agent ran and the agent did not stop it, §6),
  `75` stale epoch, no slot or a refused claim ticket (agent restarts after
  60 s, backing off when it repeats), `70` config/claim failure (agent backs off 10 min), `78`
  operator needed (agent leaves it stopped, §6); anything else is the
  monitor's own code and counts as a crash (§6).
- A container started with a handoff carries the label
  `rs.fleet.handoff_epoch` beside `RS_FLEET_HANDOFF_EPOCH`; `docker start` on
  it claims with a spent reservation and exits `75`, so recover it with
  `docker rm`.
- **Cannot connect → stop and wait for an operator.** When Facebook or the
  worker's proxy cannot be reached, at boot or later, the worker does not
  retry in a loop and does not exit with a code the agent restarts: every
  restart is a Facebook login. It sends a final heartbeat in a parked state
  where it can, closes its pending `done` with `take: false`, and exits `78`.
- Ports: VNC listens on 5900 inside; the agent publishes
  `127.0.0.1:<port>:5900` with `<port>` from `desired.vnc_ports` (fallback
  `5900 + n`) and passes that host port as `RS_VNC_PORT`, which the worker
  reports in heartbeats.
- Health: `docker inspect` health = `curl -sf localhost:8788/healthz`
  (entrypoint serves it once the monitor is up).

## Review recovery protocol (RS-400)

Backend support must ship before the new agent/worker. Existing fields stay
compatible. The Cloudflare Worker's `FLEET_WORKER_ENV` secret supplies optional
claim `env` as described in §2. The entrypoint validates the AI key and any
configured coordinator/report credentials before browser startup. Manager reads,
desired and reports never carry those values.

Claims optionally carry `claim_id` (one random id per process boot, stable across
HTTP retries) and `handoff_epoch`. Repeating a claim_id returns the same slot and
epoch. Desired optionally includes `leases: {worker_id: {account_no, epoch}}`.
After Docker confirms a container stopped, its host calls
`POST /hosts/:id/stopped` with `{worker_id, account_no, epoch, restart}`.
`restart: true` fences the old epoch and reserves the account for that worker
until `reserved_until` (20 min, §6); its replacement claims with handoff_epoch
equal to the stopped epoch. Repeated
stop confirmations are idempotent. Unrelated workers cannot consume a reservation.
`restart: false` frees it. An active replacement command repeats to its own host;
the old worker is drained (next-task returns null with reason `draining`).

A heartbeat optionally returns `{worker_token, token_expires_at}` when less than
one day remains. It renews for seven days with the same epoch and account. Workers
share it with all HTTP clients and future VNC dials via an in-container token file.
A token 401 (`missing_token`, `bad_token`, `expired_token`) is terminal to the
worker (exit 75), rather than an infinite retry; expired tokens do not renew.
A `503 unavailable` is not: the ERP lacks a key, and the worker retries (§5). Every null-task retry_after is an interruptible delay.

Pool ownership changes invalidate the epoch and release work in the same database
transaction. Worker writes recheck under account-then-slot locks. Finished lease
attempts are retained in fleet_task_attempts; fleet_minutes splits their time at
UTC midnight and includes live leases. Time already erased before migration
cannot be reconstructed. Quarantine uses the coordinator rule: at least two
completed zero-card searches, all the account's completed searches in the window
zero, with positive results from another account in at least one of those cities.
quarantine_hours is both the evidence lookback and the duration from latest
qualifying result; zero disables detection. Manual release/successful positive
probe resets the evidence window. Probes do not advance normal search cadence.
Expired slug checks retry while unverified and not removed; only a current leased
attempt/epoch may apply a verdict, and never over a removal or override. A
retry backs off: each check of the city that ended in the last day without a
verdict (stopped, an error or wall, an expired lease) doubles the wait from
the last one's end, 15 min, 30 min, … up to 6 h; checks that gave a verdict
do not count, so a `reverify` is checked at once.
