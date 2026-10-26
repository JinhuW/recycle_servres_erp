-- The hourly purge looks for the oldest finished tasks; without this it walks
-- every terminal row to learn that none is old enough yet.
CREATE INDEX fleet_tasks_purge_idx ON fleet_tasks ((COALESCE(done_at, leased_at, due_at)), id)
  WHERE state IN ('done', 'cancelled', 'expired');
