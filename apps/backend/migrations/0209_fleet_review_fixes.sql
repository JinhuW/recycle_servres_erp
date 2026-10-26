-- The scheduler reads the last finished search per city and item on every
-- tick (insert, retime), and the Cities tab groups by the same pair; done
-- tasks only ever accumulate, so without this both scan the whole history.
CREATE INDEX fleet_tasks_done_pair_idx ON fleet_tasks(city, item, done_at DESC)
  WHERE state = 'done' AND kind = 'search';

-- The agent process that holds each host (X-Fleet-Agent-Instance): a second
-- instance for the same host is refused while this one keeps calling.
ALTER TABLE fleet_hosts ADD COLUMN agent_instance TEXT;
ALTER TABLE fleet_hosts ADD COLUMN agent_daemon TEXT;
ALTER TABLE fleet_hosts ADD COLUMN agent_seen_at TIMESTAMPTZ;
