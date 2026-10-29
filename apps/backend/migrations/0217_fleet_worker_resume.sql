-- 0217: a manager's "Mark healthy" for an ERP-fleet worker parked with
-- `connect_failed`, as a one-shot heartbeat directive, the twin of 0214's
-- re-login.
--
-- The worker (facebook-tracker 0.15.0 and later) leaves the park when `resume`
-- first appears in a heartbeat answer, in the same browser and with no login.
-- The request waits here until a heartbeat delivers it (resume_delivered_at).
-- A fresh claim clears it: a new boot is not parked.

ALTER TABLE fleet_workers
  ADD COLUMN resume_id           TEXT,
  ADD COLUMN resume_requested_at TIMESTAMPTZ,
  ADD COLUMN resume_requested_by TEXT,
  ADD COLUMN resume_delivered_at TIMESTAMPTZ;
