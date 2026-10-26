-- A handoff reservation (POST /hosts/:id/stopped with restart) used to be an
-- infinite lease, the same value a manager's park writes: it never lapsed when
-- the replacement failed to claim, and the Slots tab showed it as parked. It
-- now carries its own deadline; the lease ends with it, so a replacement that
-- never arrives frees the account without anyone's help.
ALTER TABLE fleet_slots ADD COLUMN reserved_until TIMESTAMPTZ;

UPDATE fleet_slots
SET reserved_until = NOW() + interval '20 minutes', lease_expires_at = NOW() + interval '20 minutes'
WHERE lease_expires_at = 'infinity'::timestamptz AND worker_id IS NOT NULL AND handoff_epoch IS NOT NULL;

-- The pick's "familiar" test (this account finished this city lately) used to
-- scan every finished task for each ready one.
CREATE INDEX fleet_tasks_done_account_idx ON fleet_tasks(account_no, city, done_at) WHERE state = 'done';
