-- A worker parked on a page that would not load (DEAD connect_failed) is
-- usually fine again minutes later, so the ERP sends it `resume` by itself on
-- a back-off. state_since dates the park; auto_resumes counts the tries.
ALTER TABLE fleet_workers
  ADD COLUMN state_since TIMESTAMPTZ,
  ADD COLUMN auto_resumes INTEGER NOT NULL DEFAULT 0;

UPDATE fleet_workers SET state_since = last_heartbeat_at WHERE state IS NOT NULL;
