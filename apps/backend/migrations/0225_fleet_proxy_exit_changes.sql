-- 0225: a port doesn't keep its exit, so each one's measured exit is tracked.
-- On 2026-11-04 14 of 20 ports moved within four minutes, and one changed geo
-- with its IP unchanged.
--
-- timezone is the lookup's own zone for the exit. It stays NULL on older rows
-- and on homelab ports, whose console reports no zone.

ALTER TABLE fleet_proxy_checks ADD COLUMN timezone TEXT;

-- One row per exit change, kept for good: checks last 14 days, and a loss has
-- to be traceable to a move long after that. slots and workers are who was on
-- the port then, as plain values because a slot is deleted with its account's
-- removal and the record must outlive it. notified_at is NULL until an alert
-- covers the row, and stays NULL on a port nobody was using.
CREATE TABLE fleet_proxy_exit_changes (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exit         TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('erp', 'coordinator')),
  proxy_id     INTEGER REFERENCES fleet_proxies(id) ON DELETE SET NULL,
  changed_at   TIMESTAMPTZ NOT NULL,
  previous_at  TIMESTAMPTZ NOT NULL,
  old_ip       TEXT NOT NULL,
  old_city     TEXT,
  old_region   TEXT,
  old_country  TEXT,
  old_timezone TEXT,
  new_ip       TEXT NOT NULL,
  new_city     TEXT,
  new_region   TEXT,
  new_country  TEXT,
  new_timezone TEXT,
  slots        INTEGER[] NOT NULL DEFAULT '{}',
  workers      TEXT[] NOT NULL DEFAULT '{}',
  notified_at  TIMESTAMPTZ
);
CREATE INDEX fleet_proxy_exit_changes_proxy_id_idx ON fleet_proxy_exit_changes (proxy_id);
CREATE INDEX fleet_proxy_exit_changes_at_idx ON fleet_proxy_exit_changes (changed_at);
