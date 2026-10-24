-- The ERP fleet: a city task queue the Facebook Marketplace workers pull from,
-- in place of the daily sweep each worker ran from its own compose file.
-- Managers keep the city catalog here; the scheduler keeps one open task per
-- enabled city and item; a worker claims a slot (a pool account plus its proxy
-- and device) at boot and long-polls for the next due task. Nothing in this
-- migration moves data: the live fleet keeps running off the coordinator's own
-- queue until the cutover.
--
-- Slot secrets stay in fb_pool_accounts (sealed under FB_POOL_KEY); a slot
-- only adds the fleet's view of the account: who runs it, on which host, with
-- which lease epoch. The epoch is what keeps one account off two hosts: every
-- worker call carries it, and a stale one is refused.

CREATE TABLE fleet_cities (
  slug         TEXT PRIMARY KEY,                 -- Facebook location slug or numeric id
  name         TEXT NOT NULL,
  radius_km    INTEGER NOT NULL DEFAULT 500,
  region       TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT FALSE,   -- true once verified or overridden
  per_day      INTEGER,                          -- NULL = follow tiers; default rule 1
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

CREATE TABLE fleet_settings (
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

-- The FK indexes the rest of the schema keeps (0035): a parent delete or a
-- per-host, per-city read otherwise scans the child table. fleet_tasks_open_idx
-- leads with city, so the city FK is covered; item gets its own.
CREATE INDEX fleet_cities_added_by_idx    ON fleet_cities(added_by);
CREATE INDEX fleet_settings_updated_by_idx ON fleet_settings(updated_by);
CREATE INDEX fleet_slots_host_id_idx      ON fleet_slots(host_id);
CREATE INDEX fleet_workers_host_id_idx    ON fleet_workers(host_id);
CREATE INDEX fleet_workers_account_no_idx ON fleet_workers(account_no);
CREATE INDEX fleet_tasks_item_idx         ON fleet_tasks(item);
