-- A search-budget day is an Eastern day (FLEET_TZ), as the Analysis funnel
-- counts days, so the budget no longer refills at 8 PM Eastern. Same shape
-- as 0207's view; only the zone changes.
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
