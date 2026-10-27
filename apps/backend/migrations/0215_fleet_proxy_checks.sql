-- 0215: proxy health. Every five minutes the backend dials through each proxy
-- on the ERP's list, and asks rs_console to do the same for the ports the
-- homelab workers dial; each answer is one row here, kept 14 days.
--
-- exit is `scheme://host:port` with the login cut out, the name
-- fb_worker_accounts uses, so a row joins the proxy's failed accounts.
-- proxy_id is the ERP list's row (NULL for a coordinator port, or once the
-- proxy is removed); workers are the homelab workers on a coordinator port at
-- the time of the check.

CREATE TABLE fleet_proxy_checks (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exit        TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('erp', 'coordinator')),
  proxy_id    INTEGER REFERENCES fleet_proxies(id) ON DELETE SET NULL,
  workers     TEXT[] NOT NULL DEFAULT '{}',
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ok          BOOLEAN NOT NULL,
  latency_ms  INTEGER,
  exit_ip     TEXT,
  city        TEXT,
  region      TEXT,
  country     TEXT,
  org         TEXT,
  error       TEXT
);
CREATE INDEX fleet_proxy_checks_exit_idx ON fleet_proxy_checks (source, exit, checked_at DESC);
CREATE INDEX fleet_proxy_checks_at_idx ON fleet_proxy_checks (checked_at);
CREATE INDEX fleet_proxy_checks_proxy_id_idx ON fleet_proxy_checks (proxy_id);

-- One row: when the last full round started. A round is claimed by moving it
-- forward, so two backend instances never run the same one. Its checks are
-- stamped with started_at; coordinator_at is the last round the console
-- answered, whose rows are the homelab ports in use, and coordinator what it
-- said last time (ok, not_configured, unsupported, unreachable).
CREATE TABLE fleet_proxy_rounds (
  id              BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  coordinator     TEXT,
  coordinator_at  TIMESTAMPTZ
);
INSERT INTO fleet_proxy_rounds DEFAULT VALUES;
