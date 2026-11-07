-- A seller's posting and inbox work is not search: leave it out of the minutes,
-- as minutesTodaySql (src/fleet/sql.ts) leaves it out of the budget. Same
-- shape as 0218's view; only the two filters are new. An attempt whose task was
-- purged no longer names its kind, and the purge deletes those attempts with it.
CREATE OR REPLACE VIEW fleet_minutes AS
WITH attempts AS (
  SELECT a.account_no, a.leased_at, a.ended_at FROM fleet_task_attempts a
  WHERE NOT EXISTS (
    SELECT 1 FROM fleet_tasks st
    WHERE st.id = a.task_id AND st.kind IN ('ad-post','ad-delete','inbox-sync','msg-send'))
  UNION ALL
  SELECT account_no, leased_at, LEAST(NOW(), lease_expires_at) AS ended_at
  FROM fleet_tasks WHERE state = 'leased' AND leased_at IS NOT NULL
    AND kind NOT IN ('ad-post','ad-delete','inbox-sync','msg-send')
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
