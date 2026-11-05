-- The latest check of a listed proxy is read every round and on every Proxies tab
-- poll. Without this each read sorts the table's 14 days of history for one row per port.
CREATE INDEX fleet_proxy_checks_proxy_recent_idx ON fleet_proxy_checks (proxy_id, checked_at DESC, id DESC)
  WHERE source = 'erp';
