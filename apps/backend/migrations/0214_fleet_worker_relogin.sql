-- 0214: a manager's re-login for an ERP-fleet worker, as a one-shot heartbeat
-- directive.
--
-- The worker (facebook-tracker 0.14.4 and later) arms one forced login when
-- `relogin` first appears in a heartbeat answer and ignores it while it keeps
-- appearing, so the directive has to go out once and then stop. The request
-- waits here until a heartbeat delivers it (relogin_delivered_at), and the row
-- keeps it afterwards so the watch page can say when the worker took it. A
-- fresh claim clears it: a new boot signs in on its own.

ALTER TABLE fleet_workers
  ADD COLUMN relogin_id           TEXT,
  ADD COLUMN relogin_requested_at TIMESTAMPTZ,
  ADD COLUMN relogin_requested_by TEXT,
  ADD COLUMN relogin_delivered_at TIMESTAMPTZ;
