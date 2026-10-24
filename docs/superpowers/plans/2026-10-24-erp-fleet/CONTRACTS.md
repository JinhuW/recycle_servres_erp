# Contracts (RS-394)

Everything two workstreams both depend on. Change it only in a PR that also
changes the code and names the affected workstreams.

## 1. Names

| Thing | Value |
| --- | --- |
| Backend module | `apps/backend/src/fleet/` (`scheduler.ts`, `claim.ts`, `tasks.ts`, `hosts.ts`, `auth.ts`, `sql.ts`) |
| Routes | `apps/backend/src/routes/fleet.ts`, mounted at `/api/fleet` |
| Shared types | `packages/shared/src/fleet.ts` |
| Frontend | `apps/frontend/src/pages/desktop/fleet/*`, `apps/frontend/src/lib/fleet.ts` |
| Host agent | `apps/fleet-agent/` → image `ghcr.io/jinhuw/fleet-agent:<root version>` |
| Worker image | `trackers/facebook/deploy/Dockerfile.worker` → `ghcr.io/jinhuw/aimm-recycle:<facebook-tracker version>` |
| Worker entrypoint | `trackers/facebook/rs_worker/entry.py` |
| Migration | `apps/backend/migrations/0205_fleet.sql` (renumber if taken at merge time) |

## 2. Environment

Backend (Railway `backend`, and `.env` locally):

| Var | Meaning |
| --- | --- |
| `FB_POOL_KEY` | exists; seals pool secrets |
| `FLEET_WORKER_TOKEN_KEY` | HMAC key for worker tokens (hex, 32 bytes) |
| `FLEET_IMAGE_WORKER` | default worker image ref, e.g. `ghcr.io/jinhuw/aimm-recycle:0.14.0` |
| `FLEET_IMAGE_AGENT` | default agent image ref |
| `FLEET_COORDINATOR_URL` | the Python coordinator workers post listings to (`https://…`), handed to workers at claim |
| `FLEET_ROLE` | unset = full; `worker-api` = only `/api/fleet/worker/*` + scheduler (future split) |

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
| `RS_VNC_PORT` | the port the agent mapped; the worker reports it in heartbeats |

## 3. Auth scopes

| Scope | How | Used by |
| --- | --- | --- |
| manager | existing ERP session cookie + manager role | frontend, `/api/fleet/*` except worker/host routes |
| host | `Authorization: Bearer <host token>`; `sha256(token)` = `fleet_hosts.token_hash` | `/api/fleet/hosts/:id/*`, `POST /api/fleet/worker/claim` |
| worker | `Authorization: Bearer <worker token>`: `base64url(json{worker_id, account_no, epoch, exp}) . hmac` with `FLEET_WORKER_TOKEN_KEY`; `exp` = claim + 7 days | `/api/fleet/worker/*` except `claim` |

A worker token whose `epoch` ≠ `fleet_slots.epoch` for its `account_no` →
`409 {error: "stale_epoch"}` on every worker route.

## 4. Schema (`0205_fleet.sql`)

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

`LISTEN/NOTIFY` channel: `fleet_tasks` (payload: `item`), sent by the
scheduler after every write that can make a task ready.

## 5. Worker API (`/api/fleet/worker/*`)

All answers are JSON. Errors: `{error: <code>, detail?}`. Codes: `stale_epoch`
(409), `no_slot` (409), `not_found` (404), `bad_request` (422), `unauthorized`
(401).

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

Picks the slot with `lease_expires_at IS NULL OR < now()`, status `fleet`, not
quarantined (probe tasks still go to quarantined slots, so they are claimable),
preferring `last_host_id = host_id`, then slots whose home cities nobody
covers. Sets `epoch = epoch + 1`, `worker_id`, `host_id`,
`lease_expires_at = now() + lease_minutes`; opens an `fb_worker_accounts`
stint. `409 no_slot` when none is free.

### `POST /api/fleet/worker/heartbeat` — worker scope

```jsonc
{ "state": "HEALTHY", "version": "0.14.0", "vnc_port": 5903, "last_search_at": "…", "detail": { … } }
// 200 { "ok": true, "directives": ["relogin"?] }
```

Renews the slot lease. `HEALTHY` also renews the current task lease. A
**parked** state (`SESSION_EXPIRED`, `CHECKPOINT`, `CHALLENGE_*`, `DEAD`)
releases the current task (event `released`, state back to `ready`,
`due_at = now()`). `DEGRADED` changes nothing.

### `POST /api/fleet/worker/next-task` — worker scope

```jsonc
// request
{ "done": { "task_id": 123, "result": { "cards": 115, "opened": 9, "reviewed": 9, "alerted": 1, "seconds": 412 } } | null,
  "wait": 50 }
// 200, a task
{ "task": { "id": 124, "kind": "search", "city": { "slug": "houston", "name": "Houston", "radius_km": 500 },
            "item": "server_ram", "lease_expires_at": "…", "why": "home" | "familiar" | "other" | "manual" | "probe" } }
// 200, nothing yet (after holding up to `wait` seconds)
{ "task": null, "retry_after": 30, "reason": "nothing_due" | "budget" | "quarantined" }
```

In one transaction: close `done` (state `done`, `result`, event `done`),
then `SELECT … FROM fleet_tasks WHERE state='ready' AND due_at <= now() … FOR UPDATE SKIP LOCKED`
ordered by `priority DESC`, then home → familiar (this account searched it in
the last 7 days) → other, then `due_at`. Skipped while the account's
`fleet_minutes` today ≥ `budget_minutes`, or it is quarantined (then only
`probe` tasks). Leases: `state='leased'`, `worker_id`, `account_no`, `epoch`,
`lease_expires_at = now() + lease_minutes`; event `handed`. With no task,
hold on `LISTEN fleet_tasks` up to `min(wait, poll_hold_seconds)`, retry the
pick once, else answer `null`.

### `POST /api/fleet/worker/events` — worker scope

```jsonc
{ "task_id": 124, "kind": "started" | "searched" | "finished" | "stopped", "detail": { … } }
```

### `PUT /api/fleet/worker/session` — worker scope

```jsonc
{ "cookies": [ … ], "token": "EAA…" | null }   // resealed into fb_pool_accounts.cookie_enc / token_enc, cookie_at = now()
```

### `GET /api/fleet/worker/vnc` — worker scope, WebSocket

Outbound VNC relay: the worker's `websockify` dials this; the ERP's existing
noVNC bridge (`src/vncBridge.ts`) serves it to managers per `worker_id`.

## 6. Host API (`/api/fleet/hosts/:id/*`) — host scope

```jsonc
// GET /api/fleet/hosts/:id/desired
{ "authoritative": true, "count": 4, "image": "ghcr.io/jinhuw/aimm-recycle:0.14.0", "version": "0.14.0",
  "vnc_ports": { "homelab-1": 5901, "homelab-2": 5902 }, "roll": { "replace": "homelab-2" } | null }
// POST /api/fleet/hosts/:id/report
{ "version": "1.340.0", "containers": [ { "worker_id": "homelab-1", "image": "…", "state": "running", "started_at": "…" } ] }
```

`roll.replace` names at most one worker the agent should stop and recreate on
`image`; the ERP sets it only when that worker is idle (no leased task) and
the previous replacement reported healthy.

## 7. Manager API — manager scope

| Route | Body / answer |
| --- | --- |
| `GET /api/fleet/cities` | `{cities: FleetCity[]}` with each city's open task per item |
| `POST /api/fleet/cities` | `{slug, name, radius_km?, region?}` → city with `enabled=false` and a `verify-slug` task; `409` if exists |
| `PUT /api/fleet/cities/:slug` | `{enabled?, per_day?, pinned?, name?, override_verify?: true}` |
| `DELETE /api/fleet/cities/:slug` | disables, cancels open tasks |
| `GET/PUT /api/fleet/items` | `FleetItem[]` |
| `GET/PUT /api/fleet/settings` | §8 keys |
| `POST /api/fleet/tasks` | `{city, item}` → manual task `priority 100`, `reason manual` |
| `POST /api/fleet/round/start` | every ready task whose city-item was not done in `start_fresh_hours` → `due_at = now()`; answers counts |
| `GET /api/fleet/tasks?state=&city=&item=&worker=&since=` | `FleetTask[]` |
| `GET /api/fleet/city-log?city=\|worker=&hours=` | tasks with their events |
| `GET /api/fleet/hosts` · `POST /api/fleet/hosts` `{host_id}` → token shown once · `PUT /api/fleet/hosts/:id` `{capacity?, authoritative?}` · `DELETE` | |
| `POST /api/fleet/releases` | `{image, version}` → starts a roll |
| `GET /api/fleet/slots` | slot + worker + pool status per account |
| `POST /api/fleet/slots/:no/release-quarantine` · `POST /api/fleet/slots/:no/park` | |
| `GET /api/fleet/workers` | `FleetWorker[]` with current task |

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
  after 60 s), `70` config/claim failure (agent backs off 10 min).
- Ports: `RS_VNC_PORT` inside = 5900; the agent maps host port from
  `desired.vnc_ports`.
- Health: `docker inspect` health = `curl -sf localhost:8788/healthz`
  (entrypoint serves it once the monitor is up).
