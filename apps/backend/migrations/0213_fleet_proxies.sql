-- 0213: the proxies the ERP fleet browses through, kept as a list a manager
-- edits, so a slot can be made from the page instead of the seed script.
--
-- url_enc is the whole `scheme://user:pass@host:port`, sealed with FB_POOL_KEY
-- like fleet_slots.proxy_url; host and port are kept in clear for the list
-- and so one exit cannot be entered twice. A slot copies the sealed URL when
-- it is made (the claim reads only fleet_slots.proxy_url) and names its proxy
-- in proxy_id, which is how a proxy's edit reaches its slots and how the list
-- counts who uses it. Removing a proxy leaves a parked slot its copy.

CREATE TABLE fleet_proxies (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label      TEXT NOT NULL,
  url_enc    TEXT NOT NULL,
  host       TEXT NOT NULL,
  port       INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  timezone   TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX fleet_proxies_exit_idx ON fleet_proxies (lower(host), port);
CREATE INDEX fleet_proxies_created_by_idx ON fleet_proxies (created_by);

ALTER TABLE fleet_slots ADD COLUMN proxy_id INTEGER REFERENCES fleet_proxies(id) ON DELETE SET NULL;
CREATE INDEX fleet_slots_proxy_id_idx ON fleet_slots (proxy_id);
