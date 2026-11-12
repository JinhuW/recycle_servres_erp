-- The Facebook seller feature (0232-0234) is retired: fleet accounts only
-- search, and Marketplace chats go through the chat bridge (fb_chat_*, 0235).
-- Prod's seller tables held only their seed rows, archived to R2 at
-- recycle-db-backup/archive/fb-seller-archive-prod-20261112.sql.gz.

-- ─── Fleet back to search only ──────────────────────────────────────────────
DELETE FROM fleet_tasks WHERE kind IN ('ad-post','ad-delete','inbox-sync','msg-send');

DROP INDEX fleet_tasks_seller_open_idx;
ALTER TABLE fleet_tasks DROP CONSTRAINT fleet_tasks_seller_shape;
ALTER TABLE fleet_tasks DROP COLUMN payload;
ALTER TABLE fleet_tasks ALTER COLUMN city SET NOT NULL, ALTER COLUMN item SET NOT NULL;
ALTER TABLE fleet_tasks DROP CONSTRAINT fleet_tasks_state_check;
ALTER TABLE fleet_tasks ADD CONSTRAINT fleet_tasks_state_check
  CHECK (state IN ('ready','leased','done','cancelled','expired'));

ALTER TABLE fleet_slots DROP COLUMN agent_profile_id, DROP COLUMN agent_on, DROP COLUMN role;

-- 0207's trigger, before 0233 gave seller writes their own branches.
CREATE OR REPLACE FUNCTION fleet_fence_pool_owner() RETURNS trigger AS $$
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

-- 0218's view, before 0234 left seller kinds out.
CREATE OR REPLACE VIEW fleet_minutes AS
WITH attempts AS (
  SELECT account_no, leased_at, ended_at FROM fleet_task_attempts
  UNION ALL
  SELECT account_no, leased_at, LEAST(NOW(), lease_expires_at) AS ended_at
  FROM fleet_tasks WHERE state = 'leased' AND leased_at IS NOT NULL
), days AS (
  SELECT a.*, d AS day_start FROM attempts a
  CROSS JOIN LATERAL generate_series(
    date_trunc('day', leased_at AT TIME ZONE 'America/New_York'),
    date_trunc('day', ended_at AT TIME ZONE 'America/New_York'), interval '1 day') d
)
SELECT account_no, day_start::date AS day,
       SUM(GREATEST(0, EXTRACT(EPOCH FROM (
         LEAST(ended_at, (day_start + interval '1 day') AT TIME ZONE 'America/New_York')
         - GREATEST(leased_at, day_start AT TIME ZONE 'America/New_York'))))) / 60 AS minutes
FROM days GROUP BY account_no, day_start::date;

-- ─── Seller tables ──────────────────────────────────────────────────────────
DROP TABLE fb_agent_runs, fb_agent_eval_runs, fb_agent_eval_cases,
  fb_thread_events, fb_messages, fb_threads,
  fb_photos, fb_ad_placements, fb_ads, fb_photo_pools,
  fb_seller_settings_history, fb_seller_settings, fb_agent_profiles;
DROP FUNCTION fb_seller_settings_history_lock();
DROP FUNCTION fb_thread_events_lock();
