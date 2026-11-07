-- A pool owner change fences the slot and frees what its worker held (0207).
-- Seller tasks keep their account. A post, a delete or a send whose lease is
-- lost this way may already be out, so it becomes 'uncertain' and is never run
-- again; an inbox sync is only a read, and the next one is queued anyway, so
-- it is cancelled. Search kinds go back to the queue as before.
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
    SELECT id, worker_id, 'released',
      CASE WHEN kind IN ('ad-post','ad-delete','msg-send') THEN '{"reason":"pool_owner_changed","state":"uncertain"}'::jsonb
           WHEN kind = 'inbox-sync' THEN '{"reason":"pool_owner_changed","state":"cancelled"}'::jsonb
           ELSE '{"reason":"pool_owner_changed"}'::jsonb END
    FROM fleet_tasks WHERE account_no = fenced_no AND state = 'leased';
  UPDATE fleet_tasks SET state = 'uncertain', done_at = NOW()
  WHERE account_no = fenced_no AND state = 'leased' AND kind IN ('ad-post','ad-delete','msg-send');
  UPDATE fleet_tasks SET state = 'cancelled', done_at = NOW()
  WHERE account_no = fenced_no AND state = 'leased' AND kind = 'inbox-sync';
  UPDATE fleet_tasks SET state = 'ready', due_at = NOW(), worker_id = NULL,
    epoch = NULL, leased_at = NULL, lease_expires_at = NULL, started_at = NULL,
    account_no = CASE WHEN kind = 'probe' THEN account_no ELSE NULL END
  WHERE account_no = fenced_no AND state = 'leased';
  PERFORM pg_notify('fleet_tasks', '');
  RETURN NULL;
END $$ LANGUAGE plpgsql;
