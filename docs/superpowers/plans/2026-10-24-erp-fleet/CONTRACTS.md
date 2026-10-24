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
| On pairing, the VNC relay sends the worker one text frame `viewer` before any viewer byte; the worker dials its VNC server only after it | §5 | this change |

## 1. Names

| Thing | Value |
| --- | --- |
| Backend module | `apps/backend/src/fleet/` (`scheduler.ts`, `claim.ts`, `tasks.ts`, `hosts.ts`, `auth.ts`, `sql.ts`, `cities.ts`, `workers.ts`, `vnc.ts`) |
| Routes | `apps/backend/src/routes/fleet.ts`, mounted at `/api/fleet` |
| Shared types | `packages/shared/src/fleet.ts` |
| Frontend | `apps/frontend/src/pages/desktop/fleet/*`, `apps/frontend/src/lib/fleet.ts` |
| Host agent | `apps/fleet-agent/` → image `ghcr.io/jinhuw/fleet-agent:<root version>` |
| Worker image | `trackers/facebook/deploy/Dockerfile.worker` → `ghcr.io/jinhuw/aimm-recycle:<facebook-tracker version>` |
| Worker entrypoint | `trackers/facebook/rs_worker/entry.py` |
| Migration | `apps/backend/migrations/0206_fleet.sql` (0205 was taken) |

## 2. Environment

Backend (Railway `backend`, and `.env` locally):

| Var | Meaning |
| --- | --- |
| `FB_POOL_KEY` | exists; seals pool secrets. Without it `claim` and `PUT /worker/session` answer `401 {error: "unauthorized", detail: "FB_POOL_KEY is not set"}` |
| `FLEET_WORKER_TOKEN_KEY` | HMAC key for worker tokens (hex, 32 bytes). **Required in production**: without it every worker route and `claim` answer `401` with `detail: "FLEET_WORKER_TOKEN_KEY is not set"`, and the rest of the app boots as usual. Outside production it is optional: the key is derived from `JWT_SECRET` (HKDF-SHA256, info `fleet-worker-token`), so dev and CI need no extra variable |
| `FLEET_IMAGE_WORKER` | default worker image ref, e.g. `ghcr.io/jinhuw/aimm-recycle:0.14.0`; `desired.image` falls back to it when no release exists or the last one failed, and `desired.version` is its tag |
| `FLEET_IMAGE_AGENT` | default agent image ref. Not read by the backend yet |
| `FLEET_COORDINATOR_URL` | the Python coordinator workers post listings to (`https://…`), handed to workers at claim as `settings.coordinator_url` (`""` when unset) |
| `FLEET_ROLE` | unset or `worker-api`: the whole app **and** the 30 s scheduler tick. `manager-only`: the whole app, no scheduler tick (manager writes still reconcile inline). No value filters routes yet; the `worker-api` route split is future work |

Host agent container:

| Var | Meaning |
| --- | --- |
| `FLEET_URL` | ERP base URL, e.g. `https://api.recycleservers.com` |
| `FLEET_HOST_ID` | host id as registered in the ERP |
| `FLEET_HOST_TOKEN` | the host's bearer token |

Worker container (set by the agent):

| Var | Meaning |
| --- | --- |
| `RS_FLEET_URL`, `RS_FLEET_HOST_ID`, `RS_FLEET_HOST_TOKEN` | fleet mode on when all three are set |
| `RS_FLEET_WORKER_ID` | `<host_id>-<n>` chosen by the agent |
| `RS_VNC_PORT` | the **host** port the agent published (`127.0.0.1:<port>:5900`); the worker reports it in heartbeats |

These five are the only variables the agent passes today (`apps/fleet-agent/src/docker.ts`).

**Open item: shared worker env.** The config the worker renders
(`trackers/facebook/rs_worker/config.template.toml`) expands `${VAR}`
references from the container's environment that the claim does not carry:
`OPENROUTER_API_KEY`, `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`,
`TELEGRAM_TOPIC_HIGH`, `TELEGRAM_TOPIC_MEDIUM`, `TELEGRAM_TOPIC_LOW`,
`RS_ALERT_REPORT_URL`, `RS_COORDINATOR_TOKEN`, `RS_CONTROL_PLANE_TOKEN`
(`RS_FB_PASSWORD` / `RS_FB_TOTP` are set by the entrypoint from the claim).
**Who supplies them to a fleet worker is undecided**: the agent would need to
pass them (from its own env or an env file on the host), or the claim answer
would need to carry them. Until decided, a fleet worker started by the agent
runs without them.

## 3. Auth scopes

| Scope | How | Used by |
| --- | --- | --- |
| manager | existing ERP session cookie + manager role | frontend, `/api/fleet/*` except worker/host routes |
| host | `Authorization: Bearer <host token>`; `sha256(token)` = `fleet_hosts.token_hash` | `/api/fleet/hosts/:id/*`, `POST /api/fleet/worker/claim` |
| worker | `Authorization: Bearer <worker token>`: `base64url(json{worker_id, account_no, epoch, exp}) . hmac` with `FLEET_WORKER_TOKEN_KEY`; `exp` = claim + 7 days | `/api/fleet/worker/*` except `claim` |

A worker token whose `epoch` ≠ `fleet_slots.epoch` for its `account_no` (or
whose slot is gone) → `409 {error: "stale_epoch"}` on every worker route. A
bad or expired token, a missing bearer, or a host token used on another
host's `:id` → `401 {error: "unauthorized"}`. Manager routes answer the app's
usual `401`/`403` for a missing session or role.

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

`LISTEN/NOTIFY` channel: `fleet_tasks` (payload: `item`), sent by the
scheduler after every write that can make a task ready.

## 5. Worker API (`/api/fleet/worker/*`)

All answers are JSON. Errors: `{error: <code>, detail?}`. Codes: `stale_epoch`
(409), `no_slot` (409), `not_found` (404), `bad_request` (422, `detail` names
the field), `unauthorized` (401). Task ids are JSON **numbers** everywhere
(`BIGSERIAL` cast to int on the wire).

### `POST /api/fleet/worker/claim` — host scope

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
  "settings": { "search": { … }, "coordinator_url": "https://…", "lease_minutes": 30, "poll_hold_seconds": 50 }
}
```

Picks the slot with `lease_expires_at IS NULL OR < now()` (a parked slot's
infinite lease never qualifies) whose pool account has status `fleet`;
quarantined slots are claimable (they then get only probe tasks), preferring
`last_host_id = host_id`, then slots whose home cities nobody covers. Sets
`epoch = epoch + 1`, `worker_id`, `host_id`, `last_host_id`,
`lease_expires_at = now() + lease_minutes`; sets the pool row's holder to the
worker id (the trigger opens the `fb_worker_accounts` stint) and writes an
`fb_pool_events` `assigned` row. `409 no_slot` when none is free. `host_id`
must be the token's own host (`422` otherwise); `vnc_port` may be null.
`device` falls back to a default desktop profile for fields the slot lacks.

### `POST /api/fleet/worker/heartbeat` — worker scope

```jsonc
{ "state": "HEALTHY", "version": "0.14.0", "vnc_port": 5903, "last_search_at": "…",
  "detail": { "epoch": 7, "session_expiry": "…", … } }
// 200 { "ok": true, "directives": [] }
```

Renews the slot lease. `HEALTHY` also renews the current task lease. A
**parked** state (`SESSION_EXPIRED`, `CHECKPOINT`, `CHALLENGE*`, `DEAD`)
releases the current task (event `released` with `{reason: <state>}`, state
back to `ready`, `due_at = now()`). `DEGRADED` changes nothing.

`detail` is free-form: any keys are accepted and stored whole on
`fleet_workers.detail` (with `last_search_at` merged in), replacing the
previous one; a `detail` over 64 KB is dropped (stored as null), not refused.
The monitor sends the epoch as `detail.epoch` plus `session_expiry` and its
own fields; the server does not read `detail.epoch`, the token's epoch is what
is checked. `directives` is always `[]` today (`"relogin"` is reserved).
Only `state` is required (`422` otherwise).

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
`started_at` once. On a `verify-slug` task, `finished` or `stopped` is the
city's verdict: `detail.matches === true` enables the city, and
`detail.location` (≤ 200 chars) becomes `verified_as`.

### `PUT /api/fleet/worker/session` — worker scope

```jsonc
{ "cookies": [ … ], "token": "EAA…" | null }   // resealed into fb_pool_accounts.cookie_enc / token_enc, cookie_at = now()
// 200 { "ok": true }
```

An empty `cookies` list clears the stored cookie; `token` omitted keeps the
stored token, `null` clears it.

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
  `4401`, a lost role `1008`. Either side over 16 MB buffered closes `1013`.
  On ERP shutdown every socket closes `1001`.

## 6. Host API (`/api/fleet/hosts/:id/*`) — host scope

```jsonc
// GET /api/fleet/hosts/:id/desired
{ "authoritative": true, "count": 4, "image": "ghcr.io/jinhuw/aimm-recycle:0.14.0", "version": "0.14.0",
  "vnc_ports": { "homelab-1": 5901, "homelab-2": 5902 }, "roll": { "replace": "homelab-2" } | null }
// POST /api/fleet/hosts/:id/report
{ "version": "1.340.0", "containers": [ { "worker_id": "homelab-1", "image": "…", "state": "running", "started_at": "…" } ] }
// 200 { "ok": true }   (sets fleet_hosts.report, version, last_seen_at; 422 over 200 KB)
```

`count` is the host's `capacity` when authoritative, else `0`. `vnc_ports`
maps `<host>-<n>` to `5900 + n` for `n = 1..count`. `image`/`version` are the
latest release's unless it failed, else `FLEET_IMAGE_WORKER` and its tag.

**Rolls** (`fleet/hosts.ts`, the Python coordinator's `advance_rollout`
rules). The release lives in `fleet_settings` key `release` (§8) and is
advanced only by an agent's `desired` call:

- `roll.replace` names at most one worker, **fleet-wide**: while a
  replacement is pending nobody else is told to replace anything.
- A candidate is a container on the host's last report whose image is not
  the release's and that is not already upgraded or skipped; the first idle
  one (no leased task) is chosen. Busy workers wait.
- **Release gate:** the next step waits until the replaced worker heartbeats
  with `version` equal to the release version (or starting with
  `"<version> "`) after its replacement began, in a state no worse than
  before (was HEALTHY → must be HEALTHY; was down or unknown → anything;
  otherwise anything but DEAD). Not within 20 minutes → the release turns
  `failed` with a `failure` text and new workers fall back to
  `FLEET_IMAGE_WORKER`.
- Workers on observe-only hosts, or hosts silent for 2 minutes, are added to
  `skipped`, not waited for. When nothing is pending anywhere the release is
  `done`.
- A manager's `GET /hosts` shows `desired.roll` from the release's `current`
  without advancing it.

**Agent behaviour** (`apps/fleet-agent/src/plan.ts`), polling every 30 s:

- Observe-only (`authoritative: false`): starts and stops nothing.
- Offline (the ERP unreachable, a cached `desired` in use): may restart
  exited workers; creates, removes and replaces nothing.
- At most one start per tick and none within 3 minutes of the previous one
  (`FLEET_STAGGER_SECONDS`): every start is a Facebook login. Extra workers
  beyond `count` are removed all at once (stopping is not a login).
- Exit codes: `75` → restart after 60 s; `70` → restart after 10 min; any
  other exit → restart after 60 s and counts as a crash; 5 crashes in 30 min
  → the worker is left stopped. `75` and `70` never count as crashes.
- `roll.replace` is acted on only online, for a running container whose image
  differs from `desired.image`, and takes the tick's one start after any
  missing or exited worker.
- VNC port: `desired.vnc_ports[worker_id]`, falling back to `5900 + n` for a
  worker the ERP has not mapped yet.

## 7. Manager API — manager scope

Session cookie plus the manager role. Errors are `{error, detail?}`:
`422 bad_request` (`detail` says what), `404 not_found`, `409 exists`, and
`409 unverified` (enabling a city no worker has verified). Answers are the
**bare** row or array unless the table shows a wrapper.

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/fleet/health` | | `{ok, tables: string[]}` |
| `GET /api/fleet/cities` | | `{cities: FleetCityListed[]}`; each city is `FleetCity & {open_tasks: FleetTask[], last_done_at: Record<item, ISO>}`. `open_tasks` are the city's `ready`/`leased` tasks of every kind; `last_done_at` has a key only for items with a finished search (no key = never) |
| `POST /api/fleet/cities` | `{slug, name, radius_km? (1..500, default 500), region?}` | `201` the `FleetCityListed` itself, `enabled=false`, with a `verify-slug` task on the first enabled item (none if no item exists); `409 exists` |
| `PUT /api/fleet/cities/:slug` | `{enabled?, per_day? (null or 1..24), pinned?, name?, override_verify?: true}`; unknown keys `422` | `200` the `FleetCityListed` after reconcile. `{enabled: true}` on an unverified city → `409 unverified`; `override_verify: true` marks it verified (`verified_as: "override"`), enables it and cancels its waiting `verify-slug` task |
| `DELETE /api/fleet/cities/:slug` | | `200` the `FleetCityListed` after reconcile: disabled, waiting (`ready`) tasks cancelled; a leased search finishes |
| `GET /api/fleet/items` | | `FleetItem[]` |
| `PUT /api/fleet/items` | bare `FleetItem[]` (non-empty; `filters`, `enabled` optional) | `FleetItem[]` (all items). Upsert: an item not listed is left alone; one goes away by `enabled: false` |
| `GET /api/fleet/settings` | | `FleetSettings` (§8 keys; `release` is not among them) |
| `PUT /api/fleet/settings` | partial `FleetSettings`; `search` keys merge into the saved ones | `FleetSettings` |
| `POST /api/fleet/tasks` | `{city, item}` | `201 FleetTask`. The pair's waiting search is pulled to `priority 100`, `due_at = now()`, `reason manual`; a pair with none gets a new one. `409 exists` when the pair is leased right now; `404` unknown city or item |
| `POST /api/fleet/round/start` | | `{started: number, skipped: number}`: every ready search due later becomes due now (`reason start`) unless the pair finished within `start_fresh_hours`; `skipped` = ready searches still due later |
| `GET /api/fleet/tasks?state=&city=&item=&worker=&since=` | | `FleetTask[]`, at most 1000, `priority DESC, due_at, id` |
| `GET /api/fleet/city-log?city=\|worker=&hours=` | `city` or `worker` required; `hours` 1..720, default 24 | `FleetTaskLog[]` (`FleetTask & {events: FleetTaskEvent[]}`), newest first |
| `GET /api/fleet/hosts` | | `{hosts: (FleetHost & {desired: {count, image, version, roll}})[], release: FleetRelease \| null}` |
| `POST /api/fleet/hosts` | `{host_id}` (lowercase, digits, dashes) | `200 {host: FleetHost & {desired, token}}`; the token is shown this once, only its hash is kept. `409 {error: "exists"}` |
| `PUT /api/fleet/hosts/:id` | `{capacity? (0..99), authoritative?}` | `{host: FleetHost & {desired}}`; `404` |
| `DELETE /api/fleet/hosts/:id` | | `{ok: true}`; `404` |
| `POST /api/fleet/releases` | `{image, version}` | `{ok: true, release: FleetRelease}`; starts a roll (§6), replacing any active one |
| `GET /api/fleet/slots` | | `{slots: SlotView[]}`: `FleetSlot` (with `parked: boolean`; `lease_expires_at` is `null` when parked; `has_proxy`, never the URL) plus `uid`, `pool_status`, `minutes_today`, `budget_minutes`, `worker: WorkerView \| null` |
| `POST /api/fleet/slots/:no/release-quarantine` | | `{slot: SlotView}`; `404` |
| `POST /api/fleet/slots/:no/park` | | `{slot: SlotView}`: epoch + 1 (its worker gets `409 stale_epoch` and exits), no worker, infinite lease, its leased tasks released; `404` |
| `POST /api/fleet/slots/:no/unpark` | | `{slot: SlotView}`: lease cleared so the slot is claimable again; a slot that was not parked is answered unchanged; `404` |
| `GET /api/fleet/workers` | | `{workers: WorkerView[]}`: `FleetWorker & {task: (FleetTask & {city_name}) \| null}` (the leased task) |
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
| `search` | from `master.toml` | `date_listed`, `delivery_method`, `max_results`, page pauses |
| `release` | none | the current or last `FleetRelease` (`{image, version, state: rolling\|done\|failed, started_at, finished_at, upgraded[], skipped[], current, failure}`); written by `POST /releases` and the roll, not by `PUT /settings` and not in its answer |

## 9. Shared types (`packages/shared/src/fleet.ts`)

`FleetCity`, `FleetItem`, `FleetTask`, `FleetTaskEvent`, `FleetSlot`,
`FleetHost`, `FleetWorker`, `FleetSettings`, `ClaimAnswer`, `NextTaskAnswer`,
`DesiredAnswer`, plus `FLEET_TASK_STATES`, `FLEET_PARKED_STATES`. WS-A writes
the first version; others add fields in their own PRs.

## 10. Worker container contract (image ↔ agent)

- Image: `ghcr.io/jinhuw/aimm-recycle:<ver>`, entrypoint `rs_worker/entry.py`.
- Fleet mode on when `RS_FLEET_URL`, `RS_FLEET_HOST_ID`, `RS_FLEET_HOST_TOKEN`
  are set; otherwise the image behaves exactly as today (bind-mounted config).
- Exit codes: `0` normal stop, `75` stale epoch or no slot (agent restarts
  after 60 s), `70` config/claim failure (agent backs off 10 min); anything
  else is the monitor's own code and counts as a crash (§6).
- Ports: VNC listens on 5900 inside; the agent publishes
  `127.0.0.1:<port>:5900` with `<port>` from `desired.vnc_ports` (fallback
  `5900 + n`) and passes that host port as `RS_VNC_PORT`, which the worker
  reports in heartbeats.
- Health: `docker inspect` health = `curl -sf localhost:8788/healthz`
  (entrypoint serves it once the monitor is up).
