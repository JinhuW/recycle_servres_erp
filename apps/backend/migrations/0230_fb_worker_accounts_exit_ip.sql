-- 0230: the IP each stint went out through. A port is not an identity: the
-- provider moves it, and Facebook judges the IP.
--
-- Backfilled from the checks still kept (14 days). A closed stint takes the last
-- good reading at or before its start, else the first during it; an open one takes
-- the newest, since that is where it is now. Anything older stays NULL, and is shown
-- as not recorded rather than guessed.

ALTER TABLE fb_worker_accounts ADD COLUMN exit_ip text;

COMMENT ON COLUMN fb_worker_accounts.exit_ip IS
  'The measured IP behind proxy_url. An open stint follows the port; a closed one keeps the IP it ended on. NULL when no check covers it.';

UPDATE fb_worker_accounts w SET exit_ip = COALESCE(
  CASE WHEN w.ended_at IS NULL THEN (
    SELECT c.exit_ip FROM fleet_proxy_checks c
    WHERE c.source IN ('erp', 'coordinator') AND c.exit = w.proxy_url AND c.ok AND c.exit_ip IS NOT NULL
    ORDER BY c.checked_at DESC, c.id DESC LIMIT 1) END,
  (SELECT c.exit_ip FROM fleet_proxy_checks c
   WHERE c.source IN ('erp', 'coordinator') AND c.exit = w.proxy_url AND c.ok AND c.exit_ip IS NOT NULL
     AND c.checked_at <= w.started_at
   ORDER BY c.checked_at DESC, c.id DESC LIMIT 1),
  (SELECT c.exit_ip FROM fleet_proxy_checks c
   WHERE c.source IN ('erp', 'coordinator') AND c.exit = w.proxy_url AND c.ok AND c.exit_ip IS NOT NULL
     AND c.checked_at > w.started_at AND (w.ended_at IS NULL OR c.checked_at <= w.ended_at)
   ORDER BY c.checked_at, c.id LIMIT 1))
WHERE w.proxy_url IS NOT NULL;
