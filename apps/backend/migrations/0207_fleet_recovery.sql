-- Keep each ended lease even when its task is returned to ready, and charge
-- midnight-spanning work to the day it actually ran.
CREATE TABLE fleet_task_attempts (
  id BIGSERIAL PRIMARY KEY,
  task_id BIGINT REFERENCES fleet_tasks(id) ON DELETE SET NULL,
  account_no INTEGER,
  epoch INTEGER,
  leased_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  UNIQUE NULLS NOT DISTINCT (task_id, account_no, epoch, leased_at)
);
CREATE INDEX fleet_task_attempts_account_idx ON fleet_task_attempts(account_no, leased_at);

INSERT INTO fleet_task_attempts (task_id, account_no, epoch, leased_at, ended_at)
SELECT id, account_no, epoch, leased_at,
       GREATEST(leased_at, CASE WHEN state = 'done' THEN COALESCE(done_at, NOW()) ELSE LEAST(COALESCE(done_at, NOW()), lease_expires_at) END)
FROM fleet_tasks WHERE leased_at IS NOT NULL AND state <> 'leased';

CREATE FUNCTION fleet_archive_attempt() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.leased_at IS NOT NULL AND OLD.state = 'leased'
     AND (NEW.state <> 'leased' OR NEW.leased_at IS DISTINCT FROM OLD.leased_at
          OR NEW.epoch IS DISTINCT FROM OLD.epoch) THEN
    INSERT INTO fleet_task_attempts (task_id, account_no, epoch, leased_at, ended_at)
    VALUES (OLD.id, OLD.account_no, OLD.epoch, OLD.leased_at,
            GREATEST(OLD.leased_at, CASE WHEN NEW.state = 'done' THEN COALESCE(NEW.done_at, NOW()) ELSE LEAST(COALESCE(NEW.done_at, NOW()), OLD.lease_expires_at) END))
    ON CONFLICT DO NOTHING;
  ELSIF TG_OP = 'INSERT' AND NEW.leased_at IS NOT NULL AND NEW.state <> 'leased' THEN
    INSERT INTO fleet_task_attempts (task_id, account_no, epoch, leased_at, ended_at)
    VALUES (NEW.id, NEW.account_no, NEW.epoch, NEW.leased_at,
            GREATEST(NEW.leased_at, CASE WHEN NEW.state = 'done' THEN COALESCE(NEW.done_at, NOW()) ELSE LEAST(COALESCE(NEW.done_at, NOW()), NEW.lease_expires_at) END))
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER fleet_archive_attempt AFTER INSERT OR UPDATE ON fleet_tasks
  FOR EACH ROW EXECUTE FUNCTION fleet_archive_attempt();

CREATE OR REPLACE VIEW fleet_minutes AS
WITH attempts AS (
  SELECT account_no, leased_at, ended_at FROM fleet_task_attempts
  UNION ALL
  SELECT account_no, leased_at, LEAST(NOW(), lease_expires_at) AS ended_at
  FROM fleet_tasks WHERE state = 'leased' AND leased_at IS NOT NULL
), days AS (
  SELECT a.*, d AS day_start FROM attempts a
  CROSS JOIN LATERAL generate_series(
    date_trunc('day', leased_at AT TIME ZONE 'UTC'),
    date_trunc('day', ended_at AT TIME ZONE 'UTC'), interval '1 day') d
)
SELECT account_no, day_start::date AS day,
       SUM(GREATEST(0, EXTRACT(EPOCH FROM (
         LEAST(ended_at, (day_start + interval '1 day') AT TIME ZONE 'UTC')
         - GREATEST(leased_at, day_start AT TIME ZONE 'UTC'))))) / 60 AS minutes
FROM days GROUP BY account_no, day_start::date;

ALTER TABLE fleet_slots ADD COLUMN claim_id TEXT;
ALTER TABLE fleet_slots ADD COLUMN handoff_epoch INTEGER;
ALTER TABLE fleet_slots ADD COLUMN quarantine_reset_at TIMESTAMPTZ;
ALTER TABLE fleet_slots ADD COLUMN quarantine_evidence JSONB;
CREATE UNIQUE INDEX fleet_slots_claim_idx ON fleet_slots(host_id, claim_id) WHERE claim_id IS NOT NULL;

-- All pool lifecycle paths go through this trigger, including direct manager
-- edits and background liveness updates. Internal claims set the holder before
-- installing their new slot epoch. Lock order is pool account, slot, then tasks.
CREATE FUNCTION fleet_fence_pool_owner() RETURNS trigger AS $$
DECLARE
  fenced_no INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    fenced_no := OLD.no;
  ELSIF OLD.status = 'fleet' AND (NEW.status <> 'fleet'
     OR lower(NEW.holder_name) IS DISTINCT FROM lower(OLD.holder_name)
     OR NEW.uid IS DISTINCT FROM OLD.uid) THEN
    fenced_no := NEW.no;
  ELSE
    RETURN NULL;
  END IF;
  UPDATE fleet_slots SET epoch = epoch + 1, worker_id = NULL, host_id = NULL,
    lease_expires_at = NULL, claim_id = NULL, handoff_epoch = NULL
  WHERE account_no = fenced_no;
  INSERT INTO fleet_task_events (task_id, worker_id, kind, detail)
    SELECT id, worker_id, 'released', '{"reason":"pool_owner_changed"}'::jsonb
    FROM fleet_tasks WHERE account_no = fenced_no AND state = 'leased';
  UPDATE fleet_tasks SET state = 'ready', due_at = NOW(), worker_id = NULL,
    epoch = NULL, leased_at = NULL, lease_expires_at = NULL, started_at = NULL,
    account_no = CASE WHEN kind = 'probe' THEN account_no ELSE NULL END
  WHERE account_no = fenced_no AND state = 'leased';
  PERFORM pg_notify('fleet_tasks', '');
  RETURN NULL;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER fleet_fence_pool_owner AFTER UPDATE OF status, holder_name, uid OR DELETE ON fb_pool_accounts
  FOR EACH ROW EXECUTE FUNCTION fleet_fence_pool_owner();

-- Probes belong to an account, so two accounts may probe the same home city.
DROP INDEX fleet_tasks_open_idx;
CREATE UNIQUE INDEX fleet_tasks_open_idx ON fleet_tasks(city, item, kind)
  WHERE state IN ('ready','leased') AND kind <> 'probe';
CREATE UNIQUE INDEX fleet_tasks_probe_idx ON fleet_tasks(account_no)
  WHERE state IN ('ready','leased') AND kind = 'probe';
